/*
 * Onshape in-session request helper.
 *
 * This is the only runtime HTTP primitive that calls fetch(). All typed and
 * generic Onshape operations route through it. Authentication remains the
 * logged-in browser session plus the captured anti-forgery contract.
 *
 * v44 adds transport fidelity for the complete current official OpenAPI:
 * JSON, multipart/form-data, safe documented headers, and byte-safe binary
 * responses. Binary payloads use opaque artifacts stored only in tmpfs.
 */

"use strict"

const fs = require("node:fs")
const pathModule = require("node:path")
const crypto = require("node:crypto")

const SCHEME = "https"
const DEFAULT_HOST = "cad.onshape.com"
const ARTIFACT_DIR = "/tmp/onshape-artifacts"
const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/
const ARTIFACT_TTL_MS = 2 * 60 * 60 * 1000
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const CHUNK_BYTES = 384 * 1024
const READ_BINDING = "__cfOnshapeArtifactReadV1"
const CREATE_BINDING = "__cfOnshapeArtifactCreateV1"
const APPEND_BINDING = "__cfOnshapeArtifactAppendV1"
const pageBindingStates = new WeakMap()

function codedError(code, message) {
	const error = new Error(message)
	error.code = code
	return error
}

class GlassworksApiScheduler {
	constructor({ minimumIntervalMs = 1000, clock = () => Date.now(), delay = null } = {}) {
		const interval = Number(minimumIntervalMs)
		if (!Number.isInteger(interval) || interval < 0 || interval > 60_000) {
			throw codedError("API_INTERVAL_INVALID", "Glassworks API minimum interval must be an integer from 0 to 60000 ms.")
		}
		this.minimumIntervalMs = interval
		this.clock = clock
		this.delay = typeof delay === "function"
			? delay
			: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
		this.tail = Promise.resolve()
		this.active = 0
		this.queued = 0
		this.maximumObservedConcurrency = 0
		this.dispatchCount = 0
		this.lastDispatchStartedMs = null
		this.lastDispatchFinishedMs = null
		this.lastKind = null
		this.paused = false
	}

	run(task, { kind = "request", allowWhilePaused = false, returnTiming = false } = {}) {
		if (typeof task !== "function") {
			return Promise.reject(codedError("API_SCHEDULER_TASK_INVALID", "Glassworks scheduler requires a callable task."))
		}
		if (this.paused && !allowWhilePaused) {
			return Promise.reject(codedError("API_SCHEDULER_PAUSED", "Glassworks API dispatch is paused for an authentication role transition."))
		}
		const enqueuedAt = this.clock()
		this.queued += 1
		const scheduled = this.tail.then(async () => {
			this.queued = Math.max(0, this.queued - 1)
			const current = this.clock()
			const earliest = this.lastDispatchStartedMs == null
				? current
				: this.lastDispatchStartedMs + this.minimumIntervalMs
			const waitMs = Math.max(0, earliest - current)
			if (waitMs > 0) await this.delay(waitMs)
			this.active += 1
			this.maximumObservedConcurrency = Math.max(this.maximumObservedConcurrency, this.active)
			this.lastDispatchStartedMs = this.clock()
			this.lastKind = String(kind || "request").slice(0, 80)
			this.dispatchCount += 1
			const startedAt = this.lastDispatchStartedMs
			try {
				const value = await task()
				const finishedAt = this.clock()
				return returnTiming
					? {
						value,
						timing: {
							queue_wait_ms: Math.max(0, startedAt - enqueuedAt),
							pacing_wait_ms: waitMs,
							execution_ms: Math.max(0, finishedAt - startedAt),
						},
					}
					: value
			} finally {
				this.active = Math.max(0, this.active - 1)
				this.lastDispatchFinishedMs = this.clock()
			}
		})
		this.tail = scheduled.catch(() => undefined)
		return scheduled
	}

	async pauseAndDrain() {
		this.paused = true
		await this.tail
	}

	resume() {
		this.paused = false
	}

	status() {
		return {
			minimum_interval_ms: this.minimumIntervalMs,
			maximum_concurrency: 1,
			active: this.active,
			queued: this.queued,
			paused: this.paused,
			dispatch_count: this.dispatchCount,
			maximum_observed_concurrency: this.maximumObservedConcurrency,
			last_dispatch_started_at: this.lastDispatchStartedMs == null ? null : new Date(this.lastDispatchStartedMs).toISOString(),
			last_dispatch_finished_at: this.lastDispatchFinishedMs == null ? null : new Date(this.lastDispatchFinishedMs).toISOString(),
			last_kind: this.lastKind,
		}
	}
}

function originFor(host) {
	return SCHEME + "://" + host
}

function safeFilename(value, fallback = "onshape-artifact.bin") {
	const name = String(value || "").trim()
	if (!name || name.length > 255 || /[\r\n\0/\\]/.test(name)) return fallback
	return name
}

function safeContentType(value) {
	const text = String(value || "application/octet-stream").trim()
	return !text || text.length > 200 || /[\r\n\0]/.test(text) ? "application/octet-stream" : text
}

function decodeBase64Strict(value) {
	const text = String(value || "").replace(/\s+/g, "")
	if (!text || text.length > Math.ceil(CHUNK_BYTES / 3) * 4 + 8) {
		throw codedError("ARTIFACT_CHUNK_SIZE", "Artifact chunk is empty or exceeds the 384 KiB decoded limit.")
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
		throw codedError("ARTIFACT_BASE64_INVALID", "Artifact chunk is not standard base64.")
	}
	const buffer = Buffer.from(text, "base64")
	if (!buffer.length || buffer.length > CHUNK_BYTES) {
		throw codedError("ARTIFACT_CHUNK_SIZE", "Decoded artifact chunk is empty or exceeds the 384 KiB limit.")
	}
	if (buffer.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
		throw codedError("ARTIFACT_BASE64_INVALID", "Artifact base64 failed canonical round-trip validation.")
	}
	return buffer
}

function sha256File(path) {
	const hash = crypto.createHash("sha256")
	const fd = fs.openSync(path, "r")
	const buffer = Buffer.alloc(1024 * 1024)
	try {
		for (;;) {
			const n = fs.readSync(fd, buffer, 0, buffer.length, null)
			if (!n) break
			hash.update(buffer.subarray(0, n))
		}
	} finally {
		fs.closeSync(fd)
	}
	return hash.digest("hex")
}

class ArtifactStore {
	constructor(dir = ARTIFACT_DIR) {
		this.dir = dir
		this.ensureDir()
	}

	ensureDir() {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
		fs.chmodSync(this.dir, 0o700)
	}

	validateId(id) {
		const value = String(id || "").trim()
		if (!ARTIFACT_ID_RE.test(value)) throw codedError("ARTIFACT_ID_INVALID", "Artifact id is invalid.")
		return value
	}

	paths(id) {
		const value = this.validateId(id)
		return {
			data: pathModule.join(this.dir, value + ".bin"),
			meta: pathModule.join(this.dir, value + ".json"),
		}
	}

	cleanup() {
		this.ensureDir()
		const cutoff = Date.now() - ARTIFACT_TTL_MS
		for (const name of fs.readdirSync(this.dir)) {
			if (!/^([0-9a-f]{32})\.(bin|json)$/.test(name)) continue
			const full = pathModule.join(this.dir, name)
			try {
				if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
			} catch {}
		}
	}

	writeMeta(paths, meta) {
		const tmp = paths.meta + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
		fs.writeFileSync(tmp, JSON.stringify(meta), { encoding: "utf8", mode: 0o600 })
		fs.renameSync(tmp, paths.meta)
		fs.chmodSync(paths.meta, 0o600)
	}

	readMeta(id) {
		const value = this.validateId(id)
		const paths = this.paths(value)
		if (!fs.existsSync(paths.data) || !fs.existsSync(paths.meta)) {
			throw codedError("ARTIFACT_NOT_FOUND", "Artifact does not exist or has expired.")
		}
		let meta
		try { meta = JSON.parse(fs.readFileSync(paths.meta, "utf8")) }
		catch { throw codedError("ARTIFACT_METADATA_INVALID", "Artifact metadata is invalid.") }
		return { id: value, paths, meta }
	}

	publicMeta(id, meta) {
		return {
			artifact_id: id,
			filename: meta.filename || null,
			content_type: meta.content_type || null,
			size: Number(meta.size || 0),
			sha256: meta.sha256 || null,
			created_at: meta.created_at || null,
			updated_at: meta.updated_at || null,
			expires_after_seconds: Math.floor(ARTIFACT_TTL_MS / 1000),
			storage: "ephemeral-tmpfs",
		}
	}

	createEmpty({ filename = null, contentType = null } = {}) {
		this.cleanup()
		const id = crypto.randomBytes(16).toString("hex")
		const paths = this.paths(id)
		const now = new Date().toISOString()
		const meta = {
			schema: "capability-fabric.onshape-artifact.v1",
			filename: safeFilename(filename),
			content_type: safeContentType(contentType),
			size: 0,
			sha256: null,
			created_at: now,
			updated_at: now,
		}
		fs.writeFileSync(paths.data, Buffer.alloc(0), { mode: 0o600 })
		this.writeMeta(paths, meta)
		return this.publicMeta(id, meta)
	}

	appendBase64(id, offset, dataBase64) {
		const current = this.readMeta(id)
		const actual = fs.statSync(current.paths.data).size
		const requestedOffset = Number(offset)
		if (!Number.isInteger(requestedOffset) || requestedOffset !== actual) {
			throw codedError("ARTIFACT_OFFSET_MISMATCH", "Artifact append offset does not match current size.")
		}
		const buffer = decodeBase64Strict(dataBase64)
		if (actual + buffer.length > MAX_ARTIFACT_BYTES) {
			throw codedError("ARTIFACT_TOO_LARGE", "Artifact exceeds the 2 GiB temporary transport limit.")
		}
		fs.appendFileSync(current.paths.data, buffer)
		fs.chmodSync(current.paths.data, 0o600)
		current.meta.size = actual + buffer.length
		current.meta.sha256 = null
		current.meta.updated_at = new Date().toISOString()
		this.writeMeta(current.paths, current.meta)
		return { offset: actual + buffer.length, length: buffer.length }
	}

	readChunkRaw(id, offset, length = CHUNK_BYTES) {
		const current = this.readMeta(id)
		const size = fs.statSync(current.paths.data).size
		const start = Number(offset)
		const want = Math.min(CHUNK_BYTES, Number(length || CHUNK_BYTES))
		if (!Number.isInteger(start) || start < 0 || start > size) throw codedError("ARTIFACT_OFFSET_INVALID", "Artifact read offset is invalid.")
		if (!Number.isInteger(want) || want < 1 || want > CHUNK_BYTES) throw codedError("ARTIFACT_READ_SIZE", "Artifact read length is invalid.")
		const n = Math.min(want, size - start)
		const buffer = Buffer.alloc(n)
		if (n) {
			const fd = fs.openSync(current.paths.data, "r")
			try { fs.readSync(fd, buffer, 0, n, start) } finally { fs.closeSync(fd) }
		}
		return { offset: start, length: n, eof: start + n >= size, data_base64: buffer.toString("base64") }
	}

	finalize(id, patch = {}) {
		const current = this.readMeta(id)
		if (patch.filename) current.meta.filename = safeFilename(patch.filename, current.meta.filename)
		if (patch.contentType) current.meta.content_type = safeContentType(patch.contentType)
		current.meta.size = fs.statSync(current.paths.data).size
		current.meta.sha256 = sha256File(current.paths.data)
		current.meta.updated_at = new Date().toISOString()
		this.writeMeta(current.paths, current.meta)
		return this.publicMeta(current.id, current.meta)
	}

	status(id) {
		const current = this.readMeta(id)
		if (!current.meta.sha256) return this.finalize(id)
		current.meta.size = fs.statSync(current.paths.data).size
		return this.publicMeta(current.id, current.meta)
	}

	delete(id) {
		const value = this.validateId(id)
		const paths = this.paths(value)
		const existed = fs.existsSync(paths.data) || fs.existsSync(paths.meta)
		for (const p of [paths.data, paths.meta]) {
			try { fs.unlinkSync(p) } catch {}
		}
		return { artifact_id: value, deleted: existed }
	}

	writeAction(args = {}) {
		let id = args.artifact_id ? this.validateId(args.artifact_id) : null
		if (!id) {
			const created = this.createEmpty({ filename: args.filename, contentType: args.content_type })
			id = created.artifact_id
			if (args.offset != null && Number(args.offset) !== 0) {
				this.delete(id)
				throw codedError("ARTIFACT_OFFSET_MISMATCH", "A new artifact must start at offset zero.")
			}
		} else if (args.filename || args.content_type) {
			const current = this.readMeta(id)
			if (args.filename && safeFilename(args.filename) !== current.meta.filename) throw codedError("ARTIFACT_METADATA_MISMATCH", "Artifact filename cannot change while appending.")
			if (args.content_type && safeContentType(args.content_type) !== current.meta.content_type) throw codedError("ARTIFACT_METADATA_MISMATCH", "Artifact content type cannot change while appending.")
		}
		const current = this.readMeta(id)
		const offset = args.offset == null ? fs.statSync(current.paths.data).size : Number(args.offset)
		this.appendBase64(id, offset, args.data_base64)
		return this.publicMeta(id, this.readMeta(id).meta)
	}

	handle(action, args = {}) {
		this.cleanup()
		const name = String(action || "").toLowerCase()
		if (name === "write") return this.writeAction(args)
		if (name === "read") {
			const chunk = this.readChunkRaw(args.artifact_id, args.offset ?? 0, args.length ?? CHUNK_BYTES)
			return { ...this.publicMeta(args.artifact_id, this.readMeta(args.artifact_id).meta), ...chunk }
		}
		if (name === "status") return this.status(args.artifact_id)
		if (name === "delete") return this.delete(args.artifact_id)
		throw codedError("ARTIFACT_ACTION_INVALID", "Artifact action must be write, read, status, or delete.")
	}
}

async function ensureArtifactBindings(page, store) {
	let pending = pageBindingStates.get(page)
	if (pending) return pending
	pending = (async () => {
		const state = { tokens: new Map() }
		await page.exposeBinding(READ_BINDING, async (_source, token, id, offset, length) => {
			const access = state.tokens.get(String(token || ""))
			const artifactId = String(id || "")
			if (!access || !access.readIds.has(artifactId)) throw codedError("ARTIFACT_BINDING_DENIED", "Artifact read binding denied.")
			return store.readChunkRaw(artifactId, Number(offset), Number(length))
		})
		await page.exposeBinding(CREATE_BINDING, async (_source, token, metadata) => {
			const access = state.tokens.get(String(token || ""))
			if (!access || access.writeId) throw codedError("ARTIFACT_BINDING_DENIED", "Artifact create binding denied.")
			const created = store.createEmpty({
				filename: metadata?.filename || "onshape-download.bin",
				contentType: metadata?.contentType || "application/octet-stream",
			})
			access.writeId = created.artifact_id
			return created
		})
		await page.exposeBinding(APPEND_BINDING, async (_source, token, id, offset, dataBase64) => {
			const access = state.tokens.get(String(token || ""))
			const artifactId = String(id || "")
			if (!access || access.writeId !== artifactId) throw codedError("ARTIFACT_BINDING_DENIED", "Artifact append binding denied.")
			return store.appendBase64(artifactId, Number(offset), dataBase64)
		})
		return state
	})()
	pageBindingStates.set(page, pending)
	try { return await pending }
	catch (error) { pageBindingStates.delete(page); throw error }
}

async function resolveXsrfToken(page) {
	try {
		const cookies = await page.context().cookies()
		const match = cookies.find((c) => /xsrf|csrf/i.test(c.name))
		if (match) {
			return {
				state: "RESOLVED",
				source: "browser-context",
				cookieName: match.name,
				headerName: headerNameForCookie(match.name),
				value: decodeURIComponent(match.value),
				httpOnly: match.httpOnly,
			}
		}
	} catch (error) {
		return { state: "UNKNOWN", reason: "cookie read failed: " + String((error && error.message) || error) }
	}
	return { state: "ABSENT", reason: "no anti-forgery cookie in the profile" }
}

function headerNameForCookie(cookieName) {
	if (/^_?xsrf/i.test(cookieName)) return "x-xsrf-token"
	if (/csrf/i.test(cookieName)) return "x-csrf-token"
	return "x-xsrf-token"
}

function needsAntiForgery(method) {
	return !/^(GET|HEAD|OPTIONS)$/i.test(method)
}

function buildTarget(path, query) {
	let target = path.startsWith("/") ? path : "/" + path
	if (query && Object.keys(query).length > 0) {
		const params = new URLSearchParams()
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) continue
			if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)))
			else params.append(key, String(value))
		}
		const serialised = params.toString()
		if (serialised) target += (target.includes("?") ? "&" : "?") + serialised
	}
	return target
}

function normalizeCallerHeaders(extra) {
	const headers = { accept: "*/*" }
	const blocked = new Set([
		"authorization", "cookie", "set-cookie", "host", "origin", "referer",
		"content-length", "transfer-encoding", "connection",
		"x-xsrf-token", "x-csrf-token",
	])
	for (const [rawName, rawValue] of Object.entries(extra || {})) {
		const name = String(rawName || "").trim().toLowerCase()
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw codedError("HEADER_NAME_INVALID", "Request header name is invalid.")
		if (blocked.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) throw codedError("HEADER_FORBIDDEN", "Request header is owned by the browser-session security boundary.")
		if (name === "content-type") throw codedError("HEADER_FORBIDDEN", "content-type is derived from the request body mode.")
		const value = String(rawValue ?? "")
		if (value.length > 4096 || /[\r\n\0]/.test(value)) throw codedError("HEADER_VALUE_INVALID", "Request header value is invalid.")
		headers[name] = value
	}
	return headers
}

function filenameFromDisposition(value) {
	const text = String(value || "")
	const utf = text.match(/filename\*=UTF-8''([^;]+)/i)
	if (utf) {
		try { return safeFilename(decodeURIComponent(utf[1])) } catch {}
	}
	const plain = text.match(/filename="?([^";]+)"?/i)
	return plain ? safeFilename(plain[1]) : "onshape-download.bin"
}

async function onshapeRequest(page, spec, context) {
	const ctx = context || {}
	const build = ctx.build || "unknown"
	const host = ctx.host || DEFAULT_HOST
	const store = ctx.artifactStore
	const started = Date.now()
	const method = String((spec && spec.method) || "GET").toUpperCase()
	const path = (spec && spec.path) || ""
	const base = { method, path, build, origin: originFor(host) }

	if (!path.startsWith("/api/")) return { ...base, ok: false, layer: "validation", reason: "path must start with /api/", durationMs: Date.now() - started }
	if (spec && spec.multipart && spec.body !== undefined) return { ...base, ok: false, layer: "validation", reason: "body and multipart are mutually exclusive", durationMs: Date.now() - started }
	if (spec && spec.multipart && /^(GET|HEAD)$/i.test(method)) return { ...base, ok: false, layer: "validation", reason: "multipart is not valid for GET/HEAD", durationMs: Date.now() - started }

	let headers
	try { headers = normalizeCallerHeaders(spec && spec.headers) }
	catch (error) { return { ...base, ok: false, layer: "validation", code: error.code || "HEADER_INVALID", reason: String(error.message || error), durationMs: Date.now() - started } }

	let antiForgery = { state: "NOT_REQUIRED" }
	if (needsAntiForgery(method)) {
		antiForgery = await resolveXsrfToken(page)
		if (antiForgery.state !== "RESOLVED") return { ...base, ok: false, layer: "anti-forgery", antiForgery, reason: "cannot issue a write without the double-submit token", durationMs: Date.now() - started }
		headers[ctx.antiForgeryHeaderName || antiForgery.headerName] = antiForgery.value
	}

	const hasJsonBody = spec && spec.body !== undefined && !/^(GET|HEAD)$/.test(method)
	if (hasJsonBody) headers["content-type"] = "application/json"

	let multipart = null
	const readIds = new Set()
	if (spec && spec.multipart) {
		if (!store) return { ...base, ok: false, layer: "artifact", reason: "multipart transport requires artifact storage", durationMs: Date.now() - started }
		const fields = spec.multipart.fields && typeof spec.multipart.fields === "object" ? spec.multipart.fields : {}
		const files = []
		try {
			for (const file of Array.isArray(spec.multipart.files) ? spec.multipart.files : []) {
				const id = store.validateId(file.artifact_id)
				const current = store.readMeta(id)
				readIds.add(id)
				files.push({
					field: String(file.field || "file"),
					artifactId: id,
					filename: safeFilename(file.filename || current.meta.filename),
					contentType: safeContentType(file.content_type || current.meta.content_type),
				})
			}
		} catch (error) {
			return { ...base, ok: false, layer: "artifact", code: error.code || "ARTIFACT_ERROR", reason: String(error.message || error), durationMs: Date.now() - started }
		}
		multipart = { fields, files }
	}

	let sinkId = null
	let bindingState = null
	let token = null
	if (store) {
		try {
			bindingState = await ensureArtifactBindings(page, store)
			token = crypto.randomBytes(16).toString("hex")
			bindingState.tokens.set(token, { readIds, writeId: null })
		} catch (error) {
			return { ...base, ok: false, layer: "artifact", code: error.code || "ARTIFACT_BINDING_ERROR", reason: String(error.message || error), durationMs: Date.now() - started }
		}
	}

	const target = buildTarget(path, spec && spec.query)
	let result
	let schedulerTiming = null
	try {
		const dispatch = () => page.evaluate(async (input) => {
			function decodeBase64(text) {
				const raw = atob(text)
				const bytes = new Uint8Array(raw.length)
				for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
				return bytes
			}
			function encodeBase64(bytes) {
				let binary = ""
				const step = 0x8000
				for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step))
				return btoa(binary)
			}
			function textualContentType(value) {
				const type = String(value || "").toLowerCase()
				return type.includes("json") || type.startsWith("text/") || type.includes("yaml") ||
					type.includes("xml") || type.includes("javascript") || type.includes("gltf+json") ||
					type.includes("svg")
			}
			try {
				const init = { method: input.method, credentials: "include", headers: input.headers }
				if (input.multipart) {
					const form = new FormData()
					for (const [key, value] of Object.entries(input.multipart.fields || {})) {
						if (value === undefined || value === null) continue
						if (Array.isArray(value)) value.forEach((item) => form.append(key, String(item)))
						else form.append(key, String(value))
					}
					for (const file of input.multipart.files || []) {
						let offset = 0
						const parts = []
						for (;;) {
							const chunk = await window[input.readBinding](input.token, file.artifactId, offset, input.chunkBytes)
							if (chunk.length) {
								parts.push(decodeBase64(chunk.data_base64))
								offset += chunk.length
							}
							if (chunk.eof) break
						}
						form.append(file.field, new Blob(parts, { type: file.contentType }), file.filename)
					}
					init.body = form
				} else if (input.hasJsonBody) {
					init.body = JSON.stringify(input.body)
				}
				const response = await fetch(input.target, init)
				const responseHeaders = Object.fromEntries(response.headers.entries())
				const contentType = response.headers.get("content-type") || ""
				if (response.status === 204 || response.status === 205) {
					return { http: response.status, contentType, responseHeaders, json: null, text: "", bodyKind: "empty", issuedFrom: window.location.origin }
				}
				if (textualContentType(contentType)) {
					const text = await response.text()
					let parsed = null
					try { parsed = JSON.parse(text) } catch (_) {}
					return {
						http: response.status, contentType, responseHeaders,
						json: parsed, text: parsed === null ? text : null,
						bodyKind: parsed === null ? "text" : "json",
						issuedFrom: window.location.origin,
					}
				}
				const created = await window[input.createBinding](input.token, {
					filename: "onshape-download.bin",
					contentType: contentType || "application/octet-stream",
				})
				const sinkId = created.artifact_id
				let offset = 0
				if (response.body && response.body.getReader) {
					const reader = response.body.getReader()
					for (;;) {
						const item = await reader.read()
						if (item.done) break
						if (item.value && item.value.length) {
							const appended = await window[input.appendBinding](input.token, sinkId, offset, encodeBase64(item.value))
							offset = appended.offset
						}
					}
				} else {
					const bytes = new Uint8Array(await response.arrayBuffer())
					for (let i = 0; i < bytes.length; i += input.chunkBytes) {
						const appended = await window[input.appendBinding](input.token, sinkId, offset, encodeBase64(bytes.subarray(i, i + input.chunkBytes)))
						offset = appended.offset
					}
				}
				return { http: response.status, contentType, responseHeaders, json: null, text: null, bodyKind: "binary", binaryBytes: offset, sinkId, issuedFrom: window.location.origin }
			} catch (error) {
				return { failed: String((error && error.message) || error), issuedFrom: window.location.origin }
			}
		}, {
			target, method, headers, body: spec && spec.body, hasJsonBody, multipart,
			token,
			readBinding: READ_BINDING, createBinding: CREATE_BINDING, appendBinding: APPEND_BINDING, chunkBytes: CHUNK_BYTES,
		})
		if (ctx.apiScheduler) {
			const scheduled = await ctx.apiScheduler.run(dispatch, {
				kind: ctx.apiRequestKind || method + " " + path,
				allowWhilePaused: ctx.apiSchedulerMaintenance === true,
				returnTiming: true,
			})
			result = scheduled.value
			schedulerTiming = scheduled.timing
		} else {
			result = await dispatch()
		}
	} catch (error) {
		result = { failed: String((error && error.message) || error) }
	} finally {
		if (bindingState && token) {
			const access = bindingState.tokens.get(token)
			if (access?.writeId) sinkId = access.writeId
			bindingState.tokens.delete(token)
		}
	}

	if (result && result.failed) {
		if (sinkId && store) store.delete(sinkId)
		return { ...base, ok: false, layer: "network", reason: result.failed, issuedFrom: result.issuedFrom, durationMs: Date.now() - started }
	}

	const originMatches = result.issuedFrom === originFor(host)
	let body = result.json !== null ? result.json : result.text
	let artifact = null
	if (result.bodyKind === "binary") {
		try {
			artifact = store.finalize(result.sinkId || sinkId, {
				filename: filenameFromDisposition(result.responseHeaders && result.responseHeaders["content-disposition"]),
				contentType: result.contentType || "application/octet-stream",
			})
			body = null
		} catch (error) {
			if (result.sinkId || sinkId) store.delete(result.sinkId || sinkId)
			return { ...base, ok: false, layer: "artifact", code: error.code || "ARTIFACT_FINALIZE_ERROR", reason: String(error.message || error), http: result.http, durationMs: Date.now() - started }
		}
	}

	return {
		...base,
		ok: result.http >= 200 && result.http < 300,
		http: result.http,
		contentType: result.contentType,
		responseHeaders: result.responseHeaders || {},
		body,
		bodyKind: result.bodyKind,
		artifact,
		issuedFrom: result.issuedFrom,
		originMatches,
		antiForgery: {
			state: antiForgery.state,
			headerSent: antiForgery.state === "RESOLVED" ? ctx.antiForgeryHeaderName || antiForgery.headerName : null,
		},
		schedulerTiming,
		durationMs: Date.now() - started,
	}
}

async function onshapeBatch(page, specs, context) {
	const list = Array.isArray(specs) ? specs : []
	const reads = list.filter((s) => !needsAntiForgery((s && s.method) || "GET"))
	if (reads.length !== list.length) return { ok: false, layer: "validation", reason: "batch accepts read-only requests; issue writes individually", build: (context && context.build) || "unknown" }
	const limit = (context && context.concurrency) || 4
	const results = []
	for (let i = 0; i < list.length; i += limit) {
		const settled = await Promise.all(list.slice(i, i + limit).map((spec) => onshapeRequest(page, spec, context)))
		results.push(...settled)
	}
	return { ok: results.every((r) => r.ok), count: results.length, results, build: (context && context.build) || "unknown" }
}

module.exports = {
	onshapeRequest,
	onshapeBatch,
	resolveXsrfToken,
	buildTarget,
	headerNameForCookie,
	needsAntiForgery,
	ArtifactStore,
	GlassworksApiScheduler,
}