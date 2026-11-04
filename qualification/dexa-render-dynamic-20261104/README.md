# Dexa Render Dynamic Connectivity Probe — 2026-11-04

Public, secret-free connectivity-only pilot. **Not** a Dexa proxy, auth provider, API gateway or migration. Never supply user/private data.

The service exposes:

- `/`: Persian phone-sized local test page.
- `/healthz` and `/api/ping`: fresh harmless JSON with unique request ID.
- `/api/events`: three bounded Server-Sent Events over a live connection.

All endpoints are read-only. No persistence, external requests, proxy target, sensitive data, upstream calls or credentials. CORS only names the already owner-tested public GitHub Pages origin. No private network reachability claims.

## Render deployment

Connect the public repository `homayounisaghar/cf-exec-plane` to a **New Web Service**, not a static site:

- Branch: `main`
- Root directory: `qualification/dexa-render-dynamic-20261104`
- Language/runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Instance: `Free` for testing; avoid paid plans without explicit owner acceptance.
- Public URL: Render-assigned `https://<your-name>.onrender.com/`.

Check `/healthz` and `/api/events` from an unrelated public network; then ask owner to test page and both buttons VPN off. *This does not establish that the eventual user-authenticated Dexa engine connection from Render to Hetzner works.*

Render free services can sleep after 15 minutes idle and wake slowly. Never treat this as production service availability.

Source repo/canonical project: `homayounisaghar/capability-fabric`, Dexa work branch project state. No change to any original Dexa live service or to Capability Fabric connector exposure.
