// CF-server owner host tools: forwards bounded JSON requests to the host cf-ops agent
// over a unix socket. Owner authorization is enforced by CF's HTTP owner-auth gate
// before any tools/call reaches these handlers.
import net from "node:net";

const SOCKET = process.env.CF_OPS_SOCKET || "/run/cf-ops/agent.sock";

function callAgent(op, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error("CF_OPS_AGENT_TIMEOUT"), { code: "CF_OPS_AGENT_TIMEOUT" })); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ op, args, caller: "cf-mcp" }) + "\n"));
    sock.on("data", (d) => { size += d.length; if (size > 4 * 1024 * 1024) { sock.destroy(); return; } chunks.push(d); });
    sock.on("error", (e) => { clearTimeout(timer); reject(Object.assign(new Error("CF_OPS_AGENT_UNAVAILABLE: " + e.code), { code: "CF_OPS_AGENT_UNAVAILABLE" })); });
    sock.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error("CF_OPS_AGENT_BAD_RESPONSE"), { code: "CF_OPS_AGENT_BAD_RESPONSE" })); }
    });
  });
}

function out(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

export function registerCfOpsTools(server, z, options = {}) {
  const call = options.callAgent || callAgent;
  const P = z.string().min(1).max(4096);
  const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const DEL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const NET = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const ref = z.string().min(1).max(240);

  const tool = (name, title, description, inputSchema, annotations, timeoutMs = 30000) => {
    server.registerTool(name, { title, description, inputSchema, annotations }, async (input) => {
      const t = typeof input?.timeout_s === "number" && !input?.background ? Math.min(610, input.timeout_s + 10) * 1000 : timeoutMs;
      try {
        const r = await call(name, input || {}, t);
        if (r && r.ok) return out({ state: "ACHIEVED", tool: name, result: r.result, duration_ms: r.duration_ms });
        return out({ state: "FAILED", tool: name, error: r?.error || { code: "CF_OPS_UNKNOWN" } });
      } catch (e) {
        return out({ state: "FAILED", tool: name, error: { code: e.code || "CF_OPS_FAILED", message: String(e.message || e).slice(0, 300) } });
      }
    });
  };

  tool("server_status", "Server status", "Host cf-ops agent status: user, host, disk, load, uptime, GitHub login state.", {}, RO);
  tool("server_exec", "Run shell command on server",
    "Run a /bin/sh command on the CF host as the WeChat desktop user (not root). Foreground waits up to timeout_s (max 600) and returns exit_code/stdout/stderr (each cut to ~20k chars). background=true starts a job (timeout up to 86400 s) and returns job_id; use server_job_status/server_job_output.",
    { command: z.string().min(1).max(16000), cwd: P.optional(), timeout_s: z.number().int().min(1).max(86400).optional(),
      background: z.boolean().optional(), label: z.string().max(120).optional(), env: z.record(z.string()).optional() }, NET, 70000);
  tool("server_job_status", "Background job status", "Status of one background job.", { job_id: z.string().regex(/^[0-9a-f]{32}$/) }, RO);
  tool("server_job_output", "Background job output", "Read stdout/stderr of a background job from byte offsets (64 KB per call).",
    { job_id: z.string().regex(/^[0-9a-f]{32}$/), stdout_offset: z.number().int().min(0).optional(), stderr_offset: z.number().int().min(0).optional() }, RO);
  tool("server_job_list", "List background jobs", "Latest 100 background jobs.", {}, RO);
  tool("server_job_kill", "Kill background job", "Terminate a running background job (process group).", { job_id: z.string().regex(/^[0-9a-f]{32}$/) }, DEL);
  tool("server_file_read", "Read server file", "Read a file chunk (default 64 KB, max 1 MB) as text or base64. Use offset/next_offset to page.",
    { path: P, offset: z.number().int().min(0).optional(), length: z.number().int().min(0).max(1048576).optional(), encoding: z.enum(["text", "base64"]).optional() }, RO);
  tool("server_file_write", "Write server file", "Write text (content) or bytes (content_base64). mode: create (default, fails if exists) | overwrite | append. make_dirs creates parents.",
    { path: P, content: z.string().max(5000000).optional(), content_base64: z.string().max(7000000).optional(), mode: z.enum(["create", "overwrite", "append"]).optional(), make_dirs: z.boolean().optional() }, RW);
  tool("server_file_edit", "Edit server file", "Replace exact old_text with new_text (must be unique unless replace_all).",
    { path: P, old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }, RW);
  tool("server_file_delete", "Delete server file", "Delete a file or (recursive=true) directory. Requires confirm=true.",
    { path: P, confirm: z.literal(true), recursive: z.boolean().optional() }, DEL);
  tool("server_file_list", "List server directory", "List directory entries (depth 1-3, max 500).", { path: P, depth: z.number().int().min(1).max(3).optional() }, RO);
  tool("server_file_stat", "Stat server path", "Size, mode, owner, mtime and type of a path.", { path: P }, RO);
  tool("server_file_move", "Move server path", "Rename/move a path; destination must not exist.", { src: P, dst: P }, RW);
  tool("server_file_copy", "Copy server path", "Copy a file or directory; destination must not exist.", { src: P, dst: P }, RW);
  tool("server_file_search", "Search server files", "Find files under path by name_glob and/or content_regex (files <1 MB).",
    { path: P, name_glob: z.string().max(300).optional(), content_regex: z.string().max(500).optional(), max_results: z.number().int().min(1).max(200).optional() }, RO);
  tool("server_file_fetch", "Download into server", "Download an https URL, or a CF download_path like /mcp/telegram-file/<id>, to dest_path. Optional expected_size and sha256 checks. Max 2 GB.",
    { url_or_cf_download_path: z.string().min(1).max(4000), dest_path: P, expected_size: z.number().int().min(0).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }, NET, 180000);
  tool("server_file_upload", "Chunked upload to server", "Chunked upload: action=start{path,size_bytes,sha256?} -> upload_id; chunk{upload_id,offset,content_base64<=1MB}; finish{upload_id}; status; cancel.",
    { action: z.enum(["start", "chunk", "finish", "status", "cancel"]), path: P.optional(), size_bytes: z.number().int().min(0).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      upload_id: z.string().regex(/^[0-9a-f]{32}$/).optional(), offset: z.number().int().min(0).optional(), content_base64: z.string().max(1500000).optional() }, RW, 60000);

  const G = (name, title, description, schema, ann, ms = 60000) => tool(name, title, description, schema, ann, ms);
  G("github_auth_start", "GitHub login start", "Start GitHub device login. Show the owner user_code; owner enters it at https://github.com/login/device. Token stays only on the server.", {}, NET);
  G("github_auth_status", "GitHub login status", "Poll device login / show logged-in username.", {}, RO);
  G("github_repo_list", "GitHub repos", "List the owner's repositories.", {}, RO);
  G("github_tree_list", "GitHub tree", "List files of repo at ref (optional path prefix).", { repo, ref, path: z.string().max(1024).optional() }, RO);
  G("github_file_get", "GitHub file get", "Read one file at ref.", { repo, ref, path: z.string().min(1).max(1024) }, RO);
  G("github_files_push", "GitHub push files", "Create one commit on branch with files [{path, content | content_base64}] and optional delete_paths.",
    { repo, branch: ref, message: z.string().min(1).max(1000), files: z.array(z.object({ path: z.string().min(1).max(1024), content: z.string().optional(), content_base64: z.string().optional() })).max(100),
      delete_paths: z.array(z.string().min(1).max(1024)).max(100).optional() }, NET, 120000);
  G("github_file_delete", "GitHub delete file", "Delete one file in a commit. Requires confirm=true.", { repo, branch: ref, path: z.string().min(1).max(1024), message: z.string().min(1).max(1000), confirm: z.literal(true) }, DEL);
  G("github_branch_list", "GitHub branches", "List branches.", { repo }, RO);
  G("github_branch_create", "GitHub create branch", "Create branch name from from_ref.", { repo, name: ref, from_ref: ref }, NET);
  G("github_commit_list", "GitHub commits", "List commits on ref (optional path).", { repo, ref, path: z.string().max(1024).optional() }, RO);
  G("github_commit_get", "GitHub commit", "Get one commit with changed files.", { repo, sha: ref }, RO);
  G("github_compare", "GitHub compare", "Compare base...head.", { repo, base: ref, head: ref }, RO);
  G("github_pr_create", "GitHub PR create", "Open a pull request.", { repo, title: z.string().min(1).max(256), body: z.string().max(60000).optional(), head: ref, base: ref, draft: z.boolean().optional() }, NET);
  G("github_pr_list", "GitHub PR list", "List pull requests.", { repo, state: z.enum(["open", "closed", "all"]).optional() }, RO);
  G("github_pr_merge", "GitHub PR merge", "Merge a pull request. Requires confirm=true.", { repo, number: z.number().int().min(1), method: z.enum(["merge", "squash", "rebase"]).optional(), confirm: z.literal(true) }, DEL);
  G("github_search_code", "GitHub code search", "Search code (defaults to the owner's repos).", { query: z.string().min(1).max(300) }, RO);
}
