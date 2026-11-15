# Agent Instructions — Public Execution Plane

**Scope:** This repo is a secret-free execution/deployment surface, not a replacement for the private canonical source/state at `homayounisaghar/capability-fabric`. Preserve the established privacy and workflow boundaries.

## Mandatory Dexa-only networking directive (owner, 2026-11-15)

For any file in `dexa/`, `dexa-superapp/`, Dexa Cloudflare Worker code or related Android/web/Rana packaging, **READ the [private canonical VPN-OFF Connectivity Contract](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/VPN_FREE_CONNECTIVITY_CONTRACT.md) first**, and follow the applicable scoped `AGENTS.md`.

The owner explicitly requires **working without VPN on their actual Iranian mobile phone** across affected pipelines. The phone reached both Workers but timed out on direct upstream; Android v36 / web v1.8.70 owner-confirmed immediate VPN-off cold start even after force-stop/cache-only clearing. Do **not** regress this by a direct-only URL, removing the Android ServiceWorkerClient bridge, changing the original WebView storage origin, serial blocked-host probes, insecure TLS, fixed worker count, or duplicate POST requests. Full Rana/native API VPN-off operation is *not* yet proven. Use the canonical contract's release gate and honest evidence statuses.

**Other projects:** This Dexa-specific policy does not change Onshape or other execution-plane routing rules.
