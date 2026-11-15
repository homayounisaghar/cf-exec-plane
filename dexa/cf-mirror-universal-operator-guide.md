# CF Universal Mirror — operator contract (2026-11-16)

Status: **feature complete** for local and time-limited public mirroring. The transport is **best effort**. Public Quick Tunnel does **not** guarantee usable access without VPN. No claim of VPN-free streaming.

## Natural-language activation / discovery

Call the existing **CF Server** connector tool \`cf_mirror_open\` whenever the owner asks to *create, open, give, build, start, share, publish, mirror or remote-view* a specific Chrome/CDP tab, browser session, or X11 application. Persian trigger examples:

- «از تلگرام روی سرور یه میرورینگ ۳۰ دقیقه‌ای روی اینترنت بده»
- «مرورگر مخفی رو ۵ ساعت میرور کن»
- «از وی‌چت یه لینک میرورینگ ۲۰ دقیقه‌ای بساز»
- «یه میرورینگ لوکال از آنشیپ/کروم بده که توی دسکتاپ سرور باز کنم»

English trigger examples: "Create a web mirror of my browser for 1 hour", "Give me a local mirror link for the server desktop".

**Do not** substitute a separate Cloudflare account, a direct VPS URL, a Dexa UI, or a new Worker deployment for this tool. Do not reopen the VPN-free debugging investigation when the request is simply to create a mirror. If the target is not uniquely known, first call \`cf_mirror_sources\` and select the exact CDP port/tab or X11 display; ask only for genuinely ambiguous targets. Existing \`cf_mirror_status\` and \`cf_mirror_close\` manage lifecycle.

## Public / internet mirror

Call \`cf_mirror_open\` with:
- \`mode:"web"\` — **only** for an explicitly internet/public/phone-accessible mirror.
- Exactly one source selector when known: \`app:"telegram"\`, \`app:"wechat"\`, \`cdp:PORT\` (optionally \`tab\`), or \`x11:":124"\` (optionally \`full:true\`). Use \`cf_mirror_sources\` to resolve a requested app/unknown source.
- \`ttl:"5h"\`, \`ttl:"30m"\`, etc., from the owner's requested duration. Supported: 30 seconds to 24 hours. \`ttl\` defaults to 5 minutes if public mode is requested without a duration. **Do not request a password:** omission auto-generates a high-entropy password, shown once in creation response. Never give this password to anyone else.

After the tool returns \`ok:true\`, present the ACTUAL returned \`url\` as a clickable/tappable HTTPS hyperlink; present the ACTUAL \`password\` as an easily selectable/copyable code string or a **Copy password** button. Show the actual \`expires_at\` in user's local time zone, without inventing a date/time. Always give this warning in Persian when addressing a Persian user:

**«این لینک عمومی از Cloudflare Quick Tunnel استفاده می‌کند؛ برای باز کردن صفحه، دریافت تصویر و کنترل میرور ممکن است به روشن‌کردن VPN نیاز داشته باشی. استفاده بدون VPN تضمین نشده و خود تونل هم ممکن است پیش از پایان زمان انتخاب‌شده قطع شود.»**

The link opens a password screen first; the phone browser can store a Secure/HttpOnly/SameSite=Strict session cookie after authentication. If the owner clicks a link from a different app/tab, the cookie can be withheld; advise first opening the returned public URL normally, logging in, and continuing on the same origin. Never demand their email/site passwords, MFA or OAuth codes in chat. Full remote input/control is granted to anyone who possesses both the public URL and mirror password; explain confidentiality when necessary.

Sample UI (placeholders, not real credentials):
- **لینک میرور:** [باز کردن میرور](https://example.invalid/). Replace with the returned \`url\`.
- **رمز ورود:** \`<actual returned password>\`, with a copy control.
- **پایان اعتبار:** \`<actual expires_at>\`, converted to user local zone.
- **هشدار:** «احتمالاً لازم است VPN روشن باشد.»

## Local (server-graphical) mirror

Call \`cf_mirror_open\` with \`mode:"local"\` or omit mode. Choose source as above. **Do not ask for or pass \`password\`, \`ttl\` or an expiry time**. The session has no scheduled expiry by default. The returned URL is an \`http://127.0.0.1:<port>/\` loopback URL; present it as a clickable link, alongside the explicit location of use:

**«این لینک را در مرورگر گرافیکی روی خودِ سرور (XRDP/X11/Chrome سرور) باز کن؛ از مرورگر گوشی یا رایانهٔ دیگری مستقیم قابل‌استفاده نیست. به رمز، زمان انقضا یا VPN نیاز ندارد.»**

Local loopback does not provide network-wide user authentication. Any process with the relevant loopback access on the server could interact with a local mirror. Do not expose it through an unprotected public reverse proxy.

## Output contract and tool interfaces

- Source discovery: \`cf_mirror_sources({})\`.
- Create: \`cf_mirror_open({mode:"web",app:"telegram",ttl:"30m"})\` or \`cf_mirror_open({mode:"local",x11:":124",full:true})\`.
- Session inspection: \`cf_mirror_status({})\` lists URLs and expiry **without ever re-disclosing web passwords**.
- Revoke: \`cf_mirror_close({name:"exact-session-name"})\` (or \`all\` only on explicit owner request).
- Screenshot if explicitly requested: \`cf_mirror_screenshot({name:"exact-session-name"})\`.
- Web result fields: \`{ok,name,mode:"web",source,url,local_url,expires_at,interval,password,note,presentation}\`.
- Local result fields: \`{ok,name,mode:"local",source,url,local_url,expires_at:null,interval,note,presentation}\` with **no** password.
- \`presentation\` fields are hints for assistants, not a transport guarantee. Always use actual tool output rather than inventing a link, password, port or expiry.

## Closed VPN-free investigation (2026-11-15)

This project is accepted as complete **with a documented transport limitation**, not as a guaranteed no-VPN service. In tests, un-VPN'd Quick Tunnel JPEG HTTP GET sometimes succeeded and sometimes timed out before headers. VPN-on 10/10 JPEG requests succeeded in ~0.45–0.62s per file. One no-VPN run had 5/10 successful, each starting at ~10.6s; another run failed due to tunnel/server failure (HTTP 530) and was not diagnostic of JPEG encoding. MJPEG was unreliable without VPN. Stable HTTPS direct origin also was not reachable from the user's mobile without VPN. Two additional test links were not usable for the owner, so no stable Worker VPN-free success has been proven.

**Do not suggest that the absence of VPN is supported** or silently resume transport experiments in ordinary "create a mirror" workflows. Keep \`cf_mirror_open\` as the default public/local mirror tool. Neither a public mirror nor its live password is ever published into a public catalog.

## Publication / source of truth

- Host shortcut: \`/home/cfserver/.local/bin/cf-mirror-any\`.
- Host implementation: \`/home/cfserver/.local/share/cf-mirror-universal/cf-mirror-universal.mjs\`.
- CF native MCP adapter: \`/home/cfserver/.local/share/cf-mirror-universal/cf-mirror-mcp-tools.mjs\`.
- CF GitHub registry: \`homayounisaghar/cf-exec-plane/tools/cf-mirror/universal/\`.
- Dexa authenticated owner catalog: \`tool.cf.cf_mirror_open\`, \`tool.cf.cf_mirror_sources\`, \`tool.cf.cf_mirror_status\`, \`tool.cf.cf_mirror_close\`, \`tool.cf.cf_mirror_screenshot\`; the tools remain subject to existing owner OAuth, physical runtime and exact input schemas. The catalog does not grant access by itself.
- Public Dexa knowledge: \`homayounisaghar/cf-exec-plane/dexa/cf-mirror-universal-operator-guide.md\` and reference from \`dexa/catalog-mvp.md\`.

## Viewer input toggle (2026-11-16)

The same mirror viewer has a **Mouse / Touchpad** toggle among its bottom buttons. **LOCAL mirrors default to Mouse** (visible desktop pointer, absolute click/tap and drag). **INTERNET/WEB mirrors default to Touchpad** (relative movement, touchpad taps click at the current remote cursor, optional ⌖ predictive cursor ring). Either mode can be selected manually in either mirror without creating a new session; selection is retained for the current browser tab using `sessionStorage`. A refresh of the server browser (`Ctrl+Shift+R`) activates the input mode toolbar on a previously running mirror. This is an input interaction choice, **not** a VPN workaround, security control or transport mode. No password or TTL is added to a local mirror by switching input mode. Do not confuse these defaults when presenting a new mirror.

The public and local workflows are deliberately distinct. Internet mode always has an access password and expiry, local mode has neither unless the caller deliberately chooses a nonstandard local TTL at CLI level.
