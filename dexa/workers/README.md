# Dexa Worker pool — VPN-off connectivity is mandatory

> **Owner architectural requirement, effective 2026-11-15:** Do not break the phone-to-server path **without a VPN**. Before editing/deploying Workers read [local AGENTS.md](AGENTS.md) and the [canonical connectivity contract](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/VPN_FREE_CONNECTIVITY_CONTRACT.md). The private `capability-fabric` repository remains the project authority.

The owner's phone can reach both Cloudflare Workers without a VPN, but direct `cf-onshape.duckdns.org` timed out on that phone. The Workers are a secure, narrow HTTPS bridge to the upstream server, not interchangeable with a proven client-accessible direct server URL.

- Existing Workers: `dexa-cf-worker-canary-20261104.mirkazem.workers.dev`, `dexa-cf-backup-20261104.mirkazem-design.workers.dev`.
- Current registry: [route-pool.json](route-pool.json), ordered `origins` array; unlimited by design, no fixed count of two or three.
- Same shared Worker code is deployed to every account; adding a new account means deploying that same code to it and adding its origin to `route-pool.json`, **not** changing older Workers' routing source.
- On quota error 1027, bounded cyclic switching must avoid loops and never replay an ambiguous POST/mission. Worker-origin bootstrap can be blocked under hard quota; Android native startup still needs independent routing.
- Protect authentication, strict CORS/OPTIONS, TLS, private APIs, voice/telemetry/remote. Every *new* server API or signed APK endpoint needs a corresponding Worker route test.

**Evidence as of 2026-11-15:** Android v36/web 1.8.70 immediate VPN-off opening after force-stop/cache clearing was confirmed on the real phone. **Full Rana/native private pipeline is not yet owner-verified VPN-off**. Newer Android-kernel API paths and APK36 over Worker were still 404.

Never publish secrets, signing keys, private account tokens, personal logs or private continuity content in this public repo.
