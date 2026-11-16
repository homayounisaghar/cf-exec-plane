# CF Universal Mirror — Stable Multi-Session Cloudflare Workers VPC

**Status 2026-11-16:** host code deployed and tested; Cloudflare production VPC binding NOT deployed pending authorized access to the existing Cloudflare account.

## Architecture

- One fixed Cloudflare Workers address: https://cf-mirror-bridge.mirkazem-design.workers.dev
- Multiple simultaneous route paths: /m/RANDOM_SESSION_ID/ where each ID is independent and cryptographically random.
- Every route retains its own password, browser session, auth cookie scoped to its path, signed CSRF controls, WebSocket upgrades, and expiration. Registration requires the mirror to be both live and password-protected. A local mirror is never eligible.
- The Cloudflare Worker forwards to ONE private Workers VPC HTTP Service, scoped only to 127.0.0.1:6266 on the host, using a persistent Cloudflare Tunnel with QUIC. The private loopback broker routes to the approved session-specific gateway ports. Never bind VPC to CDP/X11 or arbitrary host services.
- Broker defaults to max FOUR active registered web sessions (configurable up to 12); two concurrent live sessions were tested. Capacity beyond two is not qualified.
- The user-facing fixed hostname stays identical for all mirror sources: WhatsApp, WeChat, Alibaba, Telegram, X11 apps, terminals, etc. Only the per-session URL path and password change. No domain purchase is required.
- If Worker or VPC health is unavailable, the unchanged Quick Tunnel mode remains available. The stable path is activated automatically ONLY after real Worker->VPC->broker health verification and the owner activation marker.

## Implemented / verified on host

- /home/cfserver/.local/share/cf-mirror-universal/stable-gateway-v1/broker.mjs — bounded HTTP, images, login, cookies, CSRF, WebSocket route proxy. Session registry is private, only active web sessions, validated by PID/startupKey/expiry for each request.
- /home/cfserver/.config/systemd/user/cf-mirror-stable-broker.service — active, listening exclusively at 127.0.0.1:6266, survives user service restarts.
- opt-in stable-origin support added to cf-mirror-universal.mjs (backed up). It starts a web mirror without any Quick Tunnel and registers a stable path automatically; ordinary local and public calls are unchanged before activation.
- stable-gateway-v1/worker.mjs — intended Cloudflare Worker source with Workers VPC binding MIRROR_VPC, public health and per-session routing.
- stable-gateway-v1/wrangler.toml.example — example only, requires real VPC Service UUID before using.
- stable-gateway-v1/test-stable.mjs: 13/13 passed, including two parallel routes, cookie scoping, expiry isolation, JPEG streaming, local WebSocket 101, Worker binding mocks.
- stable-gateway-v1/test-live.mjs: passed. TWO real CDP browser sources 9323 and 9324 served through different session paths simultaneously; both authenticated with independent passwords; cross-session cookie was refused; one real 40,558-byte JPEG read. Both disposable sessions cleaned up. Neither used a public Quick Tunnel.
- The existing Alibaba and WeChat local mirror sessions and their browser processes were preserved.

## Mandatory remaining Cloudflare account configuration

Owner action: authorize the existing Cloudflare account mirkazem-design to Wrangler or to the official Cloudflare Dashboard. Do not disclose API token, tunnel token, OAuth one-time code or password in chat or GitHub. Required roles: Workers Scripts Write, Connectivity Directory Admin/Bind.

1. From Workers VPC dashboard, create a remotely managed Cloudflare Tunnel, e.g. cf-mirror-private-vpc. No public hostname or purchased domain. Copy its tunnel token privately into /home/cfserver/.config/cf-mirror-stable-vpc-token, chmod 0600. Install the provided cf-mirror-stable-tunnel.service.example user unit and start it only after authorization; check Tunnel Healthy. Workers VPC requires QUIC and outbound UDP/7844.
2. Workers VPC > VPC Services > Create. Type HTTP, select the tunnel, target IPv4 127.0.0.1 and custom HTTP port 6266. Note the VPC Service UUID. This ONE scoped VPC Service supports all mirror routes.
3. In this directory copy wrangler.toml.example to wrangler.toml and replace the placeholder with that Service UUID. Back up the EXISTING cf-mirror-bridge Worker version, then use authorized Wrangler to deploy worker.mjs under that exact original Worker name and existing Cloudflare account. Do not overwrite Dexa or other unrelated Workers.
4. Verify public https://cf-mirror-bridge.mirkazem-design.workers.dev/__bridge-health has private_reachable=true (it genuinely calls the broker through Workers VPC). Also verify local HTTP 200 from 127.0.0.1:6266/__stable-health.
5. Run ./activate-stable-origin.sh. It performs both health gates and creates the owner-private activation marker in ~/.cache/cf-mirror-universal/stable-vpc-ready. Only after this marker will ordinary future cf_mirror_open mode=web automatically select the stable origin, and it checks public health on each new request before use.
6. Run two short production mirrors, verify login, JPEG, MJPEG, POST controls/CSRF, input-ws/mic-ws from actual Android browser. VPN may still be required for access to workers.dev.

**The public Worker is NOT deployed yet.** The old Worker at the fixed hostname returns HTTP 410 from an expired old route. Workers VPC real WAN WebSocket performance has not yet been qualified. Do NOT create the stable activation marker or assert public readiness before step 4 completes.

## Rollback and operations

- Remove ~/.cache/cf-mirror-universal/stable-vpc-ready to revert all new public requests to legacy Quick Tunnel (existing sessions unaffected).
- Roll back Worker deployment from Cloudflare dashboard / Wrangler if necessary.
- Existing local mirrors and browsers need no restart for the broker/Worker change.
- Stop only the relevant test mirror by name when testing; never call stop all. Root path of broker returns HTTP 404; it never exposes an index of sensitive active sessions.

## Official references

- https://developers.cloudflare.com/workers-vpc/get-started/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/
- https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/
- https://developers.cloudflare.com/workers/runtime-apis/websockets/
