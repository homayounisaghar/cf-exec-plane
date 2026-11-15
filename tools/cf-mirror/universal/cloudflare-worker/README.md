# CF Mirror Universal — dynamic N-account Cloudflare Worker ring

This package is **not Dexa** and must not modify any existing Dexa Worker. Copy the identical `worker.editor.mjs` (production-ready, compact, single-file ES module) or readable `worker.mjs` to a **new dedicated Cloudflare Worker** in each account.

## Status on 2026-11-15

- Cloudflare account `mirkazem-design`: **new Worker `cf-mirror-bridge` created** under `https://cf-mirror-bridge.mirkazem-design.workers.dev`.
- The variables `MIRROR_UPSTREAM`, `PUBLIC_ORIGIN`, and `MIRROR_EXPIRES_AT` were saved to the new Worker's production settings for the active 1-hour mirror.
- **Worker code deployed from the authenticated Cloudflare Quick Edit dashboard without extra OAuth permissions**, after a byte-for-byte clipboard verification against `worker.editor.mjs`. Public `/__bridge-health` now reports `cfm-worker-n-ring-20261115` (not `Hello World!`). The dashboard browser was resource-constrained, but the final editor upload and Deploy succeeded.
- **Current source**: `cfmirror_worker_source_1115b` (dedicated X11 :124), expires `2026-11-15T14:46:59.322Z`. `MIRROR_UPSTREAM` and `MIRROR_EXPIRES_AT` were updated and deployed via the Worker Settings UI; health reports the exact new expiry. Password remains in the private mirror session and has NOT been placed in GitHub.
- **Live HTTP verification**: Worker root/login HTML 200, health/pool/SW 200, no-login `/view/` `/shot.jpg` `/stream.mjpg` `/input-ws` and `/mic-ws` 401, cross-site POST 403, no upstream address leaked in login HTML. Local screenshot 1440x900 was nonblack and virtual microphone is available/idle. Authenticated WebSocket 101 and real Android VPN-OFF operation still require end-to-end testing.
- The Cloudflare Wrangler CLI (`npx --yes wrangler@4.157.0`) is available, but OAuth Device Authorization Grant requires an owner approval. The temporary unapproved login job was terminated; do not claim an authorized CLI session.

## Architecture

Phone (VPN-OFF) → authenticated `*.workers.dev` Worker → HTTPS short-lived `*.trycloudflare.com` tunnel → existing loopback CF Mirror password gateway → localhost X11 :124 Chrome + PulseAudio microphone.

All HTTP endpoints, JPEG/MJPEG streaming and both `/input-ws` (pointer) and `/mic-ws` (microphone) are forwarded by the Worker. Browser Origin is validated and translated to the gateway origin before forwarding; the upstream still enforces password, HttpOnly SameSite=Strict cookies, signed CSRF and expiry. Public Worker health, pool and SW endpoints leak neither password nor upstream hostname. CSP `connect-src` is rewritten to the exact Worker WSS origin. CDP and X11 are never exposed.

## N-account route pool from Dexa

The design was derived by inspecting the exact Dexa dynamic-ring Worker and its embedded Service Worker at `dexa-phase2-controlled-release-20261112/releases/manual-cloudflare-owner-api-20261115/dexa-cloudflare-shared-dynamic-ring-20261115.js` on the CF host. Dexa uses a public GitHub manifest, 5-minute cache, per-origin Service Worker, 1027 detection, a bounded one-pass ring and **never retries an ambiguous POST**.

The mirror Worker generalizes that protocol:

1. Each Worker fetches **the same** public manifest at [`route-pool.json`](./route-pool.json) in this repository (5-minute cache). It validates HTTPS `*.workers.dev` origins and never hardcodes the number of accounts.
2. `rotationMinutes` controls deterministic periodic new-session rotation (default 15 min) with health checks. Browser credentials and WebSocket streams stay pinned to the chosen origin; existing sessions never hop on a timer.
3. Each host serves `/sw.js`, `/__bridge-pool` and `/__bridge-health`. The same-origin Service Worker catches Cloudflare quota **1027**, checks the next healthy account with the **same upstream session fingerprint**, and redirects a GET navigation. It stops after one full ring traversal.
4. A `POST`, click or audio chunk is **never replayed** across accounts. On switching host, browser must login with its mirror password again because cookies are host-only.
5. To add an account in the future, **deploy the same unchanged `worker.editor.mjs`**, configure that account's `MIRROR_UPSTREAM` (current quick tunnel), `MIRROR_EXPIRES_AT` and its own `PUBLIC_ORIGIN`, test the deployment, and append the verified origin to `route-pool.json`. All existing Workers learn the new account after cache expiry; no code redeploy.
6. Each new temporary mirror tunnel requires updating `MIRROR_UPSTREAM` and the expiry on all configured Workers. Worker pool rotation cannot prevent expiry of the origin mirror.

## Runtime variables (Production)

- `MIRROR_UPSTREAM` — `https://<active-quick-tunnel>.trycloudflare.com`, no path, only a truly active authenticated mirror gateway.
- `PUBLIC_ORIGIN` — `https://cf-mirror-bridge.<this-account>.workers.dev`, exact account-specific origin.
- `MIRROR_EXPIRES_AT` — Unix milliseconds from `cf_mirror_open` (13 digits, optional but recommended).

## Deployment

**Dashboard:** Workers & Pages → `cf-mirror-bridge` → Edit code → replace entire `worker.js` contents with `worker.editor.mjs` → Deploy. Verify public `/__bridge-health` and `/__bridge-pool` before attempting a password login.

**CLI with owner-approved minimal scope:** Use Wrangler authenticated with account-read and workers-script-write, set correct account ID, run the provided `deploy-one-account.sh`. Never paste an OAuth one-time code, password or Cloudflare access token into chat or a public repository. Revoke/clear temporary access after deployment.

**Second account:** Create a NEW Worker with the same `worker.editor.mjs`; do not edit `dexa-cf-worker-canary-20261104` or `dexa-cf-backup-20261104`. Configure different `PUBLIC_ORIGIN`; keep same upstream+expiry. Add new host to pool only **after** its health and authenticated WS tests pass.

## Build and tests

The maintainable source is `worker-template.mjs`, `service-worker.js`, `sw-install.js`. `build-worker.mjs` assembles `worker.mjs`; `worker.editor.mjs` is a 13 kB single-file esbuild-minified equivalent with short lines, suitable for Cloudflare's Quick Edit.

```sh
npx --yes esbuild@0.25.12 service-worker.js --minify --target=es2022 --outfile=service-worker.min.js
npx --yes esbuild@0.25.12 sw-install.js --minify --target=es2022 --outfile=sw-install.min.js
node build-worker.mjs
npx --yes esbuild@0.25.12 worker.mjs --minify --line-limit=145 --target=es2022 --format=esm --outfile=worker.editor.mjs
node --test tests/worker-proxy.test.mjs tests/dynamic-ring.test.mjs
```

**17/17 mocked tests passed**: cookie, CSRF, HTML, MJPEG, gzip, WSS socket control, source expiry, N=7 rotation, correct-session health check and 1027 failover. Live public Worker-to-Quick-Tunnel HTTP routing is **verified** (login 200, protected media 401). Authenticated MJPEG/WS microphone/touch and Android VPN-OFF network accessibility remain **unverified**.

## 2026-11-15 Android login: `Origin denied` fix deployed

Observed: Android opens the Worker-hosted password form, but after submission/post-login navigation sees a white page saying `Origin denied`. The literal text comes from the Cloudflare Worker `validateBrowser` rejecting incoming request headers before forwarding to the mirror gateway. It is not an error from the upstream Telegram tab.

Corrected Worker version **`cfm-worker-n-ring-20261115-originfix1`** is LIVE at `https://cf-mirror-bridge.mirkazem-design.workers.dev`, deployed from the authenticated Cloudflare Quick Edit UI (no Wrangler/OAuth). The upload was verified byte-for-byte using a foreground, persistent X11 clipboard process; the temporary clipboard job is terminated after use.

Policy: read-only GET/HEAD navigations ignore inconsistent browser Origin headers, including `Origin: null` after a 303 redirect, but still require the gateway's authenticated session Cookie. Login form POSTs require the exact worker Origin, or when missing/null, verified `Sec-Fetch-Site: same-origin` or same-origin Referer; the upstream hidden session CSRF remains required. Other mutating POSTs and WebSockets retain strict Origin and signed HMAC CSRF and session cookie checks. A cross-site login POST remains denied.

Live verification: health reports the `originfix1` version; GET with `Origin: null` returns 200; synthetic `/login` POST with `Origin: null` + same-origin fetch metadata, and with worker Origin + same-site fetch metadata, reached upstream and returned `Invalid login token` (expected for intentionally invalid CSRF), NOT `Origin denied`; cross-site POST returned 403; unauthenticated image/WS routes remain 401. All 23 mock regression tests pass, including six new Android/CSRF/Origin checks. **Real phone login, touch and microphone remain user-device tests**.

Active session after correction is `cfmirror_worker_source_1115c` on X11 :124; expires `2026-11-15T15:16:55.287Z`. The public Worker URL is stable but its underlying mirror source and expiration need reconfiguration when the temporary mirror rotates. Never commit the session password.
