# Dexa Cloudflare bridge — browser-specific failover readiness indicator

## Deployment status (2026-11-04)

- **LIVE (existing):** primary Worker A at `https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev/`, with a quota-1027-only fallback to independently deployed Worker B `https://dexa-cf-backup-20261104.mirkazem-design.workers.dev/`.
- **LIVE (existing):** B itself proxies the authenticated original Hetzner Dexa Lite gateway and deliberately has no additional fallback.
- **STAGED ONLY (this branch):** a visible status badge for **A**. It has **NOT been published to A** as part of this branch. Do not claim it is live until the actual A origin is directly read back and visually checked in an owner's browser.
- Backup B requires **no change** for this indicator.
- All authentication, CSRF, cookie scope, streaming and original mission execution stay on the existing Hetzner service. GitHub is not used in the runtime request path.

## User-visible indicator

The worker source `bridge/worker.mjs` is a single file intended for Cloudflare Dashboard's **Edit code**. It includes its own installer and Service Worker source; no external assets or keys are required.

When the **primary A** root or authenticated Lite page loads, an unobtrusive Persian indicator appears:

- Green `✓ انتقال خودکار آماده است`: the **currently controlling browser Service Worker** answered a status handshake, verified its bridge version, and confirmed it has a valid **separate B origin** configured.
- Amber `⏳ ...`: installation/control is still pending, often on a first-ever visit. The indicator updates on `controllerchange` and does **not** claim readiness merely because registration returned.
- Red `✕ ...` or `⚠ ...`: unsupported, disabled, unreachable/unconfirmed controller or no fallback. A refresh or checking browser permissions may help.
- This status is specific to the **browser/profile and primary origin**. It does not prove that the backup is reachable at this exact moment, and does not simulate/consume a real quota. The badge is intentionally not a quota counter.
- The badge is a small fixed non-clickable status overlay and does not capture clicks on any Dexa controls.

The primary's live Service Worker also detects only HTTP quota **Error 1027**; ordinary errors do not trigger account failover, and uncertain POST/missions are **never replayed**. The backup may require re-authentication when reached.

## Safe publication (owner's authenticated Cloudflare dashboard)

1. In Cloudflare account **A**, open the existing Worker named `dexa-cf-worker-canary-20261104` under Workers & Pages.
2. In **Edit code**, replace the entire old source with **this branch's** `bridge/worker.mjs`; click **Deploy**. The update replaces the **existing live A code** and may briefly interrupt that Worker. Preserve rollback using the dashboard Deployments history.
3. **Do not** modify B's Worker; do not add paid plans or upload Basic credentials.
4. Verify A `/bridge-health` remains HTTP200 with `backupReady:true`, `/sw.js` has the status query handler, `/dexa-lite/check` HTTP200, unauthenticated Lite HTTP401, and B's health unchanged.
5. In any desired **browser**, open the **A root** (with VPN off if testing access from Iran) and look at the badge. Green means the current page is controlled by the correct SW. If amber remains, refresh once. Repeat separately in another browser if needed.

No new Cloudflare worker, domain, account, credential, runtime dependency, or Hetzner service is introduced.

## Tests

From `bridge/` with Node.js 22:

```sh
node test.mjs
node test-proxy.mjs
node test-browser-status.mjs
node test-real-browser.mjs  # requires isolated Chromium on PATH
```

- `test.mjs`: synthetic 1027 GET/POST, no mission replay, other errors, unsupported paths and CSRF.
- `test-proxy.mjs`: Basic auth, HTML installer, cookie and header pass-through, SSE, POST idempotency, allowlist.
- `test-browser-status.mjs`: real generated SW message response, explicit B present/absent, browser UI green/amber/red, controller-change activation, quota navigation and Lite installer.
- **All three Node suites passed on the owner-authorized VPS using immutable GitHub commit sources.**
- **The isolated real Chromium test passed on a fresh browser profile:** the actual generated Worker page registered the service worker, received its readiness handshake, and displayed the green `data-state="ready"` badge on the first page load, without refresh.
- No attempt is made to spend 100,000 Cloudflare requests to force real quota exhaustion.
