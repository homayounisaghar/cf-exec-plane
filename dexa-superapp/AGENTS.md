# Dexa Superapp Public Release Agent Rules — VPN-OFF REQUIRED

> **STOP before changing Android APK, web assets, Service Worker or owner API paths:** [canonical private VPN-OFF Connectivity Contract](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/VPN_FREE_CONNECTIVITY_CONTRACT.md), [public root AGENTS](../AGENTS.md) and [current public Dexa README](README.md).

**Owner nonregression baseline, 2026-11-15:** Without VPN on the actual Iranian phone, both Cloudflare Worker routes responded `OK 200`, while direct `cf-onshape.duckdns.org` timed out. Android v36 + web v1.8.70 achieved immediate launch after force-stop and clearing cache, personally owner-confirmed.

For each future change preserve:
- Stable original WebView `workers.dev` origin, login, cookies and user preferences.
- Android `WebViewClient` **and independent** `ServiceWorkerController/ServiceWorkerClient` native GET interception. Platform TLS only; no foreign-site or effectful POST interception.
- Reachable owner Worker selection for web API, native control, telemetry, voice/model assets as needed; avoid a blocked direct origin in the critical path; first paint at DOM-ready.
- Any number of Worker accounts from `../dexa/workers/route-pool.json`, finite quota cycling and no replay of ambiguous Rana/remote POST commands.
- Original application ID/signature and existing Android permissions on in-place updates.

**Release evidence:** server-side green tests are insufficient for VPN-off phone success. Request real VPN-off phone cold-start and functional API/Rana/voice/remote/telemetry checks for impacted paths. Do not mark full pipeline proven from a connected bridge or a loaded dashboard. V4 Worker newer Android API and `/android-v36.apk` routes had known 404 gaps.

Public files may contain only secret-free execution artifacts, never token, signing key, private state or personal phone data.
