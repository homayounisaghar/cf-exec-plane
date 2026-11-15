# Dexa v281 - Cloudflare Worker edge receipts (pending owner deploy)

## Current verified release

The Dexa WebView dashboard and Rana engine were deployed as `web-v1.8.85-e2e-trace`. The on-device native APK remains v44. Owner-private five-layer report: open the dashboard, enter the original mission UUID under **End-to-end mission trace**, and press the check button. The same report is returned by the authenticated `GET /dexa-superapp/api/dexa/timing?requestId=<uuid>&diagnostics=1` endpoint.

## Worker release gate

Both live Workers were still `DEXA_CLOUDFLARE_BRIDGE_V5_NATIVE_API_VPNFREE_20261115` when checked. The v281 candidate in this directory has been tested but MUST NOT be marked deployed until the owner deploys it on **both** existing Cloudflare accounts and verifies `/bridge-health` returns `DEXA_CLOUDFLARE_BRIDGE_V6_E2E_EDGE_20261115` from both Worker URLs.

Use the same exact `dexa-worker-v6-e2e-edge-20261115.js` JavaScript as the full Worker script in each existing Worker (not as a new Worker, and not as a separate website). Do not replace or delete existing account settings, route names, custom domains, or secrets.

### Implementation

The Worker logs `DEXA_E2E_EDGE` metadata only for an authenticated owner `POST /dexa-superapp/api/dexa/execute?trace=<uuid>`. Metadata: request UUID, phase, Worker hostname, cf-ray if present, status, elapsedMs. It never records the prompt, recipe, message, phone number, or bearer. It writes `EDGE_REQUEST_RECEIVED`, `EDGE_ORIGIN_RESPONSE` or `EDGE_ORIGIN_FETCH_EXCEPTION` via console and a best-effort `ctx.waitUntil` beacon to the existing authenticated origin endpoint `/dexa-superapp/api/dexa/edge-receipt`. No extra mission gate or execution retry is introduced.

**Failure-mode limitation:** when the Worker cannot reach the owner origin, its beacon to the same origin may also fail. The Worker console event then remains the only Cloudflare-side evidence; durability and independent retention require Cloudflare Workers Observability/Logs or Logpush to be enabled and verified on both accounts. A missing origin beacon is *not* proof of a failure before Cloudflare.

### Live verification without any real SMS

Before/after: GET `/bridge-health` on both accounts to confirm exact Worker version. Then run an owner-authenticated metadata-only end-to-end dry run or a regular owner mission and inspect its receipt via the dashboard. Independently run the read-only server CLI:

`node /home/cfserver/dexa-phase2-controlled-release-20261112/releases/dexa-web-v281-end-to-end-telemetry-20261115/scripts/e2e-report.mjs <requestId>`

Expected: actual `EDGE_REQUEST_RECEIVED` for the same UUID, plus origin `INGRESS_HEADERS` and Rana `RANA_RECIPE_RECEIVED` only where execution actually reached that layer. Unit tests: `node --test cloudflare/test_edge_trace_v281.mjs` verifies success, synthetic upstream failure and denied cross-origin request; no SMS/tool effects are made.

Never claim end-to-end verified by checking a 200 health response alone, and never retry an ambiguous POST to generate a trace.
