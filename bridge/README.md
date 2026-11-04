# Dexa Cloudflare bridge with account failover (2026-11-04)

Status: **CODE STAGED / TESTED LOCALLY; NOT YET DEPLOYED TO ANY LIVE WORKER.** No new account B yet. Do not report live failover until two truly distinct Cloudflare accounts and real Iran-phone tests exist.

## Architecture

Phone browser -> Worker on Cloudflare account A, or B after confirmed quota-1027 -> public HTTPS Dexa Lite gateway on existing Hetzner -> original localhost Dexa main engine.

**GitHub is NOT in the request path.** This repo is only a source backup; Cloudflare dashboard's Edit Code can deploy without GitHub integrations. This does not migrate the original main engine, change app authentication or restart any Hetzner services.

## Current exact facts

- Existing live TEST Worker A: `https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev/` is still original public **harmless canary**, not this authenticated bridge.
- Existing gateway upstream: `https://cf-onshape.duckdns.org/dexa-lite/`; original Basic auth + scoped cookie and mission challenge remain enforced by Hetzner.
- Real upstream anonymous GET `/dexa-lite/` responds HTTP401 and `/dexa-lite/check` 200; new Worker has independently fetched those outcomes in local workerd.
- Account B exact Worker hostname: **UNKNOWN / NOT DEPLOYED**. `bridge/worker.mjs` deliberately sets `BACKUP_ORIGIN = null`.
- Phone VPN-off connectivity of Worker A canary, dynamic ping, SSE and fixed public Hetzner check was verified by owner. Full authenticated Dexa through Cloudflare is not yet owner-proven.
- Workers Free current limit: 100,000 requests **per Cloudflare account** per UTC day; exhaustion returns Cloudflare **Error 1027**; see https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/observability/errors/.

## Safe manual installation, no GitHub deployment link

1. **Create Cloudflare account B as its own account** (not just another Worker or email user inside account A). Select Workers Free; stop if asked for paid upgrade. User controls provider signup.
2. In account B create a fresh Hello World Worker via Workers & Pages. In **Edit Code**, replace all code with the exact `bridge/worker.mjs` (with `BACKUP_ORIGIN=null`), Deploy. Do not supply Dexa credentials or secrets to Cloudflare settings or GitHub.
3. Record the **actual** `https://<worker>.<B-subdomain>.workers.dev` from the B dashboard; do not guess it. Test root, `/bridge-health` (backupReady:false), `/dexa-lite/check` HTTP200, and `/dexa-lite/` challenge HTTP401. Owner must test B URL with VPN OFF. Login prompts require existing owner credentials only on trusted HTTPS page when ready.
4. Update ONLY primary worker source constant `BACKUP_ORIGIN = null` to the exact verified account B origin (e.g. literal HTTPS URL, no trailing path); check source and regenerate/deploy primary Worker A through dashboard. Its `/bridge-health` must then return backupReady:true. This changes the current test Worker, so warn first and preserve rollback in the Cloudflare Deployments UI.
5. On phone **while account A is still under quota**, load A `/` once and allow Service Worker registration; open `/dexa-lite/` and authenticate. This is required so the browser can intercept a future A-generated 1027 page even if A cannot execute Worker code.
6. A quota **1027 only**: Service Worker on the phone redirects navigation to account B; in-app fetches notify the page to navigate to B. Other HTTP errors or ambiguous network failures do NOT trigger switching or duplicate mission requests. The user may need to re-enter Basic auth once on B and select a recent mission from shared original engine history. Browser drafts/cookies do not magically migrate between origins.
7. Test with a synthetic simulated 1027 in isolated local Chromium (test evidence below); NEVER waste 100,000 real requests to exhaust A for testing. Verify actual B root and authentic phone VPN-off reachability independently before claiming full resilience.

## Security properties

- Exact route+method allowlist copied from the existing Lite gateway, not an open proxy. User cannot select an arbitrary target.
- Basic Authorization sent only to pinned public Hetzner Lite HTTPS origin; not hardcoded or logged.
- Browser POST must have correct exact current Worker Origin and same-origin Fetch Metadata, then origin header is translated to the pre-existing Lite gateway's CSRF policy. Existing Basic and form nonce / idempotency remain authoritative; no backend privileges added.
- One-cookie scoped `/dexa-lite/`, `WWW-Authenticate`, content-security-policy and SSE pass through; no caching of sensitive payloads.
- On 1027, browser navigation is redirected. POST is **never transparently replayed**, avoiding double-executed real missions.
- No guarantee of first-ever visit if A quota already exhausted before Service Worker installation; that requires a separate independent permanent entrypoint or manually opening B.
- Failover B requires re-authentication, because Basic credentials and cookies are scoped to different hostnames.
- Cloudflare sits in TLS termination path, so authenticated data pass through Cloudflare even though there are no stored Cloudflare environment secrets.
- Multiple accounts must remain consistent with current Cloudflare account/free-use policies. Do not assume their allowances can be freely combined into one billing pool.

## Verification done

- Actual local Wrangler/workerd GET `/` 200, `/sw.js` 200, public `/dexa-lite/check` 200 from existing upstream, anonymous `/dexa-lite/` and form challenge HTTP401 Basic, unknown paths HTTP404, cross-origin POST 403.
- `node bridge/test.mjs`: 9 unit cases, quota-only fallback, no duplicate POST, normal 401 and 1102 no switching, no backup safe fallback, network ambiguity.
- `node bridge/test-proxy.mjs`: 8 synthetic Basic/HTML-cookie/CSRF/POST-idempotency/SSE/allowlist checks.
- Real Chromium headless test with two **synthetic localhost HTTP origins**, overriding only scheme guard to allow http://localhost and injecting simulated 1027, ended on the B origin: `REAL_CHROMIUM_SERVICE_WORKER_QUOTA_1027_CROSS_ORIGIN_FAILOVER_PASS`. This proves browser control path, not cloud B account connectivity.
- `wrangler deploy --dry-run` staged bundle under test. (Only mark as pass after tool confirms.)
- No original Dexa service, backend auth, or public Cloudflare Worker was changed by these local tests.

## Rollback and scope

Primary A old working test canary source stays in repo branch `dexa-cloudflare-canary-20261104`; if anything fails after future manual deploy, roll back A in the Cloudflare dashboard. Do not change the separate `shared-telemetry` Worker or existing Fly service. Live A and B public URLs must be verified independently after deployments. No payment or card required by code stage.
