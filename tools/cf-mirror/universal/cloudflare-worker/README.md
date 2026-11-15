# CF Mirror Universal — dynamic N-account Cloudflare Worker ring

This package is **not Dexa** and must not modify any existing Dexa Worker. Copy the identical `worker.editor.mjs` (production-ready, compact, single-file ES module) or readable `worker.mjs` to a **new dedicated Cloudflare Worker** in each account.

## Status on 2026-11-15

- Cloudflare account `mirkazem-design`: **new Worker `cf-mirror-bridge` created** under `https://cf-mirror-bridge.mirkazem-design.workers.dev`.
- The variables `MIRROR_UPSTREAM`, `PUBLIC_ORIGIN`, and `MIRROR_EXPIRES_AT` were saved to the new Worker's production settings for the active 1-hour mirror.
- **The source code is not yet published**. As checked, the public Worker continues to return `Hello World!`. It cannot yet proxy the mirror. The dashboard Quick Edit browser tab was repeatedly killed by server OOM. Do not claim VPN-free access or working WebSockets before a real deployed version passes tests.
- The temporary mirror source session is `private_browser_free_1h_1115` (X11 :124), expiring 2026-11-15T13:51:39Z; after expiry the Worker variables must be updated for a new session.
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

**17/17 mocked tests passed**: cookie, CSRF, HTML, MJPEG, gzip, WSS socket control, source expiry, N=7 rotation, correct-session health check and 1027 failover. Real Cloudflare subrequest behavior and Android VPN-OFF network accessibility remain **unverified**.
