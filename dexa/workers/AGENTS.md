# Dexa Cloudflare Worker Agent Instructions — OWNER VPN-OFF PATH

**REQUIRED BEFORE EVERY EDIT/DEPLOY:** [private canonical VPN-OFF Connectivity Contract](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/VPN_FREE_CONNECTIVITY_CONTRACT.md). This applies regardless of the agent/chat or the Cloudflare account being edited.

**WHY:** The owner confirmed on an actual VPN-off Iranian phone that both Workers were reachable (`OK 200`) but direct upstream `cf-onshape.duckdns.org` timed out. Android v36 / web v1.8.70 immediately opens after force-stop/cache clear with VPN OFF; a future Worker deployment must not break this.

**Invariant:** Worker `A` and Worker `B` are equal peers, not a fixed 2-account arrangement. Use one shared implementation and ordered `route-pool.json` schema `dexa.worker-pool.v1` to support arbitrary N. Account selection must detect Cloudflare 1027, loop at most once over each configured origin, and eventually retry previously exhausted accounts only in a *new* cycle after capacity resets. An exhausted Worker may be unable to serve its own bootstrap: Android/native route discovery must remain independent.

Keep `/bridge-health`, `/bridge-pool`, `/dexa-superapp/` assets, `/dexa-superapp/api/config`, read-only health, authenticated owner `/api/dexa/*`, remote native `/api/remote/*`, telemetry `/api/telemetry`, and approved POST/OPTIONS/CORS routes appropriately reachable from the phone. Add new APIs and signed APK downloads to the **narrow** route allowlist alongside their app changes. Keep owner tokens, device signatures, request-body restrictions, strict TLS/CORS. Never introduce an open proxy or replay an ambiguous Rana/native POST on failover.

**Current known gaps (2026-11-15):** some new Android kernel `/api/dexa/android/*` paths and Worker `/android-v36.apk` returned 404. They require explicit fixes and owner-phone VPN-off acceptance; do not claim full operation is proven.

Before publishing, test Worker paths and auth from both accounts, verify finite arbitrary-N rotation, and retain the last working scripts for rollback. **Do NOT deploy a Worker or app version that makes the owner's working VPN-off start require a VPN.**

Canonical continuity stays in `capability-fabric`; public Worker code is secret-free execution material only.
