# Cloudflare Worker route for CF Mirror Universal

Independent public HTTPS bridge. Do not change the existing Dexa Workers.

## Architecture

Android Chrome -> dedicated *.workers.dev Worker -> expiring HTTPS *.trycloudflare.com quick tunnel -> password-protected loopback mirror gateway -> X11 / CDP browser.

The Worker streams JPEG/MJPEG unchanged, forwards login/cookies/control requests, and passes WebSocket 101 connections for /input-ws (mouse) and /mic-ws (remote phone microphone). The original gateway still verifies password, SameSite=Strict HttpOnly session cookies, login CSRF, control HMAC, Origin and TTL. The worker additionally rejects cross-origin mutations and WebSocket upgrades, checks the route expiry, and rewrites the response CSP to its exact WSS hostname. The Worker never opens CDP 9325, X11 or private backend ports.

## Important deployment limitation

The CF Server currently does not have an authenticated Cloudflare deployment connector, Cloudflare API token, or Wrangler executable. The Dexa project notes document manual deployment to two independent account dashboards. This code and its mock tests are committed/prepared but NOT deployed to a live workers.dev URL. Do not describe a guessed workers.dev hostname as working.

## Primary independent Cloudflare account

1. In the primary account's Cloudflare Workers dashboard create a NEW Worker named cf-mirror-bridge; do not overwrite Dexa workers.
2. Paste worker.mjs in the Worker code editor and deploy. Enable its public workers.dev route.
3. Configure plain-text environment bindings (Settings > Variables):
   MIRROR_UPSTREAM = https://<active-mirror>.trycloudflare.com (the currently ACTIVE cf_mirror_open web session, without trailing path)
   PUBLIC_ORIGIN = https://cf-mirror-bridge.<account-subdomain>.workers.dev (the exact newly-created Worker hostname)
   MIRROR_EXPIRES_AT = expiry of that web session as Unix milliseconds (optional but recommended)
4. Deploy the variable changes. Verify GET /__bridge-health returns ok:true. Then test password login, GET /view/, MJPEG image, /input-ws touch movement and /mic-ws standby from an actual Android phone without VPN.
5. Confirm unauthenticated /shot.jpg and both WebSocket paths are rejected; login CSRF and control HMAC still work.

## Backup independent Cloudflare account

Repeat all steps in a separate account, such as the account previously used for Dexa backup. Use a NEW cf-mirror-bridge Worker, the same worker.mjs code, and the BACKUP account's own PUBLIC_ORIGIN. Do not edit existing Dexa Workers. Use backup only after passing the same authentication, streaming and WebSocket tests.

## CLI alternative (only when owner authorizes access)

Install Wrangler on the owner-controlled machine and provide CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment. Also set MIRROR_UPSTREAM, PUBLIC_ORIGIN, MIRROR_EXPIRES_AT. Run sh deploy-one-account.sh. Repeat with the backup account's independent credentials.

## Rotating temporary sessions

The workers.dev hostname is stable, but quick-tunnel upstream hostnames and web passwords are short-lived. Every newly opened cf_mirror_open session requires updating MIRROR_UPSTREAM and MIRROR_EXPIRES_AT on BOTH Workers. The original server still expires its login cookie and session. The Worker cannot revive a stopped quick tunnel and does not create a renewal automation.

Never automatically retry an ambiguous POST, mouse click or audio chunk on a second account: it might duplicate user actions. Switch accounts only with a new login/reconnect. A Worker route does not guarantee accessibility from a particular filtered ISP until tested with that phone, VPN OFF. Worker-to-Cloudflare-tunnel fetch must also be live-tested for Cloudflare-specific loop/route restrictions. Workers have per-account quotas and Browser Integrity Check on workers.dev.

## Tests

node --test tests/worker-proxy.test.mjs

Eleven mocked tests cover login + Cookie, session expiry, CSRF, browser-origin restrictions, CSP/microphone permissions, MJPEG stream, and both WebSocket handshakes. These do not replace testing in the real Cloudflare Workers runtime or an Android device.
