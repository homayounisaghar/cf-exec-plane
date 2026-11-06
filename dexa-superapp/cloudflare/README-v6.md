# Dexa Super Dashboard v6 — Cloudflare Worker A candidate

NOT DEPLOYED. This is a secret-free source candidate for the owner's existing A Worker. Do not confuse the GitHub file with a live Cloudflare Worker.

Public dashboard URL configured in Android v6:
https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev/dexa-superapp/

The current live Worker returns HTTP 404 for that path. Publishing the Worker requires authenticated access to the owner's Cloudflare account; none was available in this execution environment. DO NOT overwrite the existing Worker with stale source without comparing current live code, preserving its Lite failover behavior, and testing.

Worker candidate extends exact paths for the dashboard assets, telemetry, device register/next/report, and signed admin endpoints, with headers forwarded. It DOES NOT expose arbitrary URL proxying. The existing Lite routes remain in the candidate. The owner VPS upstream https://cf-onshape.duckdns.org/dexa-superapp/ ALSO needs a route to the new localhost-bound Dexa dashboard Node service, without affecting Dexa Lite, missions or main engine.

Android v6 APK is signed with the owner's original certificate, versionCode6, 62 requested manifest permissions (not all Android-grantable). The native owner-armed foreground service supplies a persistent notification, partial CPU wake lock, Wi-Fi lock, and pumps the SAME existing Dexa WebView remote-client function while the screen is off. This is unverified on physical locked-screen device.

Before declaring operational, separately verify:
1. upstream dashboard route returns correct non-Render dashboard;
2. Cloudflare A /dexa-superapp/api/health 200 and JS byte check;
3. authenticated WebView remote gateway and signed admin probes;
4. real Android v5->v6 in-place upgrade with shared sessions;
5. genuine background/locked-screen two-browser operation.

Do not install as a working Cloudflare replacement until the route is active; the current live path is 404.
