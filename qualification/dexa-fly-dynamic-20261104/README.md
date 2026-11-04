# Dexa Fly.io VPN-off dynamic path qualification (2026-11-04)

**Not connected to Dexa. Not a proxy. No credentials, secrets, cookies, databases or user data.** Public read-only connectivity canary.

Source: `homayounisaghar/cf-exec-plane` branch `dexa-fly-canary-20261104`, folder `qualification/dexa-fly-dynamic-20261104`.

## Endpoints

- `/`: Persian responsive browser test page, marker `DEXA_FLY_DYNAMIC_OK`.
- `/healthz`: harmless JSON health.
- `/api/ping`: fresh UUID and timestamp per request, safe GET.
- `/api/events`: three bounded SSE events, ~500ms apart.
- Exact CORS allow origin: `https://homayounisaghar.github.io`.

## Build/deploy

`fly.toml` is intentionally minimal, one shared-CPU machine, 256MB, auto-stop on idle, no volume and no dedicated IPv4. `Dockerfile` requires no npm registry or build-time dependency. Run deployment from **this subfolder**, not the repository root.

Do not deploy until Fly auth is confirmed and trial/billing is acceptable. Trial: two total VM-hours OR seven days, whichever comes first; Fly forcibly auto-stops trial Machines after five minutes of running. Adding credit card ends free trial and initiates usage billing. Provider source: https://fly.io/docs/about/free-trial/.

If authenticated, an operator can run `fly deploy --config fly.toml --remote-only` after ensuring target app exists. Exact command/version flags must be checked against installed flyctl. Ensure the app has only shared ingress IP (no paid dedicated IPv4), no paid Postgres or other resources.

**Do not assume success until the *owner-specific* `https://dexa-fly-canary-20261104.fly.dev/` deployment has been observed to respond with valid HTTPS, fresh UUID, and three SSE events, and owner VPN-OFF phone tests have passed.** The earlier VPN-off success of a third-party `*.fly.dev` demo does not prove owner-specific origin.

Original Dexa engine at Hetzner must remain unchanged. After phone success, test Fly→Hetzner reachability with non-sensitive harmless endpoint, then design authenticated bridge separately.
