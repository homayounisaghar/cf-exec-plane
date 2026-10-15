# cf-ops v2 (owner host agent + root approval)

Installed by `server-bootstrap/control/cf-ops-install/<id>.request` (workflow `cf-ops-install.yml`,
ships only `cf_ops_agent.py github_api.py install.sh status.sh`; the root wrapper is embedded in
`install.sh`, `cf_admin_exec.py` is the same file for review). CF-side tools (`cf-ops-tools.mjs`,
`cf-ops-preload.mjs`) ship in CF release r251 (`qualification/onshape-fast-r12/<this commit>/`).

## What v2 adds
- `server_admin_request/approve/output/list/cancel`: one root command per request. The exact
  command (plain ASCII, max 3200 chars, shown in a code block), reason, requester and a 6-digit
  code go to the owner's Telegram Saved Messages. Code: salted hash only, 10 min, single use,
  5 attempts per request, max 5 pending, approvals lock for 24 h after 20 wrong codes.
  Foreground runs in a transient scope, background as a transient service `cf-admin-<id>`
  (own cgroup: survives cf-ops restarts, not limited by the agent's MemoryMax, usable for the
  user migration). Exit codes recorded; output head+tail only.
- `server_file_link`: random 256-bit download URL `https://cf-onshape.duckdns.org/mcp/cf-ops-file/<hex>`,
  ttl 60-86400 s (default 3600); expired link records are pruned.
- Audit: agent audit `caller_fingerprint` now says who asked: `chatgpt owner=<label> cfsub_<16hex>`
  or `oauth client=<registered client name> owner=<label> cfsub_<16hex>` (Notion, Gemini, ...).
  Root wrapper keeps its own root-only audit `/var/log/cf-admin/audit.jsonl` (full command text).
- Root codes are scrubbed from every CF tool result (`CF root code: (hidden)`).

## Installer
Root only. Backs up agent/unit/wrapper/sudoers/env to `/var/lib/capability-fabric/cf-ops-backup/<ts>`,
installs, restarts the agent, checks `server_status` (2.0) and the sudo path (`server_admin_list`).
Any failure after the backup -> automatic rollback (restore previous files + restart previous unit,
or remove if there was none). sudoers: `#1000 ALL=(root) NOPASSWD: /usr/local/sbin/cf-admin-exec`
(uid based, survives the user rename; validated with sudo-rs `visudo -c`). Unit drops
NoNewPrivileges (needed for sudo), keeps KillMode=process, MemoryMax=2G, TasksMax=512.
WeChat units, paa_remote and CF containers are not touched.

## Known limits (be honest)
- The code is a consent step, not a sandbox: the Telegram Web browser runs as uid 1000 with a
  loopback CDP port, so a deliberately malicious non-root process could still read the code.
  Screenshots (`telegram_screenshot`) cannot be scrubbed. Stronger options: authenticator (TOTP)
  code, or closing the provider CDP ports.
- sudo on this host is sudo-rs (Ubuntu 26.04); coreutils are uutils.

## Tests (run locally, no root)
- `test/integration_v2.mjs`: MCP tools + agent + wrapper with fake Telegram socket
  (`test/fake_pcg.py`) and fake systemd (`test/fake-bin/`): request/approve, wrong code,
  race (only one run), timeout kills the process group, background exit code, pending cap,
  per-request and 24 h lockout, delivery failure, download link via the HTTP hook, scrubbing
  (also for tools registered by later preloads), caller identity.
- `test/install_sim_*.sh|py`: installer in a fake root: v1->v2 upgrade, re-run, rollback when the
  final check fails, when sudoers validation fails, and when the new agent never starts.

## Tool gateway (r252)
Clients (Notion, ChatGPT) cache the tool list when they connect, so tools added by a later release
stay invisible until the connector is reconnected. Three fixed tools close that gap:
- `cf_tool_list` (read-only): current server tools; compact list, or full input schema for up to 20 names.
- `cf_tool_read` (read-only): run a tool that is marked read-only, by exact name + arguments.
- `cf_tool_call`: run any tool by exact name + arguments.
They call the SDK's own `tools/call` handler with the same caller context (`_meta`, OAuth info),
so input validation, in-tool owner checks, `confirm=true` fields, caller audit, code scrubbing and the
Telegram root code all still apply. The HTTP owner gate already runs for the gateway call itself.
No recursion into gateway tools; names are looked up as own properties only.
Trade-off: the client's per-tool confirmation shows only "cf_tool_call", so the assistant must ask the
owner before risky actions itself. Prefer direct tools; the gateway is a bridge until the next reconnect.
Also in r252: JSON-RPC batches containing `tools/call` are refused (a batch skipped the per-request
owner gate on the private-token path).
- `test/gateway_test.mjs`: list/schema identity, read-only refusal, validation identical to direct
  calls, `_meta` pass-through, errors, scrubbing, cf-ops tools via gateway == direct.
