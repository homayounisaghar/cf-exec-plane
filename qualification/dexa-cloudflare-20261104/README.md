# Dexa Cloudflare Workers Free VPN-off connectivity probe

**No secrets, no private API, no authentication, no Dexa runtime migration.** The only external fetch is exact harmless public static Hetzner origin `https://dexa-probe.65-109-215-241.sslip.io/`. No user-defined forwarding target.

GitHub source: `homayounisaghar/cf-exec-plane`, branch `dexa-cloudflare-canary-20261104`. Worker name and `wrangler.toml` both `dexa-cf-worker-canary-20261104`.

## Deploy (Free, no paid activation)

1. Go to https://dash.cloudflare.com/ > Workers & Pages > Create application > GitHub.
2. Authorize ONLY the public `cf-exec-plane` repo, select branch **`dexa-cloudflare-canary-20261104`**, root folder `/`. Not `main`.
3. Make Worker name **`dexa-cf-worker-canary-20261104`** (must match `wrangler.toml`), select the **Free** plan; deployment command: `npx wrangler deploy`; no build command necessary.
4. Deploy and inspect actual `*.workers.dev` URL from dashboard. Do not invent hostname: Worker uses account-specific subdomain.
5. Verify root HTML, fresh GET `/api/ping`, three SSE messages `/api/events`, fixed read-only GET `/api/hetzner-public-check`.
6. Owner must test real URL **VPN OFF**. The owner's earlier test of `*.pages.dev` was blocked; `*.workers.dev` and custom hostname may also be blocked in Iran. Do not claim reachable before phone test.

Cloudflare Workers Free terms 2026: 100,000 requests/day, 10 ms CPU/request, 128MB, 50 subrequests/request. This is **not** a persistent container. SSE is client-tied; long-lived actual Dexa routing remains separately unproven. Do not put secrets on this public repo, Workers environment or any provider before explicit authorization.
