# Dexa Vercel dynamic reachability canary (2026-11-04)

This is a harmless, secret-free and read-only test for VPN-off connection from the owner's phone. It is **not** a Dexa backend, login service, authenticated proxy or migration. Do not enter credentials or private data.

- `/`: Persian mobile UI.
- `/api/ping`: uncached server-side JSON with a new UUID for every request.
- `/api/events`: three bounded live Server-Sent Events, one every 600ms.
- No upstream HTTP calls, persistence, cookies, authentication, credentials, or private info.
- CORS allows only our public GitHub Pages origin `https://homayounisaghar.github.io`, for a later separate cross-origin test. Same-origin UI needs no CORS.

## Deployment

The public repo is `homayounisaghar/cf-exec-plane`, branch `dexa-vercel-canary-20261104`. Select **only** this root directory when importing:

`qualification/dexa-vercel-dynamic-20261104`

Framework: **Other** (no framework/build). Deploy on the personal Hobby plan if permitted. Never select a paid Pro plan or provide payment without separate owner agreement.

The source uses Vercel's native Node.js /api Functions with Web fetch Request/Response APIs, static root HTML and no npm dependencies.

Do **not** claim owner-reachable endpoint until deployed public URL gives valid status and owner personally tests both buttons with VPN OFF. Even successful SSE does not prove an authenticated request from Vercel to the original Dexa server at Hetzner.

## Verification after service exists
1. HTTPS GET `/` returns `DEXA_VERCEL_DYNAMIC_OK`.
2. HTTPS GET `/api/ping` returns new UUID on repeated calls.
3. HTTPS GET `/api/events` yields three actual event-stream messages without buffering until EOF.
4. Owner repeats 1-3 via page buttons VPN off.
5. Separately test foreign Vercel→Hetzner connectivity without secrets or owner data.

No modification to Dexa main service or CF-server connector.
