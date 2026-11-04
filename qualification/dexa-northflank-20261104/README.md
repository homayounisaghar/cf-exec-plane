# Northflank Sandbox no-secret canary, 2026-11-04

Only public read-only connectivity diagnostics. No user data, no Dexa credentials. Northflank had a confirmed secrets incident on 2026-10-30: https://status.northflank.com/ ; do NOT deploy secrets here.

**Deploy from GitHub**

- Public repo: `homayounisaghar/cf-exec-plane`
- Branch: `dexa-northflank-canary-20261104`, NOT main
- Combined Service, one small replica, Build: Dockerfile `/Dockerfile`, context `/`
- Network public HTTP port **8080**, TLS provided by Northflank
- Select Sandbox/Free only, no card, no extra database
- Ask owner to test public allocated `*.code.run` address WITHOUT VPN on their phone.

Endpoints: root Persian page, `/healthz`, `/api/ping` fresh UUID, `/api/events` three SSE events, `/api/hetzner-public-check` fixed harmless public static upstream. Nothing forwards private Dexa commands or passwords.

Do not claim reachable until owner's network test passes. Provider pricing advertises free always-on up to two services and $20 monthly resources but older docs may require a billing card. Original Dexa unchanged.
