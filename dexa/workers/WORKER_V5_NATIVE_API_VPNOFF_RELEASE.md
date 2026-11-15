# Dexa Cloudflare V5 native Android API bridge

Versioned source in GitHub: dexa/workers/dexa-cloudflare-worker-v5-native-api-vpnfree-20261115.js.
The same bytes are also published at BOTH historical dexa-cloudflare-mirkazem*-dynamic-ring-20261115.js paths.
SHA256 staged and GitHub verified: d250fc7fc5e1806f6a9672e1810156fb06f06762752b2a623f6a9132dfa92a1f.

## Required precondition and preservation
Read the canonical owner VPN-OFF Connectivity Contract and dexa/workers/AGENTS.md.
Preserve Android v36 / web 1.8.70 immediate no-VPN boot, original WebView Worker origin and
owner local storage, strict TLS, dynamic N-account route-pool, bounded Cloudflare 1027 rotation
and never replaying ambiguous command POSTs.

## Exactly what changed from live V4
- V4->V5 diagnostic VERSION string
- Four owner-token-gated routes:
  GET /dexa-superapp/api/dexa/android/inventory
  GET /dexa-superapp/api/dexa/android/status
  POST /dexa-superapp/api/dexa/android/trust
  POST /dexa-superapp/api/dexa/android/submit
- Three native credential-bound routes:
  GET /dexa-superapp/api/remote/device/android-next
  POST /dexa-superapp/api/remote/device/android-inventory
  POST /dexa-superapp/api/remote/device/android-report
- Add APK GET /dexa-superapp/android-v32.apk through /android-v36.apk,
  leaving previously allowed v17-v31 unchanged.

All other V4 proxy, origin checking, owner-token checks, device-token forwarding,
CORS, quota, no-POST-replay, Service Worker, and registry logic unchanged.
No new wildcard or open proxy: all new routes exact. Upstream independently
validates real owner token, credential binding, and signed receipts.

## Tests already done
node --test test_worker_v5_native_api.mjs -> 6/6 pass, including all endpoints, A+B
origin modes, OPTIONS/CORS, denial of unapproved route/headers/origin,
single upstream POST, APK compatibility, and byte-identical SW quota logic.
GitHub raw V5 source byte-for-byte equals staged source.

## Deployment / acceptance state
Only GitHub SOURCE is published. Cloudflare runtime deployment requires
authenticated access to EACH Cloudflare account; there is no such credential
in the current CF_Server execution environment. DO NOT claim production fixed
until live /bridge-health returns V5 and real-phone VPN-off owner API succeeds.

Exact SAME GitHub Raw file should be installed into both existing Workers:
- dexa-cf-worker-canary-20261104.mirkazem.workers.dev (account mirkazem)
- dexa-cf-backup-20261104.mirkazem-design.workers.dev (account mirkazem.design)

Smoke after each deployment:
- GET https://<worker>/bridge-health: V5 string
- GET /dexa-superapp/: HTTP 200 (old no-VPN boot preserved)
- OPTIONS /dexa-superapp/api/dexa/android/inventory with approved Origin
  and Access-Control-Request-Headers: x-dexa-owner-token: HTTP 204
- GET same without owner token: HTTP 401, NEVER 404 (private data stays private)
- GET /dexa-superapp/api/remote/device/android-next with missing credential: HTTP 401
- GET /dexa-superapp/android-v36.apk: HTTP 200, signed APK exact expected SHA256
- Check no unauthorized arbitrary paths are proxied.

Finally, on real OWNER PHONE with VPN OFF and original signed Android v36:
refresh web, tap phone control, request inventory and select benign system.health.
The native inventory reported versionCode 32 in stale server storage while V4
blocked native android-inventory; expect versionCode 36 once V5 permits fresh
native manifest. Check a signed verified receipt before testing alarm.set.
No credential reinstall, data clearing, phone trust revoke, or APK upgrade
required for this Worker-only correction.

Evidence status: VPN_OFF_BOOT_OWNER_CONFIRMED (existing v36).
VPN_OFF_PRIVATE_ANDROID_API_UNVERIFIED until Worker V5 deployment and phone test.
