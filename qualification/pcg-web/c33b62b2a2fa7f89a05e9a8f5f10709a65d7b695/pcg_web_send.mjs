import { ensureProviderModel } from "./pcg_web_provider_model.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Every await that crosses into the page is bounded. An unbounded provider
// await cannot fail loudly: it hangs, and a hang is reported as nothing at all.
// A deadline turns an unreachable provider into a named, recorded failure.
const PROVIDER_DEADLINE_MS = 30000;
const PROVIDER_UPLOAD_DEADLINE_MS = 180000;

async function evaluateWithin(page, timeoutMs, fn, arg) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error("WEB_PROVIDER_EVALUATE_TIMEOUT");
      err.code = "WEB_PROVIDER_EVALUATE_TIMEOUT";
      err.timeout_ms = timeoutMs;
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function requiredString(value, code, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail(code);
  return value;
}

function boundedText(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0")) {
    fail("WEB_SEND_TEXT_INVALID");
  }
  return value;
}

function boundedEditText(value) {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
    fail("WEB_EDIT_TEXT_INVALID");
  }
  return value;
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validRandomId(value) {
  return typeof value === "string" && /^(?:[1-9][0-9]{0,18})$/.test(value);
}

function boundedAttachmentFilename(value) {
  value = requiredString(value, "WEB_ATTACHMENT_FILENAME_INVALID", 128);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    fail("WEB_ATTACHMENT_FILENAME_INVALID");
  }
  return value;
}

function boundedAttachmentMimeType(value) {
  value = requiredString(value, "WEB_ATTACHMENT_MIME_INVALID", 128).toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#&^_.+-]{0,63}$/.test(value)) {
    fail("WEB_ATTACHMENT_MIME_INVALID");
  }
  return value;
}

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

function boundedAttachmentSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTACHMENT_BYTES) fail("WEB_ATTACHMENT_SIZE_INVALID");
  return value;
}

function boundedAttachmentCaption(value, sha256) {
  if (value === "") {
    if (sha256 !== null && sha256 !== undefined) fail("WEB_ATTACHMENT_CAPTION_DIGEST_INVALID");
    return { text: "", sha256: null };
  }
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) {
    fail("WEB_ATTACHMENT_CAPTION_INVALID");
  }
  if (!validSha256(sha256)) fail("WEB_ATTACHMENT_CAPTION_DIGEST_INVALID");
  const actual = createHash("sha256").update(value, "utf8").digest("hex");
  if (actual !== sha256) fail("WEB_ATTACHMENT_CAPTION_DIGEST_MISMATCH");
  return { text: value, sha256 };
}

function materialFileToken(value) {
  if (typeof value !== "string" || !/^pcgfile:[0-9a-f]{64}$/.test(value)) {
    fail("WEB_MATERIAL_FILE_HANDLE_INVALID");
  }
  return value.slice("pcgfile:".length);
}

export function createMaterialSendBridge({ identity, correlationFile, materialFileRoot }) {
  if (!identity
      || typeof identity.providerRefForHandle !== "function"
      || typeof identity.providerMessageRefForHandle !== "function"
      || typeof identity.opaqueMessageHandle !== "function") {
    fail("WEB_SEND_IDENTITY_UNAVAILABLE");
  }
  correlationFile = requiredString(correlationFile, "WEB_SEND_CORRELATION_FILE_INVALID", 1024);
  materialFileRoot = requiredString(materialFileRoot, "WEB_MATERIAL_FILE_ROOT_INVALID", 1024);
  if (!path.isAbsolute(materialFileRoot)) fail("WEB_MATERIAL_FILE_ROOT_INVALID");
  fs.mkdirSync(materialFileRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(materialFileRoot, 0o700);

  function materialFilePath(fileHandle, filename) {
    const token = materialFileToken(fileHandle);
    filename = boundedAttachmentFilename(filename);
    return path.join(materialFileRoot, token + "-" + filename);
  }

  function releaseMaterialFile(candidate) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("WEB_MATERIAL_FILE_ENTRY_INVALID");
      fs.unlinkSync(candidate);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  function sweepMaterialFiles(maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    for (const name of fs.readdirSync(materialFileRoot)) {
      if (!/^[0-9a-f]{64}-.+/.test(name)) continue;
      const candidate = path.join(materialFileRoot, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (now - stat.mtimeMs <= maxAgeMs) continue;
        fs.unlinkSync(candidate);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
  }

  async function validateMaterialFile(fileHandle, filename, sizeBytes, payloadSha256) {
    sweepMaterialFiles();
    const candidate = materialFilePath(fileHandle, filename);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
      fd = fs.openSync(candidate, flags);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== sizeBytes) fail("WEB_MATERIAL_FILE_SIZE_MISMATCH");
      const digest = createHash("sha256");
      const stream = fs.createReadStream(candidate, {
        fd,
        autoClose: false,
        highWaterMark: 1024 * 1024,
      });
      for await (const chunk of stream) digest.update(chunk);
      if (digest.digest("hex") !== payloadSha256) fail("WEB_MATERIAL_FILE_DIGEST_MISMATCH");
      return candidate;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  async function attachMaterialInput(page, filePaths) {
    const inputId = "pcg-material-" + createHash("sha256")
      .update(filePaths.join("|") + "|" + process.hrtime.bigint().toString(), "utf8")
      .digest("hex")
      .slice(0, 24);
    await evaluateWithin(page, PROVIDER_DEADLINE_MS, ({ inputId, multiple }) => {
      document.getElementById(inputId)?.remove();
      const input = document.createElement("input");
      input.type = "file";
      input.id = inputId;
      input.multiple = multiple;
      input.style.display = "none";
      document.documentElement.appendChild(input);
    }, { inputId, multiple: filePaths.length > 1 });
    try {
      await page.locator("#" + inputId).setInputFiles(filePaths.length === 1 ? filePaths[0] : filePaths);
      return inputId;
    } catch (err) {
      await evaluateWithin(page, PROVIDER_DEADLINE_MS, (id) => document.getElementById(id)?.remove(), inputId).catch(() => {});
      throw err;
    }
  }

  async function removeMaterialInput(page, inputId) {
    if (!inputId) return;
    await evaluateWithin(page, PROVIDER_DEADLINE_MS, (id) => document.getElementById(id)?.remove(), inputId).catch(() => {});
  }

  sweepMaterialFiles();

  function stageMaterialFile({ dataBase64, filename, mimeType, sizeBytes, payloadSha256 }) {
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    if (!validSha256(payloadSha256)) fail("WEB_MATERIAL_FILE_DIGEST_INVALID");
    if (typeof dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      fail("WEB_MATERIAL_FILE_PAYLOAD_INVALID");
    }
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length !== sizeBytes) fail("WEB_MATERIAL_FILE_SIZE_MISMATCH");
    if (createHash("sha256").update(bytes).digest("hex") !== payloadSha256) {
      fail("WEB_MATERIAL_FILE_DIGEST_MISMATCH");
    }
    sweepMaterialFiles();
    const token = createHash("sha256")
      .update(payloadSha256 + "|" + process.pid + "|" + process.hrtime.bigint().toString(), "utf8")
      .digest("hex");
    const fileHandle = "pcgfile:" + token;
    const destination = materialFilePath(fileHandle, filename);
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let committed = false;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
      committed = true;
    } finally {
      try { fs.closeSync(fd); } catch {}
      if (!committed) {
        try { fs.unlinkSync(destination); } catch {}
      }
    }
    return {
      file_handle: fileHandle,
      filename,
      media_type: mimeType,
      size_bytes: sizeBytes,
      sha256_hex: payloadSha256,
    };
  }


  function createMaterialFileWriter({ filename, mimeType, sizeBytes }) {
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    sweepMaterialFiles();

    const token = createHash("sha256")
      .update(filename + "|" + sizeBytes + "|" + process.pid + "|" + process.hrtime.bigint().toString(), "utf8")
      .digest("hex");
    const fileHandle = "pcgfile:" + token;
    const destination = materialFilePath(fileHandle, filename);
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const digest = createHash("sha256");
    let offset = 0;
    let closed = false;
    let committed = false;

    function closeFd() {
      if (closed) return;
      closed = true;
      try { fs.closeSync(fd); } catch {}
    }

    function abort() {
      closeFd();
      try { fs.unlinkSync(destination); } catch {}
      committed = false;
      return true;
    }

    function append(chunk, expectedOffset = offset) {
      if (closed || committed) fail("WEB_MATERIAL_FILE_WRITER_CLOSED");
      if (!Number.isSafeInteger(expectedOffset) || expectedOffset !== offset) fail("WEB_MATERIAL_FILE_OFFSET_MISMATCH");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!bytes.length || offset + bytes.length > sizeBytes) fail("WEB_MATERIAL_FILE_CHUNK_INVALID");
      const written = fs.writeSync(fd, bytes, 0, bytes.length, offset);
      if (written !== bytes.length) fail("WEB_MATERIAL_FILE_WRITE_INCOMPLETE");
      digest.update(bytes);
      offset += bytes.length;
      return offset;
    }

    function finalize() {
      if (closed || committed) fail("WEB_MATERIAL_FILE_WRITER_CLOSED");
      if (offset !== sizeBytes) fail("WEB_MATERIAL_FILE_SIZE_MISMATCH");
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
      closeFd();
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== sizeBytes) {
        try { fs.unlinkSync(destination); } catch {}
        fail("WEB_MATERIAL_FILE_COMMIT_INVALID");
      }
      committed = true;
      return {
        file_handle: fileHandle,
        filename,
        media_type: mimeType,
        size_bytes: sizeBytes,
        sha256_hex: digest.digest("hex"),
      };
    }

    return {
      file_handle: fileHandle,
      filename,
      media_type: mimeType,
      size_bytes: sizeBytes,
      append,
      finalize,
      abort,
      current_offset: () => offset,
    };
  }

  function readRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(correlationFile, "utf8"));
      if (!parsed || parsed.schema !== 1 || typeof parsed.attempts !== "object" || Array.isArray(parsed.attempts)) {
        fail("WEB_SEND_CORRELATION_INVALID");
      }
      return parsed;
    } catch (err) {
      if (err?.code === "ENOENT") return { schema: 1, attempts: {} };
      if (err?.code === "WEB_SEND_CORRELATION_INVALID") throw err;
      fail("WEB_SEND_CORRELATION_INVALID");
    }
  }

  function writeRegistry(registry) {
    const parent = correlationFile.slice(0, correlationFile.lastIndexOf("/")) || ".";
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = correlationFile + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(registry) + "\n", { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, correlationFile);
    fs.chmodSync(correlationFile, 0o600);
  }

  function sameReservation(record, {
    providerRef,
    randomId,
    payloadSha256,
    operationKind = "send_text",
    sourceMessageId = null,
    attachmentFilename = null,
    attachmentMimeType = null,
    attachmentSizeBytes = null,
    deletionScope = null,
    sourceProviderRef = null,
    relayPurpose = null,
    sourceContentSha256 = null,
    attachmentCaptionSha256 = null,
    albumDigest = null,
    albumItemCount = null,
  }) {
    const recordKind = typeof record.operation_kind === "string" ? record.operation_kind : "send_text";
    const recordSource = Number.isSafeInteger(record.source_message_id) ? record.source_message_id : null;
    const recordFilename = typeof record.attachment_filename === "string" ? record.attachment_filename : null;
    const recordMimeType = typeof record.attachment_mime_type === "string" ? record.attachment_mime_type : null;
    const recordSizeBytes = Number.isSafeInteger(record.attachment_size_bytes) ? record.attachment_size_bytes : null;
    const recordDeletionScope = typeof record.deletion_scope === "string" ? record.deletion_scope : null;
    const recordSourceProviderRef = typeof record.source_provider_ref === "string" ? record.source_provider_ref : null;
    const recordRelayPurpose = typeof record.relay_purpose === "string" ? record.relay_purpose : null;
    const recordSourceContentSha256 = typeof record.source_content_sha256 === "string" ? record.source_content_sha256 : null;
    const recordAttachmentCaptionSha256 = typeof record.attachment_caption_sha256 === "string" ? record.attachment_caption_sha256 : null;
    const recordAlbumDigest = typeof record.album_digest === "string" ? record.album_digest : null;
    const recordAlbumItemCount = Number.isSafeInteger(record.album_item_count) ? record.album_item_count : null;
    return record.provider_ref === providerRef
      && record.random_id === randomId
      && record.payload_sha256 === payloadSha256
      && recordKind === operationKind
      && recordSource === sourceMessageId
      && recordFilename === attachmentFilename
      && recordMimeType === attachmentMimeType
      && recordSizeBytes === attachmentSizeBytes
      && recordDeletionScope === deletionScope
      && recordSourceProviderRef === sourceProviderRef
      && recordRelayPurpose === relayPurpose
      && recordSourceContentSha256 === sourceContentSha256
      && recordAttachmentCaptionSha256 === attachmentCaptionSha256
      && recordAlbumDigest === albumDigest
      && recordAlbumItemCount === albumItemCount;
  }

  function safeRecord(record, { redispatchBlocked = false } = {}) {
    return {
      ok: true,
      ack_state: record.state === "FAILED"
        ? "REJECTED"
        : (record.state === "ACKNOWLEDGED" || record.state === "SUCCEEDED" ? "ACKNOWLEDGED" : "UNKNOWN"),
      provider_confirmed: record.state === "SUCCEEDED",
      provider_rejected: record.state === "FAILED",
      provider_error_code: Number.isSafeInteger(record.provider_error_code) ? record.provider_error_code : null,
      provider_error_type: typeof record.provider_error_type === "string" ? record.provider_error_type : null,
      final_message_known: Number.isSafeInteger(record.final_message_id)
        || (Array.isArray(record.final_message_ids) && record.final_message_ids.length > 0),
      final_message_count: Array.isArray(record.final_message_ids) ? record.final_message_ids.length : (Number.isSafeInteger(record.final_message_id) ? 1 : 0),
      // The id of the message we just created is knowledge the caller needs:
      // without it every follow-up (reply to it, react to it, delete it) has to
      // search for it, and a search can pick the wrong message.
      final_message_id: Number.isSafeInteger(record.final_message_id) ? record.final_message_id : null,
      final_message_ids: Array.isArray(record.final_message_ids)
        ? record.final_message_ids.filter((value) => Number.isSafeInteger(value)).slice(0, 10)
        : [],
      redispatch_blocked: redispatchBlocked,
      provider_content_model_visible: false,
    };
  }

  async function selfTarget(page) {
    const providerRef = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async () => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const users = create(accountNumber)?.appUsersManager;
      if (!users || typeof users.getSelf !== "function") return null;
      const self = await users.getSelf();
      const id = Number(self?.id);
      return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
    });
    if (!providerRef) fail("WEB_SEND_SELF_TARGET_UNAVAILABLE");
    return {
      conversation_handle: identity.opaqueConversationHandle(providerRef),
      provider_content_model_visible: false,
    };
  }

  async function selfReplyTarget(page) {
    const target = await selfTarget(page);
    const providerRef = identity.providerRefForHandle(target.conversation_handle);
    const sourceMid = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async (peerId) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.getHistory !== "function" || typeof messages.getMessageByPeer !== "function") return null;
      let history;
      try {
        history = await globalThis.__pcgProvider.history(managers, peerId, { offsetId: 0, limit: 20 });
      } catch {
        return null;
      }
      const mids = Array.isArray(history?.history) ? history.history : [];
      for (const rawMid of mids) {
        const mid = Number(rawMid);
        if (!Number.isSafeInteger(mid)) continue;
        let message = await messages.getMessageByPeer(peerId, mid);
        if (!message && typeof messages.reloadMessage === "function") {
          try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid); } catch {}
        }
        if (message?._ === "message" && message.pFlags?.out === true) return mid;
      }
      return null;
    }, Number(providerRef));
    if (!Number.isSafeInteger(sourceMid)) fail("WEB_REPLY_SELF_SOURCE_UNAVAILABLE");
    return {
      conversation_handle: target.conversation_handle,
      source_message_handle: identity.opaqueMessageHandle(providerRef, sourceMid),
      provider_content_model_visible: false,
    };
  }

  async function checkTarget(page, conversationHandle) {
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const exists = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async (peerId) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const peers = managers?.appPeersManager;
      if (!peers || typeof peers.getInputPeerById !== "function") return false;
      try {
        const inputPeer = await peers.getInputPeerById(peerId);
        return !!inputPeer && typeof inputPeer === "object";
      } catch {
        return false;
      }
    }, Number(providerRef));
    if (!exists) fail("WEB_SEND_TARGET_NOT_AVAILABLE");
    return {
      conversation_handle: conversationHandle,
      target_resolved: true,
      provider_content_model_visible: false,
    };
  }

  async function checkReplyTarget(page, conversationHandle, sourceMessageHandle) {
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== providerRef) fail("WEB_REPLY_SOURCE_CONVERSATION_MISMATCH");
    const exists = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadConversation !== "function" || typeof messages.reloadMessage !== "function") return false;
      try {
        const dialog = await messages.reloadConversation(peerId, false);
        if (!dialog) return false;
        const source = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        return source?._ === "message";
      } catch {
        return false;
      }
    }, { peerId: Number(providerRef), mid: sourceRef.mid });
    if (!exists) fail("WEB_REPLY_SOURCE_NOT_AVAILABLE");
    return {
      conversation_handle: conversationHandle,
      source_message_handle: sourceMessageHandle,
      target_resolved: true,
      source_resolved: true,
      provider_content_model_visible: false,
    };
  }

  async function dispatchText(page, {
    attemptId,
    conversationHandle,
    randomId,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_SEND_ATTEMPT_INVALID", 256);
    text = boundedText(text);
    if (!validSha256(payloadSha256)) fail("WEB_SEND_PAYLOAD_DIGEST_INVALID");
    if (!validRandomId(randomId)) fail("WEB_SEND_RANDOM_ID_INVALID");

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, { providerRef, randomId, payloadSha256 })) {
        fail("WEB_SEND_ATTEMPT_CORRELATION_CONFLICT");
      }
      return safeRecord(existing, { redispatchBlocked: true });
    }

    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: payloadSha256,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, randomId, text }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }

        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !updatesManager) {
          return { ok: false, error: "WEBK_SEND_MANAGER_UNAVAILABLE" };
        }
        for (const [manager, methods] of [
          [api, ["invokeApi"]],
          [peers, ["getInputPeerById"]],
          [messages, ["reloadMessage"]],
          [updatesManager, ["processUpdateMessage"]],
        ]) {
          if (methods.some((name) => typeof manager?.[name] !== "function")) {
            return { ok: false, error: "WEBK_SEND_PRIMITIVE_UNAVAILABLE" };
          }
        }

        let inputPeer;
        try {
          inputPeer = await peers.getInputPeerById(peerId);
          if (!inputPeer || typeof inputPeer !== "object") return { ok: false, error: "WEBK_SEND_TARGET_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_SEND_TARGET_PRECHECK_FAILED" };
        }

        let updates;
        try {
          updates = await api.invokeApi("messages.sendMessage", {
            peer: inputPeer,
            message: text,
            random_id: randomId,
            no_webpage: true,
            clear_draft: false,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            final_message_id: null,
            provider_confirmed: false,
          };
        }

        let finalMessageId = null;
        if (updates?._ === "updateShortSentMessage" && Number.isSafeInteger(Number(updates.id))) {
          finalMessageId = Number(updates.id);
        } else if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID"
                && String(update.random_id) === String(randomId)
                && Number.isSafeInteger(Number(update.id))) {
              finalMessageId = Number(update.id);
              break;
            }
          }
          if (finalMessageId === null) {
            for (const update of updates.updates) {
              const message = update?.message;
              if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage")
                  && message?.pFlags?.out === true
                  && Number.isSafeInteger(Number(message.id))) {
                finalMessageId = Number(message.id);
                break;
              }
            }
          }
        }

        try {
          await updatesManager.processUpdateMessage(updates);
        } catch {}

        if (!Number.isSafeInteger(finalMessageId)) {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: null,
            provider_confirmed: false,
          };
        }

        // The provider answers with a server id; the client addresses messages
        // by its own shifted id. Confirming with the wrong id space reads an
        // absent message and reports an effect that in fact succeeded as
        // unconfirmed. Each candidate is proven by reading the message back.
        try {
          const resolved = await globalThis.__pcgProvider.clientMessageId(
            managers,
            peerId,
            finalMessageId,
            (candidate) => candidate.message === text,
          );
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: resolved.value === null ? finalMessageId : resolved.value,
            provider_server_message_id: finalMessageId,
            provider_confirmed: resolved.proven === true,
          };
        } catch {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: false,
          };
        }
      }, {
        peerId: Number(providerRef),
        randomId,
        text,
      });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_SEND_PROVIDER_CALL_FAILED");

    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, { providerRef, randomId, payloadSha256 })) {
      fail("WEB_SEND_ATTEMPT_CORRELATION_LOST");
    }

    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code)
        ? result.provider_error_code
        : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id)
        ? result.final_message_id
        : null;
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observeText(page, {
    attemptId,
    conversationHandle,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_SEND_ATTEMPT_INVALID", 256);
    text = boundedText(text);
    if (!validSha256(payloadSha256)) fail("WEB_SEND_PAYLOAD_DIGEST_INVALID");
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) {
      return {
        ok: true,
        state: "UNKNOWN",
        provider_content_model_visible: false,
      };
    }
    if (record.provider_ref !== providerRef || record.payload_sha256 !== payloadSha256) {
      fail("WEB_SEND_ATTEMPT_CORRELATION_CONFLICT");
    }
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (record.state === "SUCCEEDED") return { ...safeRecord(record), state: "SUCCEEDED" };
    if (!Number.isSafeInteger(record.final_message_id)) {
      return { ...safeRecord(record), state: "UNKNOWN" };
    }

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid, text }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") return false;
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        return observed?._ === "message" && observed.message === text;
      } catch {
        return false;
      }
    }, {
      peerId: Number(providerRef),
      mid: record.final_message_id,
      text,
    });

    if (!confirmed) return { ...safeRecord(record), state: "UNKNOWN" };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }

  async function dispatchReplyText(page, {
    attemptId,
    conversationHandle,
    sourceMessageHandle,
    randomId,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_REPLY_ATTEMPT_INVALID", 256);
    text = boundedText(text);
    if (!validSha256(payloadSha256)) fail("WEB_REPLY_PAYLOAD_DIGEST_INVALID");
    if (!validRandomId(randomId)) fail("WEB_REPLY_RANDOM_ID_INVALID");

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== providerRef) fail("WEB_REPLY_SOURCE_CONVERSATION_MISMATCH");
    const sourceMessageId = sourceRef.mid;

    const reservation = {
      providerRef,
      randomId,
      payloadSha256,
      operationKind: "reply_text",
      sourceMessageId,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, reservation)) fail("WEB_REPLY_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }

    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: payloadSha256,
      operation_kind: "reply_text",
      source_message_id: sourceMessageId,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, sourceMessageId, randomId, text }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }

        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !updatesManager) {
          return { ok: false, error: "WEBK_REPLY_MANAGER_UNAVAILABLE" };
        }
        for (const [manager, methods] of [
          [api, ["invokeApi"]],
          [peers, ["getInputPeerById"]],
          [messages, ["reloadConversation", "reloadMessage", "getInputReplyTo"]],
          [updatesManager, ["processUpdateMessage"]],
        ]) {
          if (methods.some((name) => typeof manager?.[name] !== "function")) {
            return { ok: false, error: "WEBK_REPLY_PRIMITIVE_UNAVAILABLE" };
          }
        }

        let source;
        try {
          const before = await messages.reloadConversation(peerId, false);
          if (!before) return { ok: false, error: "WEBK_REPLY_TARGET_NOT_FOUND" };
          source = await globalThis.__pcgProvider.readMessage(managers, peerId, sourceMessageId);
          if (source?._ !== "message") return { ok: false, error: "WEBK_REPLY_SOURCE_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_REPLY_PRECHECK_FAILED" };
        }

        let replyTo;
        try {
          replyTo = await messages.getInputReplyTo({ peerId, replyToMsgId: sourceMessageId });
        } catch {
          return { ok: false, error: "WEBK_REPLY_RELATIONSHIP_UNAVAILABLE" };
        }
        if (!replyTo || replyTo._ !== "inputReplyToMessage"
            || !Number.isSafeInteger(Number(replyTo.reply_to_msg_id))) {
          return { ok: false, error: "WEBK_REPLY_TYPE_UNSUPPORTED" };
        }

        let updates;
        try {
          updates = await api.invokeApi("messages.sendMessage", {
            peer: await peers.getInputPeerById(peerId),
            message: text,
            random_id: randomId,
            no_webpage: true,
            clear_draft: false,
            reply_to: replyTo,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            final_message_id: null,
            provider_confirmed: false,
            reply_relationship_confirmed: false,
          };
        }

        let finalMessageId = null;
        if (updates?._ === "updateShortSentMessage" && Number.isSafeInteger(Number(updates.id))) {
          finalMessageId = Number(updates.id);
        } else if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID"
                && String(update.random_id) === String(randomId)
                && Number.isSafeInteger(Number(update.id))) {
              finalMessageId = Number(update.id);
              break;
            }
          }
          if (finalMessageId === null) {
            for (const update of updates.updates) {
              const message = update?.message;
              if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage")
                  && message?.pFlags?.out === true
                  && Number.isSafeInteger(Number(message.id))) {
                finalMessageId = Number(message.id);
                break;
              }
            }
          }
        }

        try { await updatesManager.processUpdateMessage(updates); } catch {}

        if (!Number.isSafeInteger(finalMessageId)) {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: null,
            provider_confirmed: false,
            reply_relationship_confirmed: false,
          };
        }

        try {
          // One resolver owns the server/client id translation and proves it by
          // reading the message back; the reply relationship is compared in a
          // single id space so a correct reply is never reported as unconfirmed.
          const OFFSET = 0x100000000;
          const serverPart = (value) => {
            const numeric = Number(value);
            if (!Number.isSafeInteger(numeric)) return null;
            return numeric > OFFSET ? numeric % OFFSET : numeric;
          };
          const resolved = await globalThis.__pcgProvider.clientMessageId(
            managers,
            peerId,
            finalMessageId,
            (candidate) => candidate.message === text,
          );
          const observed = resolved.value === null
            ? null
            : await globalThis.__pcgProvider.readMessage(managers, peerId, resolved.value);
          const textConfirmed = observed?._ === "message" && observed.message === text;
          const relationshipConfirmed = observed?.reply_to?._ === "messageReplyHeader"
            && serverPart(observed.reply_to.reply_to_msg_id) !== null
            && serverPart(observed.reply_to.reply_to_msg_id) === serverPart(sourceMessageId);
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: resolved.value === null ? finalMessageId : resolved.value,
            provider_server_message_id: finalMessageId,
            provider_confirmed: textConfirmed && relationshipConfirmed,
            reply_relationship_confirmed: relationshipConfirmed,
          };
        } catch {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: false,
            reply_relationship_confirmed: false,
          };
        }
      }, {
        peerId: Number(providerRef),
        sourceMessageId,
        randomId,
        text,
      });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_REPLY_PROVIDER_CALL_FAILED");

    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_REPLY_ATTEMPT_CORRELATION_LOST");

    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code)
        ? result.provider_error_code
        : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id)
        ? result.final_message_id
        : null;
    }
    writeRegistry(latest);
    return {
      ...safeRecord(record),
      reply_relationship_confirmed: result.reply_relationship_confirmed === true,
    };
  }

  async function observeReplyText(page, {
    attemptId,
    conversationHandle,
    sourceMessageHandle,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_REPLY_ATTEMPT_INVALID", 256);
    text = boundedText(text);
    if (!validSha256(payloadSha256)) fail("WEB_REPLY_PAYLOAD_DIGEST_INVALID");

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== providerRef) fail("WEB_REPLY_SOURCE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) {
      return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    }

    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256,
      operationKind: "reply_text",
      sourceMessageId: sourceRef.mid,
    };
    if (!sameReservation(record, reservation)) fail("WEB_REPLY_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Number.isSafeInteger(record.final_message_id)) {
      return { ...safeRecord(record), state: "UNKNOWN" };
    }

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid, sourceMessageId, text }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return { confirmed: false, relationship: false };
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
        return { confirmed: false, relationship: false };
      }
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") {
        return { confirmed: false, relationship: false };
      }
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        const relationship = observed?.reply_to?._ === "messageReplyHeader"
          && Number(observed.reply_to.reply_to_msg_id) === sourceMessageId;
        return {
          confirmed: observed?._ === "message"
            && observed.pFlags?.out === true
            && observed.message === text
            && relationship,
          relationship,
        };
      } catch {
        return { confirmed: false, relationship: false };
      }
    }, {
      peerId: Number(providerRef),
      mid: record.final_message_id,
      sourceMessageId: sourceRef.mid,
      text,
    });

    if (!confirmed.confirmed) {
      return {
        ...safeRecord(record),
        state: "UNKNOWN",
        reply_relationship_confirmed: confirmed.relationship === true,
      };
    }
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return {
      ...safeRecord(record),
      state: "SUCCEEDED",
      reply_relationship_confirmed: true,
    };
  }

  async function dispatchAttachment(page, {
    attemptId,
    conversationHandle,
    randomId,
    fileHandle,
    filename,
    mimeType,
    sizeBytes,
    payloadSha256,
    caption,
    captionSha256,
    voiceMessage = false,
    durationSeconds = null,
  }) {
    attemptId = requiredString(attemptId, "WEB_ATTACHMENT_ATTEMPT_INVALID", 256);
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    if (!validSha256(payloadSha256)) fail("WEB_ATTACHMENT_PAYLOAD_DIGEST_INVALID");
    const captionSpec = boundedAttachmentCaption(caption, captionSha256);
    caption = captionSpec.text;
    captionSha256 = captionSpec.sha256;
    voiceMessage = voiceMessage === true;
    if (voiceMessage) {
      if (mimeType !== "audio/ogg" && mimeType !== "audio/opus") fail("WEB_VOICE_MIME_UNSUPPORTED");
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) fail("WEB_VOICE_DURATION_INVALID");
      durationSeconds = Math.max(1, Math.round(durationSeconds));
    }
    if (!validRandomId(randomId)) fail("WEB_ATTACHMENT_RANDOM_ID_INVALID");
    const materialPath = await validateMaterialFile(fileHandle, filename, sizeBytes, payloadSha256);

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const reservation = {
      providerRef,
      randomId,
      payloadSha256,
      operationKind: voiceMessage ? "send_voice" : "send_attachment",
      sourceMessageId: null,
      attachmentFilename: filename,
      attachmentMimeType: mimeType,
      attachmentSizeBytes: sizeBytes,
      attachmentCaptionSha256: captionSha256,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      releaseMaterialFile(materialPath);
      if (!sameReservation(existing, reservation)) fail("WEB_ATTACHMENT_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }

    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: payloadSha256,
      operation_kind: voiceMessage ? "send_voice" : "send_attachment",
      source_message_id: null,
      attachment_filename: filename,
      attachment_mime_type: mimeType,
      attachment_size_bytes: sizeBytes,
      attachment_caption_sha256: captionSha256,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
      provider_error_type: null,
    };
    writeRegistry(registry);

    let result;
    let fileInputId = null;
    try {
      fileInputId = await attachMaterialInput(page, [materialPath]);
      result = await evaluateWithin(page, PROVIDER_UPLOAD_DEADLINE_MS, async ({ peerId, randomId, fileInputId, filename, mimeType, sizeBytes, caption, voiceMessage, durationSeconds }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }
        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const files = managers?.apiFileManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !files || !updatesManager) {
          return { ok: false, error: "WEBK_ATTACHMENT_MANAGER_UNAVAILABLE" };
        }
        for (const [manager, methods] of [
          [api, ["invokeApi"]],
          [peers, ["getInputPeerById"]],
          [messages, ["reloadConversation", "reloadMessage"]],
          [files, ["upload"]],
          [updatesManager, ["processUpdateMessage"]],
        ]) {
          if (methods.some((name) => typeof manager?.[name] !== "function")) {
            return { ok: false, error: "WEBK_ATTACHMENT_PRIMITIVE_UNAVAILABLE" };
          }
        }
        try {
          const dialog = await messages.reloadConversation(peerId, false);
          if (!dialog) return { ok: false, error: "WEBK_ATTACHMENT_TARGET_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_ATTACHMENT_PRECHECK_FAILED" };
        }

        const input = document.getElementById(fileInputId);
        const file = input?.files?.[0];
        if (!(file instanceof File) || file.size !== sizeBytes) {
          return { ok: false, error: "WEBK_ATTACHMENT_FILE_BINDING_INVALID" };
        }

        let inputFile;
        try {
          if (sizeBytes > 128 * 1024 * 1024) {
            const partSize = 512 * 1024;
            const totalParts = Math.ceil(file.size / partSize);
            let fileIdValue = (BigInt(randomId) ^ 0x5a5a5a5a5a5a5a5an) & 0x7fffffffffffffffn;
            if (fileIdValue === 0n) fileIdValue = 1n;
            const fileId = fileIdValue.toString();
            const concurrency = 8;

            for (let basePart = 0; basePart < totalParts; basePart += concurrency) {
              const batch = [];
              for (let part = basePart; part < Math.min(totalParts, basePart + concurrency); part += 1) {
                batch.push((async () => {
                  const start = part * partSize;
                  const end = Math.min(file.size, start + partSize);
                  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
                  const saved = await api.invokeApi("upload.saveBigFilePart", {
                    file_id: fileId,
                    file_part: part,
                    file_total_parts: totalParts,
                    bytes,
                  });
                  if (saved === false || saved?._ === "boolFalse") {
                    const error = new Error("WEBK_BIG_UPLOAD_PART_REJECTED");
                    error.type = "WEBK_BIG_UPLOAD_PART_REJECTED";
                    throw error;
                  }
                })());
              }
              await Promise.all(batch);
            }

            inputFile = {
              _: "inputFileBig",
              id: fileId,
              parts: totalParts,
              name: filename,
            };
          } else {
            inputFile = await files.upload({ file, fileName: filename });
            if (inputFile && typeof inputFile === "object") inputFile.name = filename;
          }
        } catch (err) {
          const providerErrorType = String(err?.type || err?.code || err?.message || "").slice(0, 128) || null;
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            provider_error_type: providerErrorType,
            final_message_id: null,
            provider_confirmed: false,
            attachment_confirmed: false,
          };
        }

        const media = {
          _: "inputMediaUploadedDocument",
          file: inputFile,
          mime_type: mimeType,
          pFlags: voiceMessage ? {} : { force_file: true },
          attributes: voiceMessage
            ? [{ _: "documentAttributeAudio", duration: durationSeconds, pFlags: { voice: true } }]
            : [{ _: "documentAttributeFilename", file_name: filename }],
        };

        let updates;
        try {
          updates = await api.invokeApi("messages.sendMedia", {
            peer: await peers.getInputPeerById(peerId),
            media,
            message: caption,
            random_id: randomId,
            clear_draft: false,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return { ok: true, ack_state: "REJECTED", provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null, final_message_id: null, provider_confirmed: false, attachment_confirmed: false };
        }

        let finalMessageId = null;
        if (updates?._ === "updateShortSentMessage" && Number.isSafeInteger(Number(updates.id))) {
          finalMessageId = Number(updates.id);
        } else if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID" && String(update.random_id) === String(randomId) && Number.isSafeInteger(Number(update.id))) {
              finalMessageId = Number(update.id);
              break;
            }
          }
          if (finalMessageId === null) {
            for (const update of updates.updates) {
              const message = update?.message;
              if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage") && message?.pFlags?.out === true && Number.isSafeInteger(Number(message.id))) {
                finalMessageId = Number(message.id);
                break;
              }
            }
          }
        }
        try { await updatesManager.processUpdateMessage(updates); } catch {}
        if (!Number.isSafeInteger(finalMessageId)) {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: null, provider_confirmed: false, attachment_confirmed: false };
        }
        try {
          const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, finalMessageId);
          const document = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
          const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
          const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
          const audioAttr = attrs.find((attr) => attr?._ === "documentAttributeAudio");
          const voiceConfirmed = voiceMessage === true && audioAttr?.pFlags?.voice === true;
          const attachmentConfirmed = document?._ === "document"
            && document.mime_type === mimeType
            && Number(document.size) === sizeBytes
            && (voiceMessage ? voiceConfirmed : filenameAttr?.file_name === filename);
          const captionConfirmed = observed?._ === "message" && observed.message === caption;
          let selfPeer = false;
          try {
            const self = await managers?.appUsersManager?.getSelf?.();
            selfPeer = Number(self?.id) === peerId;
          } catch {}
          const directionConfirmed = observed?.pFlags?.out === true || selfPeer;
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: observed?._ === "message" && directionConfirmed && attachmentConfirmed && captionConfirmed,
            attachment_confirmed: attachmentConfirmed,
            voice_message_confirmed: voiceConfirmed,
            caption_confirmed: captionConfirmed,
          };
        } catch {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: finalMessageId, provider_confirmed: false, attachment_confirmed: false };
        }
      }, { peerId: Number(providerRef), randomId, fileInputId, filename, mimeType, sizeBytes, caption, voiceMessage, durationSeconds });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    } finally {
      await removeMaterialInput(page, fileInputId);
      releaseMaterialFile(materialPath);
    }

    if (!result?.ok) fail(result?.error || "WEB_ATTACHMENT_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_ATTACHMENT_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
      record.provider_error_type = typeof result.provider_error_type === "string" ? result.provider_error_type : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id) ? result.final_message_id : null;
    }
    writeRegistry(latest);
    return {
      ...safeRecord(record),
      attachment_confirmed: result.attachment_confirmed === true,
      voice_message_confirmed: result.voice_message_confirmed === true,
      caption_confirmed: result.caption_confirmed === true,
    };
  }

  async function observeAttachment(page, {
    attemptId,
    conversationHandle,
    filename,
    mimeType,
    sizeBytes,
    payloadSha256,
    caption,
    captionSha256,
    voiceMessage = false,
    durationSeconds = null,
  }) {
    attemptId = requiredString(attemptId, "WEB_ATTACHMENT_ATTEMPT_INVALID", 256);
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    if (!validSha256(payloadSha256)) fail("WEB_ATTACHMENT_PAYLOAD_DIGEST_INVALID");
    const captionSpec = boundedAttachmentCaption(caption, captionSha256);
    caption = captionSpec.text;
    captionSha256 = captionSpec.sha256;
    voiceMessage = voiceMessage === true;
    if (voiceMessage) {
      if (mimeType !== "audio/ogg" && mimeType !== "audio/opus") fail("WEB_VOICE_MIME_UNSUPPORTED");
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) fail("WEB_VOICE_DURATION_INVALID");
      durationSeconds = Math.max(1, Math.round(durationSeconds));
    }

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };

    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256,
      operationKind: voiceMessage ? "send_voice" : "send_attachment",
      sourceMessageId: null,
      attachmentFilename: filename,
      attachmentMimeType: mimeType,
      attachmentSizeBytes: sizeBytes,
      attachmentCaptionSha256: captionSha256,
    };
    if (!sameReservation(record, reservation)) fail("WEB_ATTACHMENT_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Number.isSafeInteger(record.final_message_id)) return { ...safeRecord(record), state: "UNKNOWN" };

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid, filename, mimeType, sizeBytes, caption, voiceMessage }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") return false;
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        const document = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
        const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
        const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
        const audioAttr = attrs.find((attr) => attr?._ === "documentAttributeAudio");
        let selfPeer = false;
        try {
          const self = await managers?.appUsersManager?.getSelf?.();
          selfPeer = Number(self?.id) === peerId;
        } catch {}
        return observed?._ === "message"
          && (observed.pFlags?.out === true || selfPeer)
          && document?._ === "document"
          && document.mime_type === mimeType
          && Number(document.size) === sizeBytes
          && (voiceMessage ? audioAttr?.pFlags?.voice === true : filenameAttr?.file_name === filename)
          && observed.message === caption;
      } catch {
        return false;
      }
    }, {
      peerId: Number(providerRef),
      mid: record.final_message_id,
      filename,
      mimeType,
      sizeBytes,
      caption,
      voiceMessage,
    });

    if (!confirmed) return { ...safeRecord(record), state: "UNKNOWN", attachment_confirmed: false, caption_confirmed: false };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED", attachment_confirmed: true, voice_message_confirmed: voiceMessage, caption_confirmed: true };
  }

  async function dispatchReplyAttachment(page, {
    attemptId,
    conversationHandle,
    sourceMessageHandle,
    randomId,
    fileHandle,
    filename,
    mimeType,
    sizeBytes,
    payloadSha256,
    caption,
    captionSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_REPLY_ATTACHMENT_ATTEMPT_INVALID", 256);
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    if (!validSha256(payloadSha256)) fail("WEB_REPLY_ATTACHMENT_PAYLOAD_DIGEST_INVALID");
    const captionSpec = boundedAttachmentCaption(caption, captionSha256);
    caption = captionSpec.text;
    captionSha256 = captionSpec.sha256;
    if (!validRandomId(randomId)) fail("WEB_REPLY_ATTACHMENT_RANDOM_ID_INVALID");
    const materialPath = await validateMaterialFile(fileHandle, filename, sizeBytes, payloadSha256);

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== providerRef) {
      releaseMaterialFile(materialPath);
      fail("WEB_REPLY_ATTACHMENT_SOURCE_CONVERSATION_MISMATCH");
    }
    const sourceMessageId = sourceRef.mid;
    const reservation = {
      providerRef,
      randomId,
      payloadSha256,
      operationKind: "reply_attachment",
      sourceMessageId,
      attachmentFilename: filename,
      attachmentMimeType: mimeType,
      attachmentSizeBytes: sizeBytes,
      attachmentCaptionSha256: captionSha256,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      releaseMaterialFile(materialPath);
      if (!sameReservation(existing, reservation)) fail("WEB_REPLY_ATTACHMENT_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }

    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: payloadSha256,
      operation_kind: "reply_attachment",
      source_message_id: sourceMessageId,
      attachment_filename: filename,
      attachment_mime_type: mimeType,
      attachment_size_bytes: sizeBytes,
      attachment_caption_sha256: captionSha256,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    let fileInputId = null;
    try {
      fileInputId = await attachMaterialInput(page, [materialPath]);
      result = await evaluateWithin(page, PROVIDER_UPLOAD_DEADLINE_MS, async ({ peerId, sourceMessageId, randomId, fileInputId, filename, mimeType, sizeBytes, caption }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const files = managers?.apiFileManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !files || !updatesManager) return { ok: false, error: "WEBK_REPLY_ATTACHMENT_MANAGER_UNAVAILABLE" };
        for (const [manager, methods] of [
          [api, ["invokeApi"]],
          [peers, ["getInputPeerById"]],
          [messages, ["reloadConversation", "reloadMessage", "getInputReplyTo"]],
          [files, ["upload"]],
          [updatesManager, ["processUpdateMessage"]],
        ]) {
          if (methods.some((name) => typeof manager?.[name] !== "function")) return { ok: false, error: "WEBK_REPLY_ATTACHMENT_PRIMITIVE_UNAVAILABLE" };
        }
        try {
          const dialog = await messages.reloadConversation(peerId, false);
          if (!dialog) return { ok: false, error: "WEBK_REPLY_ATTACHMENT_TARGET_NOT_FOUND" };
          const source = await globalThis.__pcgProvider.readMessage(managers, peerId, sourceMessageId);
          if (source?._ !== "message") return { ok: false, error: "WEBK_REPLY_ATTACHMENT_SOURCE_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_REPLY_ATTACHMENT_PRECHECK_FAILED" };
        }
        let replyTo;
        try {
          replyTo = await messages.getInputReplyTo({ peerId, replyToMsgId: sourceMessageId });
        } catch {
          return { ok: false, error: "WEBK_REPLY_ATTACHMENT_RELATIONSHIP_UNAVAILABLE" };
        }
        if (!replyTo || replyTo._ !== "inputReplyToMessage" || !Number.isSafeInteger(Number(replyTo.reply_to_msg_id))) {
          return { ok: false, error: "WEBK_REPLY_ATTACHMENT_TYPE_UNSUPPORTED" };
        }
        const input = document.getElementById(fileInputId);
        const file = input?.files?.[0];
        if (!(file instanceof File) || file.size !== sizeBytes) return { ok: false, error: "WEBK_REPLY_ATTACHMENT_FILE_BINDING_INVALID" };

        let inputFile;
        try {
          inputFile = await files.upload({ file, fileName: filename });
          if (inputFile && typeof inputFile === "object") inputFile.name = filename;
        } catch {
          return { ok: true, ack_state: "REJECTED", provider_error_code: null, final_message_id: null, provider_confirmed: false, attachment_confirmed: false, reply_relationship_confirmed: false };
        }
        const media = {
          _: "inputMediaUploadedDocument",
          file: inputFile,
          mime_type: mimeType,
          pFlags: { force_file: true },
          attributes: [{ _: "documentAttributeFilename", file_name: filename }],
        };
        let updates;
        try {
          updates = await api.invokeApi("messages.sendMedia", {
            peer: await peers.getInputPeerById(peerId),
            media,
            message: caption,
            random_id: randomId,
            clear_draft: false,
            reply_to: replyTo,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return { ok: true, ack_state: "REJECTED", provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null, final_message_id: null, provider_confirmed: false, attachment_confirmed: false, reply_relationship_confirmed: false };
        }

        let finalMessageId = null;
        if (updates?._ === "updateShortSentMessage" && Number.isSafeInteger(Number(updates.id))) {
          finalMessageId = Number(updates.id);
        } else if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID" && String(update.random_id) === String(randomId) && Number.isSafeInteger(Number(update.id))) {
              finalMessageId = Number(update.id);
              break;
            }
          }
          if (finalMessageId === null) {
            for (const update of updates.updates) {
              const message = update?.message;
              if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage") && message?.pFlags?.out === true && Number.isSafeInteger(Number(message.id))) {
                finalMessageId = Number(message.id);
                break;
              }
            }
          }
        }
        try { await updatesManager.processUpdateMessage(updates); } catch {}
        if (!Number.isSafeInteger(finalMessageId)) {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: null, provider_confirmed: false, attachment_confirmed: false, reply_relationship_confirmed: false };
        }
        try {
          const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, finalMessageId);
          const document = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
          const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
          const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
          const attachmentConfirmed = document?._ === "document"
            && document.mime_type === mimeType
            && Number(document.size) === sizeBytes
            && filenameAttr?.file_name === filename;
          const replyRelationshipConfirmed = observed?.reply_to?._ === "messageReplyHeader"
            && Number(observed.reply_to.reply_to_msg_id) === sourceMessageId;
          const captionConfirmed = observed?._ === "message" && observed.message === caption;
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: observed?._ === "message" && observed.pFlags?.out === true && attachmentConfirmed && replyRelationshipConfirmed && captionConfirmed,
            attachment_confirmed: attachmentConfirmed,
            reply_relationship_confirmed: replyRelationshipConfirmed,
            caption_confirmed: captionConfirmed,
          };
        } catch {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: finalMessageId, provider_confirmed: false, attachment_confirmed: false, reply_relationship_confirmed: false };
        }
      }, { peerId: Number(providerRef), sourceMessageId, randomId, fileInputId, filename, mimeType, sizeBytes, caption });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    } finally {
      await removeMaterialInput(page, fileInputId);
      releaseMaterialFile(materialPath);
    }

    if (!result?.ok) fail(result?.error || "WEB_REPLY_ATTACHMENT_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_REPLY_ATTACHMENT_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id) ? result.final_message_id : null;
    }
    writeRegistry(latest);
    return {
      ...safeRecord(record),
      attachment_confirmed: result.attachment_confirmed === true,
      reply_relationship_confirmed: result.reply_relationship_confirmed === true,
      caption_confirmed: result.caption_confirmed === true,
    };
  }

  async function observeReplyAttachment(page, {
    attemptId,
    conversationHandle,
    sourceMessageHandle,
    filename,
    mimeType,
    sizeBytes,
    payloadSha256,
    caption,
    captionSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_REPLY_ATTACHMENT_ATTEMPT_INVALID", 256);
    filename = boundedAttachmentFilename(filename);
    mimeType = boundedAttachmentMimeType(mimeType);
    sizeBytes = boundedAttachmentSize(sizeBytes);
    if (!validSha256(payloadSha256)) fail("WEB_REPLY_ATTACHMENT_PAYLOAD_DIGEST_INVALID");
    const captionSpec = boundedAttachmentCaption(caption, captionSha256);
    caption = captionSpec.text;
    captionSha256 = captionSpec.sha256;

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== providerRef) fail("WEB_REPLY_ATTACHMENT_SOURCE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };

    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256,
      operationKind: "reply_attachment",
      sourceMessageId: sourceRef.mid,
      attachmentFilename: filename,
      attachmentMimeType: mimeType,
      attachmentSizeBytes: sizeBytes,
      attachmentCaptionSha256: captionSha256,
    };
    if (!sameReservation(record, reservation)) fail("WEB_REPLY_ATTACHMENT_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Number.isSafeInteger(record.final_message_id)) return { ...safeRecord(record), state: "UNKNOWN" };

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({
      peerId,
      mid,
      sourceMessageId,
      filename,
      mimeType,
      sizeBytes,
      caption,
    }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return { confirmed: false, attachment: false, relationship: false };
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
        return { confirmed: false, attachment: false, relationship: false };
      }
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") {
        return { confirmed: false, attachment: false, relationship: false };
      }
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        const document = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
        const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
        const filenameAttr = attrs.find((attr) => attr?._ === "documentAttributeFilename");
        const attachment = document?._ === "document"
          && document.mime_type === mimeType
          && Number(document.size) === sizeBytes
          && filenameAttr?.file_name === filename;
        const relationship = observed?.reply_to?._ === "messageReplyHeader"
          && Number(observed.reply_to.reply_to_msg_id) === sourceMessageId;
        const captionConfirmed = observed?._ === "message" && observed.message === caption;
        return {
          confirmed: observed?._ === "message" && observed.pFlags?.out === true && attachment && relationship && captionConfirmed,
          attachment,
          relationship,
          caption: captionConfirmed,
        };
      } catch {
        return { confirmed: false, attachment: false, relationship: false };
      }
    }, {
      peerId: Number(providerRef),
      mid: record.final_message_id,
      sourceMessageId: sourceRef.mid,
      filename,
      mimeType,
      sizeBytes,
      caption,
    });

    if (!confirmed.confirmed) {
      return {
        ...safeRecord(record),
        state: "UNKNOWN",
        attachment_confirmed: confirmed.attachment === true,
        reply_relationship_confirmed: confirmed.relationship === true,
        caption_confirmed: confirmed.caption === true,
      };
    }
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return {
      ...safeRecord(record),
      state: "SUCCEEDED",
      attachment_confirmed: true,
      reply_relationship_confirmed: true,
      caption_confirmed: true,
    };
  }

  async function selfEditTarget(page) {
    const target = await selfTarget(page);
    const providerRef = identity.providerRefForHandle(target.conversation_handle);
    const mid = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async (peerId) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.getHistory !== "function"
          || typeof messages.getMessageByPeer !== "function"
          || typeof messages.canEditMessage !== "function") return null;
      let history;
      try {
        history = await globalThis.__pcgProvider.history(managers, peerId, { offsetId: 0, limit: 20 });
      } catch {
        return null;
      }
      for (const rawMid of Array.isArray(history?.history) ? history.history : []) {
        const candidateMid = Number(rawMid);
        if (!Number.isSafeInteger(candidateMid)) continue;
        let message = await messages.getMessageByPeer(peerId, candidateMid);
        if (!message && typeof messages.reloadMessage === "function") {
          try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, candidateMid); } catch {}
        }
        if (message?._ !== "message" || message.media || typeof message.message !== "string" || !message.message) continue;
        try {
          if (await messages.canEditMessage(message, "text")) return candidateMid;
        } catch {}
      }
      return null;
    }, Number(providerRef));
    if (!Number.isSafeInteger(mid)) fail("WEB_EDIT_SELF_TARGET_UNAVAILABLE");
    return {
      conversation_handle: target.conversation_handle,
      message_handle: identity.opaqueMessageHandle(providerRef, mid),
      provider_content_model_visible: false,
    };
  }

  async function checkEditTarget(page, conversationHandle, messageHandle) {
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_EDIT_MESSAGE_CONVERSATION_MISMATCH");
    const result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return { available: false, editable: false };
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
        return { available: false, editable: false };
      }
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadConversation !== "function"
          || typeof messages.reloadMessage !== "function") {
        return { available: false };
      }
      try {
        const dialog = await messages.reloadConversation(peerId, false);
        if (!dialog) return { available: false, editable: false };
        const message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        if (message?._ !== "message" || Number(message.mid) !== mid) {
          return { available: false };
        }
        return { available: true };
      } catch {
        return { available: false, editable: false };
      }
    }, { peerId: Number(providerRef), mid: messageRef.mid });
    if (result?.available !== true) fail("WEB_EDIT_TARGET_NOT_AVAILABLE");
    return {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      target_resolved: true,
      provider_editability_deferred: true,
      provider_content_model_visible: false,
    };
  }

  async function dispatchEditText(page, {
    attemptId,
    conversationHandle,
    messageHandle,
    randomId,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_EDIT_ATTEMPT_INVALID", 256);
    text = boundedEditText(text);
    if (!validSha256(payloadSha256)) fail("WEB_EDIT_PAYLOAD_DIGEST_INVALID");
    if (!validRandomId(randomId)) fail("WEB_EDIT_RANDOM_ID_INVALID");

    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_EDIT_MESSAGE_CONVERSATION_MISMATCH");
    const targetMid = messageRef.mid;
    const reservation = {
      providerRef,
      randomId,
      payloadSha256,
      operationKind: "edit_text",
      sourceMessageId: targetMid,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, reservation)) fail("WEB_EDIT_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }

    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: payloadSha256,
      operation_kind: "edit_text",
      source_message_id: targetMid,
      state: "RESERVED",
      final_message_id: targetMid,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, targetMid, text }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }
        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !updatesManager) {
          return { ok: false, error: "WEBK_EDIT_MANAGER_UNAVAILABLE" };
        }
        for (const [manager, methods] of [
          [api, ["invokeApi"]],
          [peers, ["getInputPeerById"]],
          [messages, ["reloadMessage"]],
          [updatesManager, ["processUpdateMessage"]],
        ]) {
          if (methods.some((name) => typeof manager?.[name] !== "function")) {
            return { ok: false, error: "WEBK_EDIT_PRIMITIVE_UNAVAILABLE" };
          }
        }

        let target;
        try {
          target = await globalThis.__pcgProvider.readMessage(managers, peerId, targetMid);
        } catch {
          return { ok: false, error: "WEBK_EDIT_PRECHECK_FAILED" };
        }
        if (target?._ !== "message" || Number(target.mid) !== targetMid) {
          return { ok: false, error: "WEBK_EDIT_TARGET_NOT_AVAILABLE" };
        }

        let updates;
        try {
          updates = await api.invokeApi("messages.editMessage", {
            peer: await peers.getInputPeerById(peerId),
            id: target.id,
            message: text,
            no_webpage: true,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            provider_confirmed: false,
          };
        }

        try { await updatesManager.processUpdateMessage(updates); } catch {}

        try {
          const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, targetMid);
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            provider_confirmed: observed?._ === "message"
              && observed.message === text
              && Number(observed.mid) === targetMid,
          };
        } catch {
          return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false };
        }
      }, { peerId: Number(providerRef), targetMid, text });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_EDIT_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_EDIT_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code)
        ? result.provider_error_code
        : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observeEditText(page, {
    attemptId,
    conversationHandle,
    messageHandle,
    text,
    payloadSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_EDIT_ATTEMPT_INVALID", 256);
    text = boundedEditText(text);
    if (!validSha256(payloadSha256)) fail("WEB_EDIT_PAYLOAD_DIGEST_INVALID");
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_EDIT_MESSAGE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256,
      operationKind: "edit_text",
      sourceMessageId: messageRef.mid,
    };
    if (!sameReservation(record, reservation)) fail("WEB_EDIT_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid, text }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") return false;
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, peerId, mid);
        return observed?._ === "message" && observed.message === text && Number(observed.mid) === mid;
      } catch {
        return false;
      }
    }, { peerId: Number(providerRef), mid: messageRef.mid, text });

    if (!confirmed) return { ...safeRecord(record), state: "UNKNOWN" };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }


  function exactRelayPurpose(value) {
    if (value !== "TRANSPORT_RELAY") fail("WEB_RELAY_PURPOSE_UNSUPPORTED");
    return value;
  }

  function relayTextDigest(text) {
    if (typeof text !== "string" || !text || text.length > 4096 || text.includes("\u0000")) {
      fail("WEB_RELAY_TEXT_UNSUPPORTED");
    }
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  async function selfRelayTarget(page, expectedText) {
    expectedText = boundedText(expectedText);
    const target = await selfTarget(page);
    const providerRef = identity.providerRefForHandle(target.conversation_handle);
    const result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, expectedText }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.getHistory !== "function"
          || typeof messages.getMessageByPeer !== "function"
          || typeof messages.canForward !== "function") return null;
      let history;
      try {
        history = await globalThis.__pcgProvider.history(managers, peerId, { offsetId: 0, limit: 20 });
      } catch {
        return null;
      }
      for (const rawMid of Array.isArray(history?.history) ? history.history : []) {
        const mid = Number(rawMid);
        if (!Number.isSafeInteger(mid)) continue;
        let message = await messages.getMessageByPeer(peerId, mid);
        if (!message && typeof messages.reloadMessage === "function") {
          try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, mid); } catch {}
        }
        if (message?._ !== "message" || message.message !== expectedText || message.media) continue;
        if (globalThis.__pcgProvider.selfDestructing(message)) continue;
        try {
          if (messages.canForward(message) === true) {
            return { mid, text: message.message };
          }
        } catch {}
      }
      return null;
    }, { peerId: Number(providerRef), expectedText });
    if (!result || !Number.isSafeInteger(result.mid)) fail("WEB_RELAY_SELF_SOURCE_UNAVAILABLE");
    const sourceContentSha256 = relayTextDigest(result.text);
    return {
      source_conversation_handle: target.conversation_handle,
      source_message_handle: identity.opaqueMessageHandle(providerRef, result.mid),
      conversation_handle: target.conversation_handle,
      source_content_sha256: sourceContentSha256,
      provider_content_model_visible: false,
    };
  }

  async function checkRelayTarget(page, sourceConversationHandle, sourceMessageHandle, conversationHandle) {
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_RELAY_SOURCE_CONVERSATION_MISMATCH");
    const result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ sourcePeerId, targetPeerId, sourceMid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadConversation !== "function"
          || typeof messages.reloadMessage !== "function"
          || typeof messages.canForward !== "function") return null;
      try {
        const target = await messages.reloadConversation(targetPeerId, false);
        if (!target) return { source: false, target: false, copyAllowed: false, text: null };
        const source = await globalThis.__pcgProvider.readMessage(managers, sourcePeerId, sourceMid);
        if (source?._ !== "message") return { source: false, target: true, copyAllowed: false, text: null };
        if (source.media) return { source: true, target: true, copyAllowed: false, text: null };
        if (typeof source.message !== "string" || !source.message || source.message.length > 4096 || source.message.includes("\u0000")) {
          return { source: true, target: true, copyAllowed: false, text: null };
        }
        if (globalThis.__pcgProvider.selfDestructing(source)) {
          return { source: true, target: true, copyAllowed: false, text: null };
        }
        return {
          source: true,
          target: true,
          copyAllowed: messages.canForward(source) === true,
          text: source.message,
        };
      } catch {
        return null;
      }
    }, {
      sourcePeerId: Number(sourceProviderRef),
      targetPeerId: Number(providerRef),
      sourceMid: sourceRef.mid,
    });
    if (!result || result.source !== true) fail("WEB_RELAY_SOURCE_NOT_AVAILABLE");
    if (result.target !== true) fail("WEB_RELAY_TARGET_NOT_AVAILABLE");
    if (result.copyAllowed !== true) fail("WEB_RELAY_SOURCE_COPY_FORBIDDEN");
    const sourceContentSha256 = relayTextDigest(result.text);
    return {
      source_conversation_handle: sourceConversationHandle,
      source_message_handle: sourceMessageHandle,
      conversation_handle: conversationHandle,
      source_resolved: true,
      source_copy_allowed: true,
      target_resolved: true,
      source_content_sha256: sourceContentSha256,
      provider_content_model_visible: false,
    };
  }

  async function dispatchRelayText(page, {
    attemptId,
    sourceConversationHandle,
    sourceMessageHandle,
    conversationHandle,
    purpose,
    sourceContentSha256,
    randomId,
  }) {
    attemptId = requiredString(attemptId, "WEB_RELAY_ATTEMPT_INVALID", 256);
    purpose = exactRelayPurpose(purpose);
    if (!validSha256(sourceContentSha256)) fail("WEB_RELAY_SOURCE_DIGEST_INVALID");
    if (!validRandomId(randomId)) fail("WEB_RELAY_RANDOM_ID_INVALID");
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_RELAY_SOURCE_CONVERSATION_MISMATCH");
    const sourceMessageId = sourceRef.mid;

    const sourceSnapshot = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ sourcePeerId, targetPeerId, sourceMid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadConversation !== "function"
          || typeof messages.reloadMessage !== "function"
          || typeof messages.canForward !== "function") return null;
      try {
        const target = await messages.reloadConversation(targetPeerId, false);
        if (!target) return null;
        const source = await globalThis.__pcgProvider.readMessage(managers, sourcePeerId, sourceMid);
        if (source?._ !== "message" || source.media) return null;
        if (typeof source.message !== "string" || !source.message || source.message.length > 4096 || source.message.includes("\u0000")) return null;
        if (globalThis.__pcgProvider.selfDestructing(source)) return null;
        if (messages.canForward(source) !== true) return null;
        return { text: source.message };
      } catch {
        return null;
      }
    }, {
      sourcePeerId: Number(sourceProviderRef),
      targetPeerId: Number(providerRef),
      sourceMid: sourceMessageId,
    });
    if (!sourceSnapshot) fail("WEB_RELAY_SOURCE_NOT_AVAILABLE");
    if (relayTextDigest(sourceSnapshot.text) !== sourceContentSha256) fail("WEB_RELAY_SOURCE_CHANGED");

    const reservation = {
      providerRef,
      sourceProviderRef,
      randomId,
      payloadSha256: null,
      operationKind: "relay_text",
      sourceMessageId,
      relayPurpose: purpose,
      sourceContentSha256,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, reservation)) fail("WEB_RELAY_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }
    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      source_provider_ref: sourceProviderRef,
      random_id: randomId,
      payload_sha256: null,
      operation_kind: "relay_text",
      source_message_id: sourceMessageId,
      relay_purpose: purpose,
      source_content_sha256: sourceContentSha256,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ targetPeerId, randomId, text }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }
        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !updatesManager
            || typeof api.invokeApi !== "function"
            || typeof peers.getInputPeerById !== "function"
            || typeof messages.reloadMessage !== "function"
            || typeof updatesManager.processUpdateMessage !== "function") {
          return { ok: false, error: "WEBK_RELAY_PRIMITIVE_UNAVAILABLE" };
        }

        let updates;
        try {
          updates = await api.invokeApi("messages.sendMessage", {
            peer: await peers.getInputPeerById(targetPeerId),
            message: text,
            random_id: randomId,
            no_webpage: true,
            clear_draft: false,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            final_message_id: null,
            observed_text: null,
            provider_confirmed: false,
          };
        }

        let finalMessageId = null;
        if (updates?._ === "updateShortSentMessage" && Number.isSafeInteger(Number(updates.id))) {
          finalMessageId = Number(updates.id);
        } else if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID"
                && String(update.random_id) === String(randomId)
                && Number.isSafeInteger(Number(update.id))) {
              finalMessageId = Number(update.id);
              break;
            }
          }
          if (finalMessageId === null) {
            for (const update of updates.updates) {
              const message = update?.message;
              if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage")
                  && message?.pFlags?.out === true
                  && Number.isSafeInteger(Number(message.id))) {
                finalMessageId = Number(message.id);
                break;
              }
            }
          }
        }
        try { await updatesManager.processUpdateMessage(updates); } catch {}

        if (!Number.isSafeInteger(finalMessageId)) {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: null, observed_text: null, provider_confirmed: false };
        }
        try {
          const observed = await globalThis.__pcgProvider.readMessage(managers, targetPeerId, finalMessageId);
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            observed_text: observed?._ === "message" && observed.pFlags?.out === true && !observed.fwd_from
              ? observed.message
              : null,
            provider_confirmed: false,
          };
        } catch {
          return { ok: true, ack_state: "ACKNOWLEDGED", final_message_id: finalMessageId, observed_text: null, provider_confirmed: false };
        }
      }, {
        targetPeerId: Number(providerRef),
        randomId,
        text: sourceSnapshot.text,
      });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_RELAY_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_RELAY_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      const confirmed = typeof result.observed_text === "string"
        && relayTextDigest(result.observed_text) === sourceContentSha256;
      record.state = confirmed ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id) ? result.final_message_id : null;
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observeRelayText(page, {
    attemptId,
    sourceConversationHandle,
    sourceMessageHandle,
    conversationHandle,
    purpose,
    sourceContentSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_RELAY_ATTEMPT_INVALID", 256);
    purpose = exactRelayPurpose(purpose);
    if (!validSha256(sourceContentSha256)) fail("WEB_RELAY_SOURCE_DIGEST_INVALID");
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_RELAY_SOURCE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    const reservation = {
      providerRef,
      sourceProviderRef,
      randomId: record.random_id,
      payloadSha256: null,
      operationKind: "relay_text",
      sourceMessageId: sourceRef.mid,
      relayPurpose: purpose,
      sourceContentSha256,
    };
    if (!sameReservation(record, reservation)) fail("WEB_RELAY_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Number.isSafeInteger(record.final_message_id)) return { ...safeRecord(record), state: "UNKNOWN" };

    const observedText = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ targetPeerId, finalMid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") return null;
      try {
        const observed = await globalThis.__pcgProvider.readMessage(managers, targetPeerId, finalMid);
        if (observed?._ !== "message" || observed.pFlags?.out !== true || observed.fwd_from) return null;
        return observed.message;
      } catch {
        return null;
      }
    }, {
      targetPeerId: Number(providerRef),
      finalMid: record.final_message_id,
    });
    if (typeof observedText !== "string" || relayTextDigest(observedText) !== sourceContentSha256) {
      return { ...safeRecord(record), state: "UNKNOWN" };
    }
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }

  async function selfForwardTarget(page, expectedText) {
    expectedText = boundedText(expectedText);
    const target = await selfTarget(page);
    const providerRef = identity.providerRefForHandle(target.conversation_handle);
    const mid = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, expectedText }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      const peers = managers?.appPeersManager;
      if (!messages || !peers || typeof messages.getHistory !== "function"
          || typeof messages.getMessageByPeer !== "function"
          || typeof messages.canForward !== "function") return null;
      let history;
      try {
        history = await globalThis.__pcgProvider.history(managers, peerId, { offsetId: 0, limit: 20 });
      } catch {
        return null;
      }
      for (const rawMid of Array.isArray(history?.history) ? history.history : []) {
        const candidateMid = Number(rawMid);
        if (!Number.isSafeInteger(candidateMid)) continue;
        let message = await messages.getMessageByPeer(peerId, candidateMid);
        if (!message && typeof messages.reloadMessage === "function") {
          try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, candidateMid); } catch {}
        }
        if (message?._ !== "message" || message.message !== expectedText) continue;
        if (typeof messages.isEphemeralMessage === "function") {
          if (globalThis.__pcgProvider.selfDestructing(message)) continue;
        }
        try {
          const locallyForwardable = messages.canForward(message) === true;
          const selfSourceAllowed = peerId === Number(peers.peerId)
            && message.pFlags?.noforwards !== true
            && message.media?.ttl_seconds == null
            && message.media?.photo?.ttl_seconds == null;
          if (locallyForwardable || selfSourceAllowed) return candidateMid;
        } catch {}
      }
      return null;
    }, { peerId: Number(providerRef), expectedText });
    if (!Number.isSafeInteger(mid)) fail("WEB_FORWARD_SELF_SOURCE_UNAVAILABLE");
    return {
      source_conversation_handle: target.conversation_handle,
      source_message_handle: identity.opaqueMessageHandle(providerRef, mid),
      conversation_handle: target.conversation_handle,
      provider_content_model_visible: false,
    };
  }

  async function checkForwardTarget(page, sourceConversationHandle, sourceMessageHandle, conversationHandle) {
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const targetProviderRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_FORWARD_SOURCE_CONVERSATION_MISMATCH");
    const result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ sourcePeerId, targetPeerId, sourceMid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return { source: false, target: false, forwardable: false };
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
        return { source: false, target: false, forwardable: false };
      }
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages
          || typeof messages.reloadConversation !== "function"
          || typeof messages.reloadMessage !== "function"
          || typeof messages.forwardMessages !== "function") {
        return { source: false, target: false, forwardable: false };
      }
      try {
        const target = await messages.reloadConversation(targetPeerId, false);
        if (!target) return { source: false, target: false, forwardable: false };
        const source = await globalThis.__pcgProvider.readMessage(managers, sourcePeerId, sourceMid);
        if (source?._ !== "message") return { source: false, target: true, forwardable: false };
        return {
          source: true,
          target: true,
          forwardable: true,
          webk_native_forward_available: true,
        };
      } catch {
        return { source: false, target: false, forwardable: false };
      }
    }, {
      sourcePeerId: Number(sourceProviderRef),
      targetPeerId: Number(targetProviderRef),
      sourceMid: sourceRef.mid,
    });
    if (result?.source !== true) fail("WEB_FORWARD_SOURCE_NOT_AVAILABLE");
    if (result?.target !== true) fail("WEB_FORWARD_TARGET_NOT_AVAILABLE");
    if (result?.forwardable !== true) fail("WEB_FORWARD_SOURCE_NOT_FORWARDABLE");
    return {
      source_conversation_handle: sourceConversationHandle,
      source_message_handle: sourceMessageHandle,
      conversation_handle: conversationHandle,
      source_resolved: true,
      source_forwardable: true,
      target_resolved: true,
      webk_native_forward_available: true,
      provider_content_model_visible: false,
    };
  }

  async function dispatchForwardNative(page, {
    attemptId,
    sourceConversationHandle,
    sourceMessageHandle,
    conversationHandle,
    randomId,
  }) {
    attemptId = requiredString(attemptId, "WEB_FORWARD_ATTEMPT_INVALID", 256);
    if (!validRandomId(randomId)) fail("WEB_FORWARD_RANDOM_ID_INVALID");
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_FORWARD_SOURCE_CONVERSATION_MISMATCH");
    const sourceMessageId = sourceRef.mid;
    const reservation = {
      providerRef,
      sourceProviderRef,
      randomId,
      payloadSha256: null,
      operationKind: "forward_native",
      sourceMessageId,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, reservation)) fail("WEB_FORWARD_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }
    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      source_provider_ref: sourceProviderRef,
      random_id: randomId,
      payload_sha256: null,
      operation_kind: "forward_native",
      source_message_id: sourceMessageId,
      state: "RESERVED",
      final_message_id: null,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      await ensureProviderModel(page);
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ sourcePeerId, targetPeerId, sourceMid, randomId }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }
        const managers = create(accountNumber);
        const messages = managers?.appMessagesManager;
        const ids = managers?.appMessagesIdsManager;
        const users = managers?.appUsersManager;
        if (!messages || !ids
            || typeof messages.reloadConversation !== "function"
            || typeof messages.reloadMessage !== "function"
            || typeof messages.forwardMessages !== "function"
            || typeof messages.generateOutgoingMessage !== "function"
            || typeof messages.finalizePendingMessage !== "function"
            || !ids) {
          return { ok: false, error: "WEBK_FORWARD_PRIMITIVE_UNAVAILABLE" };
        }

        let source;
        try {
          const target = await messages.reloadConversation(targetPeerId, false);
          if (!target) return { ok: false, error: "WEBK_FORWARD_TARGET_NOT_FOUND" };
          source = await globalThis.__pcgProvider.readMessage(managers, sourcePeerId, sourceMid);
          if (source?._ !== "message") return { ok: false, error: "WEBK_FORWARD_SOURCE_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_FORWARD_PRECHECK_FAILED" };
        }

        const originalGenerate = messages.generateOutgoingMessage;
        const originalFinalize = messages.finalizePendingMessage;
        const hadOwnGenerate = Object.prototype.hasOwnProperty.call(messages, "generateOutgoingMessage");
        const hadOwnFinalize = Object.prototype.hasOwnProperty.call(messages, "finalizePendingMessage");
        let injected = false;
        let generatedForTarget = 0;
        let capturedFinalMid = null;

        messages.generateOutgoingMessage = function(peerId, options) {
          const message = originalGenerate.call(messages, peerId, options);
          if (Number(peerId) === Number(targetPeerId)) {
            generatedForTarget += 1;
            if (!injected && message?._ === "message") {
              message.random_id = randomId;
              injected = true;
            }
          }
          return message;
        };
        messages.finalizePendingMessage = function(candidateRandomId, finalMessage) {
          if (String(candidateRandomId) === String(randomId)
              && Number.isSafeInteger(Number(finalMessage?.mid))) {
            capturedFinalMid = Number(finalMessage.mid);
          }
          return originalFinalize.call(messages, candidateRandomId, finalMessage);
        };

        let providerErrorCode = null;
        // Identity of the forwarded result must not depend on our monkey patch
        // alone: record the target history first so a new message can be
        // identified by content afterwards.
        const existingMids = new Set();
        try {
          const before = await globalThis.__pcgProvider.history(managers, targetPeerId, { offsetId: 0, limit: 20 });
          for (const raw of (Array.isArray(before?.history) ? before.history : [])) {
            const mid = Number(raw);
            if (Number.isSafeInteger(mid)) existingMids.add(mid);
          }
        } catch {}
        try {
          await messages.forwardMessages({
            peerId: targetPeerId,
            fromPeerId: sourcePeerId,
            mids: [sourceMid],
            dropAuthor: false,
            dropCaptions: false,
          });
        } catch (err) {
          const rawCode = Number(err?.code);
          providerErrorCode = Number.isSafeInteger(rawCode) ? rawCode : null;
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: providerErrorCode,
            final_message_id: null,
            provider_confirmed: false,
          };
        } finally {
          if (hadOwnGenerate) messages.generateOutgoingMessage = originalGenerate;
          else delete messages.generateOutgoingMessage;
          if (hadOwnFinalize) messages.finalizePendingMessage = originalFinalize;
          else delete messages.finalizePendingMessage;
        }

        // The provider call resolved, so an effect may exist even when our
        // instrumentation saw nothing. Identify the result by content instead
        // of declaring a rejection we cannot prove.
        if (!Number.isSafeInteger(capturedFinalMid)) {
          try {
            const after = await globalThis.__pcgProvider.history(managers, targetPeerId, { offsetId: 0, limit: 20 });
            for (const raw of (Array.isArray(after?.history) ? after.history : [])) {
              const mid = Number(raw);
              if (!Number.isSafeInteger(mid) || existingMids.has(mid)) continue;
              const candidate = await globalThis.__pcgProvider.readMessage(managers, targetPeerId, mid);
              if (candidate?._ === "message" && candidate.message === source.message) {
                capturedFinalMid = mid;
                break;
              }
            }
          } catch {}
        }
        if (!Number.isSafeInteger(capturedFinalMid)) {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: null,
            provider_confirmed: false,
          };
        }

        // Awaited through the proven provider model: manager methods are
        // asynchronous proxies, so an un-awaited call yields a Promise and
        // silently defeats every check downstream.
        const finalResolved = await globalThis.__pcgProvider.serverMessageId(ids, capturedFinalMid, null);
        const finalMessageId = finalResolved.ok ? finalResolved.value : NaN;
        if (!Number.isSafeInteger(finalMessageId) || finalMessageId <= 0) {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: null,
            provider_confirmed: false,
          };
        }

        try {
          const observed = await globalThis.__pcgProvider.readMessage(managers, targetPeerId, capturedFinalMid);
          let targetIsSelf = false;
          if (users && typeof users.getSelf === "function") {
            try {
              const self = await globalThis.__pcgProvider.callWithin(3000, users, "getSelf");
              targetIsSelf = Number(self?.id) === Number(targetPeerId);
            } catch {}
          }
          const sourceDocument = source.media?._ === "messageMediaDocument" ? source.media.document : null;
          const observedDocument = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
          const documentConfirmed = sourceDocument?._ === "document"
            ? observedDocument?._ === "document" && String(observedDocument.id) === String(sourceDocument.id)
            : true;
          const sourcePhoto = source.media?._ === "messageMediaPhoto" ? source.media.photo : null;
          const observedPhoto = observed?.media?._ === "messageMediaPhoto" ? observed.media.photo : null;
          const photoConfirmed = sourcePhoto?._ === "photo"
            ? observedPhoto?._ === "photo" && String(observedPhoto.id) === String(sourcePhoto.id)
            : true;
          const contentConfirmed = observed?._ === "message"
            && (observed.pFlags?.out === true || targetIsSelf)
            && observed.message === source.message
            && documentConfirmed
            && photoConfirmed;
          // Saved Messages is a self-target: WebK can represent its messages
          // with out=false and Telegram may omit a visible fwd_from header for
          // self-to-self native forwarding. The dispatch path itself is the
          // native forward primitive, and the correlated new target message is
          // authoritative proof in that one exact case.
          const provenancePreserved = !!observed?.fwd_from || source.pFlags?.out === true || targetIsSelf;
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: contentConfirmed && provenancePreserved,
          };
        } catch {
          return {
            ok: true,
            ack_state: "ACKNOWLEDGED",
            final_message_id: finalMessageId,
            provider_confirmed: false,
          };
        }
      }, {
        sourcePeerId: Number(sourceProviderRef),
        targetPeerId: Number(providerRef),
        sourceMid: sourceMessageId,
        randomId,
      });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_FORWARD_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_FORWARD_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_id = Number.isSafeInteger(result.final_message_id) ? result.final_message_id : null;
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observeForwardNative(page, {
    attemptId,
    sourceConversationHandle,
    sourceMessageHandle,
    conversationHandle,
  }) {
    attemptId = requiredString(attemptId, "WEB_FORWARD_ATTEMPT_INVALID", 256);
    const sourceProviderRef = identity.providerRefForHandle(sourceConversationHandle);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const sourceRef = identity.providerMessageRefForHandle(sourceMessageHandle);
    if (sourceRef.providerRef !== sourceProviderRef) fail("WEB_FORWARD_SOURCE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    const reservation = {
      providerRef,
      sourceProviderRef,
      randomId: record.random_id,
      payloadSha256: null,
      operationKind: "forward_native",
      sourceMessageId: sourceRef.mid,
    };
    if (!sameReservation(record, reservation)) fail("WEB_FORWARD_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Number.isSafeInteger(record.final_message_id)) return { ...safeRecord(record), state: "UNKNOWN" };

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ sourcePeerId, targetPeerId, sourceMid, finalMid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      const users = managers?.appUsersManager;
      if (!messages || typeof messages.reloadMessage !== "function") return false;
      try {
        const source = await globalThis.__pcgProvider.readMessage(managers, sourcePeerId, sourceMid);
        const observed = await globalThis.__pcgProvider.readMessage(managers, targetPeerId, finalMid);
        const sourceDocument = source?.media?._ === "messageMediaDocument" ? source.media.document : null;
        const observedDocument = observed?.media?._ === "messageMediaDocument" ? observed.media.document : null;
        const documentConfirmed = sourceDocument?._ === "document"
          ? observedDocument?._ === "document" && String(observedDocument.id) === String(sourceDocument.id)
          : true;
        const sourcePhoto = source?.media?._ === "messageMediaPhoto" ? source.media.photo : null;
        const observedPhoto = observed?.media?._ === "messageMediaPhoto" ? observed.media.photo : null;
        const photoConfirmed = sourcePhoto?._ === "photo"
          ? observedPhoto?._ === "photo" && String(observedPhoto.id) === String(sourcePhoto.id)
          : true;
        let targetIsSelf = false;
        if (users && typeof users.getSelf === "function") {
          try {
            const self = await globalThis.__pcgProvider.callWithin(3000, users, "getSelf");
            targetIsSelf = Number(self?.id) === Number(targetPeerId);
          } catch {}
        }
        return source?._ === "message"
          && observed?._ === "message"
          && (observed.pFlags?.out === true || targetIsSelf)
          && observed.message === source.message
          && documentConfirmed
          && photoConfirmed
          && (!!observed.fwd_from || source.pFlags?.out === true || targetIsSelf);
      } catch {
        return false;
      }
    }, {
      sourcePeerId: Number(sourceProviderRef),
      targetPeerId: Number(providerRef),
      sourceMid: sourceRef.mid,
      finalMid: record.final_message_id,
    });

    if (confirmed !== true) return { ...safeRecord(record), state: "UNKNOWN" };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }

  function boundedPhotoAlbumItems(items) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 4) fail("WEB_PHOTO_ALBUM_ITEMS_INVALID");
    let aggregate = 0;
    return items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) fail("WEB_PHOTO_ALBUM_ITEM_INVALID");
      const filename = boundedAttachmentFilename(item.filename);
      const mimeType = boundedAttachmentMimeType(item.mimeType);
      if (mimeType !== "image/jpeg" && mimeType !== "image/png") fail("WEB_PHOTO_ALBUM_MIME_UNSUPPORTED");
      const sizeBytes = boundedAttachmentSize(item.sizeBytes);
      if (sizeBytes > 4 * 1024 * 1024) fail("WEB_PHOTO_ALBUM_ITEM_TOO_LARGE");
      if (!validSha256(item.payloadSha256)) fail("WEB_PHOTO_ALBUM_DIGEST_INVALID");
      materialFileToken(item.fileHandle);
      aggregate += sizeBytes;
      return {
        fileHandle: item.fileHandle,
        filename,
        mimeType,
        sizeBytes,
        payloadSha256: item.payloadSha256,
      };
    }).map((item, index, all) => {
      if (index === all.length - 1 && aggregate > 8 * 1024 * 1024) fail("WEB_PHOTO_ALBUM_AGGREGATE_TOO_LARGE");
      return item;
    });
  }

  function photoAlbumDigest(items, captionSha256) {
    const raw = items.map((item) => item.payloadSha256).join("|") + "|" + (captionSha256 || "");
    return createHash("sha256").update(raw, "utf8").digest("hex");
  }

  function albumRandomId(baseRandomId, index) {
    const max = (1n << 63n) - 1n;
    const base = BigInt(baseRandomId);
    const value = ((base + BigInt(index + 1)) % max) || 1n;
    return value.toString();
  }

  async function dispatchPhotoAlbum(page, {
    attemptId,
    conversationHandle,
    randomId,
    items,
    caption,
    captionSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_PHOTO_ALBUM_ATTEMPT_INVALID", 256);
    if (!validRandomId(randomId)) fail("WEB_PHOTO_ALBUM_RANDOM_ID_INVALID");
    const boundedItems = boundedPhotoAlbumItems(items);
    const captionBound = boundedAttachmentCaption(caption, captionSha256);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const albumDigest = photoAlbumDigest(boundedItems, captionBound.sha256);
    const materialPaths = [];
    try {
      for (const item of boundedItems) {
        materialPaths.push(await validateMaterialFile(item.fileHandle, item.filename, item.sizeBytes, item.payloadSha256));
      }
    } catch (err) {
      for (const item of boundedItems) {
        try { releaseMaterialFile(materialFilePath(item.fileHandle, item.filename)); } catch {}
      }
      throw err;
    }
    const reservation = {
      providerRef,
      randomId,
      payloadSha256: null,
      operationKind: "send_photo_album",
      albumDigest,
      albumItemCount: boundedItems.length,
      attachmentCaptionSha256: captionBound.sha256,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      for (const candidate of materialPaths) releaseMaterialFile(candidate);
      if (!sameReservation(existing, reservation)) fail("WEB_PHOTO_ALBUM_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }
    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: null,
      operation_kind: "send_photo_album",
      source_message_id: null,
      album_digest: albumDigest,
      album_item_count: boundedItems.length,
      attachment_caption_sha256: captionBound.sha256,
      state: "RESERVED",
      final_message_id: null,
      final_message_ids: [],
      album_photo_ids: [],
      provider_error_code: null,
    };
    writeRegistry(registry);

    const pageItems = boundedItems.map((item, index) => ({
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      randomId: albumRandomId(randomId, index),
    }));

    let result;
    let fileInputId = null;
    try {
      fileInputId = await attachMaterialInput(page, materialPaths);
      result = await evaluateWithin(page, PROVIDER_UPLOAD_DEADLINE_MS, async ({ peerId, items, caption, fileInputId }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        const managers = create(accountNumber);
        const api = managers?.apiManager;
        const peers = managers?.appPeersManager;
        const messages = managers?.appMessagesManager;
        const files = managers?.apiFileManager;
        const updatesManager = managers?.apiUpdatesManager;
        if (!api || !peers || !messages || !files || !updatesManager
            || typeof api.invokeApi !== "function"
            || typeof peers.getInputPeerById !== "function"
            || typeof messages.reloadConversation !== "function"
            || typeof messages.reloadMessage !== "function"
            || typeof files.upload !== "function"
            || typeof updatesManager.processUpdateMessage !== "function") {
          return { ok: false, error: "WEBK_PHOTO_ALBUM_PRIMITIVE_UNAVAILABLE" };
        }
        try {
          const dialog = await messages.reloadConversation(peerId, false);
          if (!dialog) return { ok: false, error: "WEBK_PHOTO_ALBUM_TARGET_NOT_FOUND" };
        } catch {
          return { ok: false, error: "WEBK_PHOTO_ALBUM_PRECHECK_FAILED" };
        }

        const input = document.getElementById(fileInputId);
        const selectedFiles = Array.from(input?.files || []);
        if (selectedFiles.length !== items.length) return { ok: false, error: "WEBK_PHOTO_ALBUM_FILE_BINDING_INVALID" };
        const inputPeer = await peers.getInputPeerById(peerId);
        const photoIds = [];
        const multiMedia = [];
        try {
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const file = selectedFiles[index];
            if (!(file instanceof File) || file.size !== item.sizeBytes) return { ok: false, error: "WEBK_PHOTO_ALBUM_SIZE_MISMATCH" };
            const inputFile = await files.upload({ file, fileName: item.filename });
            const uploaded = { _: "inputMediaUploadedPhoto", file: inputFile, pFlags: {} };
            const media = await api.invokeApi("messages.uploadMedia", { peer: inputPeer, media: uploaded });
            if (media?._ !== "messageMediaPhoto" || media.photo?._ !== "photo") return { ok: false, error: "WEBK_PHOTO_ALBUM_UPLOAD_RESULT_INVALID" };
            const photo = media.photo;
            photoIds.push(String(photo.id));
            multiMedia.push({
              _: "inputSingleMedia",
              media: {
                _: "inputMediaPhoto",
                id: { _: "inputPhoto", id: photo.id, access_hash: photo.access_hash, file_reference: photo.file_reference },
                pFlags: {},
              },
              random_id: item.randomId,
              message: index === 0 ? caption : "",
            });
          }
        } catch {
          return { ok: true, ack_state: "REJECTED", provider_confirmed: false, final_message_ids: [], photo_ids: [] };
        }

        let updates;
        try {
          updates = await api.invokeApi("messages.sendMultiMedia", { peer: inputPeer, multi_media: multiMedia, clear_draft: false });
        } catch (err) {
          const rawCode = Number(err?.code);
          return { ok: true, ack_state: "REJECTED", provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null, provider_confirmed: false, final_message_ids: [], photo_ids: photoIds };
        }
        try { await updatesManager.processUpdateMessage(updates); } catch {}

        const byRandom = new Map();
        const outgoing = [];
        if (Array.isArray(updates?.updates)) {
          for (const update of updates.updates) {
            if (update?._ === "updateMessageID" && Number.isSafeInteger(Number(update.id))) byRandom.set(String(update.random_id), Number(update.id));
            const message = update?.message;
            if ((update?._ === "updateNewMessage" || update?._ === "updateNewChannelMessage") && message?._ === "message" && message.pFlags?.out === true) outgoing.push(message);
          }
        }
        const finalIds = multiMedia.map((item) => byRandom.get(String(item.random_id)) ?? null);
        if (finalIds.some((id) => !Number.isSafeInteger(id)) && outgoing.length === items.length) {
          outgoing.sort((a, b) => Number(a.id) - Number(b.id));
          for (let index = 0; index < finalIds.length; index += 1) finalIds[index] = Number(outgoing[index].id);
        }
        if (finalIds.some((id) => !Number.isSafeInteger(id))) return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false, final_message_ids: [], photo_ids: photoIds };

        const observed = [];
        for (const mid of finalIds) {
          try { observed.push(await globalThis.__pcgProvider.readMessage(managers, peerId, mid)); }
          catch { return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false, final_message_ids: finalIds, photo_ids: photoIds }; }
        }
        const grouped = observed.map((message) => message?.grouped_id ? String(message.grouped_id) : null);
        const observedPhotoIds = observed.map((message) =>
          message?._ === "message" && message.media?._ === "messageMediaPhoto" && message.media.photo?._ === "photo"
            ? String(message.media.photo.id)
            : null
        );
        const confirmed = observed.length === items.length
          && observed.every((message) => message?._ === "message" && message.pFlags?.out === true)
          && grouped[0] !== null
          && grouped.every((value) => value === grouped[0])
          && observedPhotoIds.every((value, index) => value === photoIds[index])
          && observed[0].message === caption
          && observed.slice(1).every((message) => message.message === "");
        return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: confirmed, final_message_ids: finalIds, photo_ids: photoIds };
      }, { peerId: Number(providerRef), items: pageItems, caption: captionBound.text, fileInputId });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    } finally {
      await removeMaterialInput(page, fileInputId);
      for (const candidate of materialPaths) releaseMaterialFile(candidate);
    }

    if (!result?.ok) fail(result?.error || "WEB_PHOTO_ALBUM_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_PHOTO_ALBUM_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
      record.final_message_ids = Array.isArray(result.final_message_ids) ? result.final_message_ids.filter(Number.isSafeInteger) : [];
      record.album_photo_ids = Array.isArray(result.photo_ids) ? result.photo_ids.filter((value) => typeof value === "string") : [];
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observePhotoAlbum(page, {
    attemptId,
    conversationHandle,
    itemSha256s,
    caption,
    captionSha256,
  }) {
    attemptId = requiredString(attemptId, "WEB_PHOTO_ALBUM_ATTEMPT_INVALID", 256);
    if (!Array.isArray(itemSha256s) || itemSha256s.length < 2 || itemSha256s.length > 4
        || itemSha256s.some((value) => !validSha256(value))) {
      fail("WEB_PHOTO_ALBUM_DIGESTS_INVALID");
    }
    const captionBound = boundedAttachmentCaption(caption, captionSha256);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const albumDigest = createHash("sha256")
      .update(itemSha256s.join("|") + "|" + (captionBound.sha256 || ""), "utf8").digest("hex");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256: null,
      operationKind: "send_photo_album",
      albumDigest,
      albumItemCount: itemSha256s.length,
      attachmentCaptionSha256: captionBound.sha256,
    };
    if (!sameReservation(record, reservation)) fail("WEB_PHOTO_ALBUM_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };
    if (!Array.isArray(record.final_message_ids) || record.final_message_ids.length !== itemSha256s.length
        || !Array.isArray(record.album_photo_ids) || record.album_photo_ids.length !== itemSha256s.length) {
      return { ...safeRecord(record), state: "UNKNOWN" };
    }

    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mids, photoIds, caption }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return false;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return false;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.reloadMessage !== "function") return false;
      const observed = [];
      for (const mid of mids) {
        try { observed.push(await globalThis.__pcgProvider.readMessage(managers, peerId, mid)); }
        catch { return false; }
      }
      const grouped = observed.map((message) => message?.grouped_id ? String(message.grouped_id) : null);
      const observedPhotoIds = observed.map((message) =>
        message?._ === "message" && message.media?._ === "messageMediaPhoto" && message.media.photo?._ === "photo"
          ? String(message.media.photo.id)
          : null
      );
      return observed.length === mids.length
        && observed.every((message) => message?._ === "message" && message.pFlags?.out === true)
        && grouped[0] !== null
        && grouped.every((value) => value === grouped[0])
        && observedPhotoIds.every((value, index) => value === photoIds[index])
        && observed[0].message === caption
        && observed.slice(1).every((message) => message.message === "");
    }, {
      peerId: Number(providerRef),
      mids: record.final_message_ids,
      photoIds: record.album_photo_ids,
      caption: captionBound.text,
    });
    if (confirmed !== true) return { ...safeRecord(record), state: "UNKNOWN" };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }

  function exactDeleteScope(value) {
    if (value !== "SELF_ONLY" && value !== "FOR_EVERYONE") fail("WEB_DELETE_SCOPE_UNSUPPORTED");
    return value;
  }

  async function selfDeleteTarget(page, expectedText) {
    expectedText = boundedText(expectedText);
    const target = await selfTarget(page);
    const providerRef = identity.providerRefForHandle(target.conversation_handle);
    const mid = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, expectedText }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      if (!messages || typeof messages.getHistory !== "function"
          || typeof messages.getMessageByPeer !== "function"
          || typeof messages.canDeleteMessage !== "function") return null;
      let history;
      try {
        history = await globalThis.__pcgProvider.history(managers, peerId, { offsetId: 0, limit: 20 });
      } catch {
        return null;
      }
      for (const rawMid of Array.isArray(history?.history) ? history.history : []) {
        const candidateMid = Number(rawMid);
        if (!Number.isSafeInteger(candidateMid)) continue;
        let message = await messages.getMessageByPeer(peerId, candidateMid);
        if (!message && typeof messages.reloadMessage === "function") {
          try { message = await globalThis.__pcgProvider.readMessage(managers, peerId, candidateMid); } catch {}
        }
        if (message?._ !== "message" || message.message !== expectedText) continue;
        if (typeof messages.isEphemeralMessage === "function") {
          if (globalThis.__pcgProvider.selfDestructing(message)) continue;
        }
        try {
          if (messages.canDeleteMessage(message) === true) return candidateMid;
        } catch {}
      }
      return null;
    }, { peerId: Number(providerRef), expectedText });
    if (!Number.isSafeInteger(mid)) fail("WEB_DELETE_SELF_TARGET_UNAVAILABLE");
    return {
      conversation_handle: target.conversation_handle,
      message_handle: identity.opaqueMessageHandle(providerRef, mid),
      deletion_scope: "SELF_ONLY",
      provider_content_model_visible: false,
    };
  }

  async function checkDeleteTarget(page, conversationHandle, messageHandle, scope) {
    scope = exactDeleteScope(scope);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_DELETE_MESSAGE_CONVERSATION_MISMATCH");
    const result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, mid, scope }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return { available: false, deletable: false, scopeAllowed: false };
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
        return { available: false, deletable: false, scopeAllowed: false };
      }
      const managers = create(accountNumber);
      const messages = managers?.appMessagesManager;
      const peers = managers?.appPeersManager;
      const users = managers?.appUsersManager;
      if (!messages || !peers || !users
          || typeof messages.reloadConversation !== "function"
          || typeof messages.reloadMessage !== "function"
          || typeof messages.canDeleteMessage !== "function"
          || typeof peers.isChannel !== "function"
          || typeof users.getSelf !== "function") {
        return { available: false, deletable: false, scopeAllowed: false };
      }
      try {
        // Every one of these manager methods is an asynchronous proxy, and the
        // self-destruct property is a field of the message itself. Reading them
        // without awaiting turned a plain message into an undeletable one, and
        // forcing a network re-read of a message we had just listed is what
        // left the call hanging. Bounded, awaited, cache-first.
        const provider = globalThis.__pcgProvider;
        const dialog = await provider.callWithin(8000, messages, "reloadConversation", peerId, false);
        if (!dialog) return { available: false, deletable: false, scopeAllowed: false };
        const message = await provider.callWithin(8000, messages, "reloadMessage", peerId, mid, false);
        if (message?._ !== "message") return { available: false, deletable: false, scopeAllowed: false };
        if (provider.selfDestructing(message)) {
          return { available: true, deletable: false, scopeAllowed: false };
        }
        const deletable = (await provider.callWithin(8000, messages, "canDeleteMessage", message)) === true;
        if (!deletable) return { available: true, deletable: false, scopeAllowed: false };
        if (scope === "SELF_ONLY") {
          return { available: true, deletable: true, scopeAllowed: true };
        }
        const self = await provider.callWithin(8000, users, "getSelf");
        const selfId = Number(self?.id);
        const isSelfPeer = Number.isSafeInteger(selfId) && selfId === peerId;
        const isChannel = (await provider.callWithin(8000, peers, "isChannel", peerId)) === true;
        const outgoing = message.pFlags?.out === true;
        return {
          available: true,
          deletable: true,
          scopeAllowed: outgoing && !isSelfPeer && !isChannel,
        };
      } catch (err) {
        // A provider that stopped answering is not the same as a target that
        // does not exist. Collapsing the two hid a stalled page behind a
        // plausible verdict, so the stall is reported as itself.
        if (err?.pcgCode === "PROVIDER_PRIMITIVE_TIMEOUT") {
          return { stalled: true, available: false, deletable: false, scopeAllowed: false };
        }
        return { available: false, deletable: false, scopeAllowed: false };
      }
    }, { peerId: Number(providerRef), mid: messageRef.mid, scope });
    if (result?.stalled === true) fail("WEB_PROVIDER_EVALUATE_TIMEOUT");
    if (result?.available !== true) fail("WEB_DELETE_TARGET_NOT_AVAILABLE");
    if (result?.deletable !== true) fail("WEB_DELETE_TARGET_NOT_DELETABLE");
    if (result?.scopeAllowed !== true) fail("WEB_DELETE_SCOPE_NOT_AUTHORIZED");
    return {
      conversation_handle: conversationHandle,
      message_handle: messageHandle,
      target_resolved: true,
      target_deletable: true,
      deletion_scope: scope,
      provider_content_model_visible: false,
    };
  }

  async function dispatchDeleteMessage(page, {
    attemptId,
    conversationHandle,
    messageHandle,
    scope,
    randomId,
  }) {
    attemptId = requiredString(attemptId, "WEB_DELETE_ATTEMPT_INVALID", 256);
    scope = exactDeleteScope(scope);
    if (!validRandomId(randomId)) fail("WEB_DELETE_RANDOM_ID_INVALID");
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_DELETE_MESSAGE_CONVERSATION_MISMATCH");
    const targetMid = messageRef.mid;
    const reservation = {
      providerRef,
      randomId,
      payloadSha256: null,
      operationKind: "delete_message",
      sourceMessageId: targetMid,
      deletionScope: scope,
    };
    const registry = readRegistry();
    const existing = registry.attempts[attemptId];
    if (existing) {
      if (!sameReservation(existing, reservation)) fail("WEB_DELETE_ATTEMPT_CORRELATION_CONFLICT");
      return safeRecord(existing, { redispatchBlocked: true });
    }
    registry.attempts[attemptId] = {
      provider_ref: providerRef,
      random_id: randomId,
      payload_sha256: null,
      operation_kind: "delete_message",
      source_message_id: targetMid,
      deletion_scope: scope,
      state: "RESERVED",
      final_message_id: targetMid,
      provider_error_code: null,
    };
    writeRegistry(registry);

    let result;
    try {
      await ensureProviderModel(page);
      result = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ peerId, targetMid, revoke }) => {
        const create = globalThis.createProxiedManagersForAccount;
        if (typeof create !== "function") return { ok: false, error: "WEBK_MANAGER_PROXY_UNAVAILABLE" };
        const rawAccount = new URL(location.href).searchParams.get("account") || "1";
        const accountNumber = Number.parseInt(rawAccount, 10);
        if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
          return { ok: false, error: "WEBK_ACCOUNT_INVALID" };
        }
        const managers = create(accountNumber);
        const messages = managers?.appMessagesManager;
        const api = managers?.apiManager;
        const ids = managers?.appMessagesIdsManager;
        const peers = managers?.appPeersManager;
        const users = managers?.appUsersManager;
        if (!messages || !api || !ids || !peers || !users
            || typeof messages.reloadMessage !== "function"
            || typeof messages.canDeleteMessage !== "function"
            || typeof messages.deleteMessages !== "function"
            || typeof peers.isChannel !== "function"
            || typeof users.getSelf !== "function"
            || (typeof api.invokeApiSingle !== "function" && typeof api.invokeApi !== "function")) {
          return { ok: false, error: "WEBK_DELETE_PRIMITIVE_UNAVAILABLE" };
        }
        const provider = globalThis.__pcgProvider;
        let target;
        try {
          // Cache-first and bounded: a forced network re-read of a message we
          // already hold is what made deletion hang indefinitely.
          target = await provider.callWithin(8000, messages, "reloadMessage", peerId, targetMid, false);
        } catch (err) {
          if (err?.pcgCode === "PROVIDER_PRIMITIVE_TIMEOUT") {
            return { ok: false, error: "WEB_PROVIDER_EVALUATE_TIMEOUT" };
          }
          return { ok: false, error: "WEBK_DELETE_PRECHECK_FAILED" };
        }
        if (target?._ !== "message") return { ok: false, error: "WEBK_DELETE_TARGET_UNSUPPORTED" };
        if (provider.selfDestructing(target)) {
          return { ok: false, error: "WEBK_DELETE_EPHEMERAL_UNSUPPORTED" };
        }
        try {
          if ((await provider.callWithin(8000, messages, "canDeleteMessage", target)) !== true) {
            return { ok: false, error: "WEBK_DELETE_TARGET_NOT_DELETABLE" };
          }
          if (revoke) {
            const self = await provider.callWithin(8000, users, "getSelf");
            const selfId = Number(self?.id);
            const channelPeer = (await provider.callWithin(8000, peers, "isChannel", peerId)) === true;
            if (!target.pFlags?.out || (Number.isSafeInteger(selfId) && selfId === peerId) || channelPeer) {
              return { ok: false, error: "WEBK_DELETE_SCOPE_NOT_AUTHORIZED" };
            }
          }
        } catch (err) {
          if (err?.pcgCode === "PROVIDER_PRIMITIVE_TIMEOUT") {
            return { ok: false, error: "WEB_PROVIDER_EVALUATE_TIMEOUT" };
          }
          return { ok: false, error: "WEBK_DELETE_AUTHORITY_CHECK_FAILED" };
        }

        try {
          await provider.callWithin(15000, messages, "deleteMessages", peerId, [targetMid], revoke);
        } catch (err) {
          const rawCode = Number(err?.code);
          return {
            ok: true,
            ack_state: "REJECTED",
            provider_error_code: Number.isSafeInteger(rawCode) ? rawCode : null,
            provider_confirmed: false,
          };
        }

        try {
          const resolved = await globalThis.__pcgProvider.serverMessageId(ids, targetMid, null);
          const input = { _: "inputMessageID", id: resolved.ok ? resolved.value : NaN };
          if (!Number.isSafeInteger(input.id) || input.id <= 0) {
            return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false };
          }
          const response = typeof api.invokeApiSingle === "function"
            ? await api.invokeApiSingle("messages.getMessages", { id: [input] })
            : await api.invokeApi("messages.getMessages", { id: [input] });
          const rows = Array.isArray(response?.messages) ? response.messages : null;
          if (!rows) return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false };
          const present = rows.some((message) => message?._ !== "messageEmpty" && Number(message?.id) === input.id);
          return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: !present };
        } catch {
          return { ok: true, ack_state: "ACKNOWLEDGED", provider_confirmed: false };
        }
      }, { peerId: Number(providerRef), targetMid, revoke: scope === "FOR_EVERYONE" });
    } catch {
      return safeRecord(registry.attempts[attemptId]);
    }

    if (!result?.ok) fail(result?.error || "WEB_DELETE_PROVIDER_CALL_FAILED");
    const latest = readRegistry();
    const record = latest.attempts[attemptId];
    if (!record || !sameReservation(record, reservation)) fail("WEB_DELETE_ATTEMPT_CORRELATION_LOST");
    if (result.ack_state === "REJECTED") {
      record.state = "FAILED";
      record.provider_error_code = Number.isSafeInteger(result.provider_error_code) ? result.provider_error_code : null;
    } else if (result.ack_state === "ACKNOWLEDGED") {
      record.state = result.provider_confirmed === true ? "SUCCEEDED" : "ACKNOWLEDGED";
    }
    writeRegistry(latest);
    return safeRecord(record);
  }

  async function observeDeleteMessage(page, {
    attemptId,
    conversationHandle,
    messageHandle,
    scope,
  }) {
    attemptId = requiredString(attemptId, "WEB_DELETE_ATTEMPT_INVALID", 256);
    scope = exactDeleteScope(scope);
    const providerRef = identity.providerRefForHandle(conversationHandle);
    const messageRef = identity.providerMessageRefForHandle(messageHandle);
    if (messageRef.providerRef !== providerRef) fail("WEB_DELETE_MESSAGE_CONVERSATION_MISMATCH");
    const registry = readRegistry();
    const record = registry.attempts[attemptId];
    if (!record) return { ok: true, state: "UNKNOWN", provider_content_model_visible: false };
    const reservation = {
      providerRef,
      randomId: record.random_id,
      payloadSha256: null,
      operationKind: "delete_message",
      sourceMessageId: messageRef.mid,
      deletionScope: scope,
    };
    if (!sameReservation(record, reservation)) fail("WEB_DELETE_ATTEMPT_CORRELATION_CONFLICT");
    if (record.state === "FAILED") return { ...safeRecord(record), state: "FAILED" };

    await ensureProviderModel(page);
    const confirmed = await evaluateWithin(page, PROVIDER_DEADLINE_MS, async ({ mid }) => {
      const create = globalThis.createProxiedManagersForAccount;
      if (typeof create !== "function") return null;
      const rawAccount = new URL(location.href).searchParams.get("account") || "1";
      const accountNumber = Number.parseInt(rawAccount, 10);
      if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) return null;
      const managers = create(accountNumber);
      const api = managers?.apiManager;
      const ids = managers?.appMessagesIdsManager;
      if (!api || !ids
          || (typeof api.invokeApiSingle !== "function" && typeof api.invokeApi !== "function")) return null;
      try {
        const resolved = await globalThis.__pcgProvider.serverMessageId(ids, mid, null);
        const input = { _: "inputMessageID", id: resolved.ok ? resolved.value : NaN };
        if (!Number.isSafeInteger(input.id) || input.id <= 0) return null;
        const response = typeof api.invokeApiSingle === "function"
          ? await api.invokeApiSingle("messages.getMessages", { id: [input] })
          : await api.invokeApi("messages.getMessages", { id: [input] });
        const rows = Array.isArray(response?.messages) ? response.messages : null;
        if (!rows) return null;
        return !rows.some((message) => message?._ !== "messageEmpty" && Number(message?.id) === input.id);
      } catch {
        return null;
      }
    }, { mid: messageRef.mid });

    if (confirmed !== true) return { ...safeRecord(record), state: "UNKNOWN" };
    record.state = "SUCCEEDED";
    writeRegistry(registry);
    return { ...safeRecord(record), state: "SUCCEEDED" };
  }

  return {
    checkDeleteTarget,
    checkForwardTarget,
    checkRelayTarget,
    checkEditTarget,
    checkReplyTarget,
    checkTarget,
    dispatchAttachment,
    dispatchPhotoAlbum,
    dispatchDeleteMessage,
    dispatchEditText,
    dispatchForwardNative,
    dispatchRelayText,
    dispatchReplyAttachment,
    dispatchReplyText,
    dispatchText,
    observeAttachment,
    observePhotoAlbum,
    observeDeleteMessage,
    observeEditText,
    observeForwardNative,
    observeRelayText,
    observeReplyAttachment,
    observeReplyText,
    observeText,
    stageMaterialFile,
    createMaterialFileWriter,
    selfDeleteTarget,
    selfEditTarget,
    selfForwardTarget,
    selfRelayTarget,
    selfReplyTarget,
    selfTarget,
  };
}
