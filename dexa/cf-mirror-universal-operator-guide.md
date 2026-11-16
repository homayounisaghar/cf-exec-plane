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
- Choose a source: `app:"wechat"` or `app:"Terminal"` for automatic selection and exact window pinning; `window:"Xfce4-terminal"` for X11 title/WM_CLASS matching; `x11:":10",window_id:50362571` to pin a specific visible window; `cdp:PORT` optionally with `tab`; or `x11:":124",full:true` for an entire display. Plain `x11:":10"` without a selector retains legacy largest-visible-window behavior. Use `cf_mirror_sources({})` for live X11 `window_details` (`id,title,class`) and unambiguous target selection.
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

Call \`cf_mirror_open\` with \`mode:"local"\` or omit mode. Choose source as above. **Do not ask for or pass \`password\`, \`ttl\` or an expiry time**. The session has no scheduled expiry by default. The returned URL is an \`http://127.0.0.1:<port>/\` loopback URL. **Show this URL as selectable plain text (inline code or a code block) with a prominent one-tap Copy local link control; do NOT render it as a clickable Markdown/DIL hyperlink or a link-like button.** The user must copy it here and paste it into the graphical browser on the server. Use exactly the returned \`url\` value, never guess a port. State the location of use:

**«این آدرس را با دکمهٔ کپی بردار و در مرورگر گرافیکی روی خودِ سرور (XRDP/X11/Chrome سرور) پیست کن؛ از مرورگر گوشی یا رایانهٔ دیگری مستقیم قابل‌استفاده نیست. به رمز، زمان انقضا یا VPN نیاز ندارد.»**

Example local UI (placeholder, NOT a live URL):
- **آدرس لوکال:** \`http://127.0.0.1:<actual-port>/\` shown as plain selectable code, never as a hyperlink.
- **کنترل:** «کپی آدرس لوکال» / **Copy local link**; a functional copy action must copy exactly the returned \`url\` to clipboard.
- **راهنما:** «آدرس را کپی کن و داخل مرورگر خودِ سرور پیست کن.»
- Do not show password, TTL, expiry or VPN badges for local. If the chat UI cannot make a working copy button, use a standard code block with built-in Copy instead.

Local loopback does not provide network-wide user authentication. Any process with the relevant loopback access on the server could interact with a local mirror. Do not expose it through an unprotected public reverse proxy.

## Output contract and tool interfaces

- Source discovery: `cf_mirror_sources({})` lists CDP browsers and X11 windows with exact `window_details[].id/title/class` per display. For an app on a display with several visible windows, use `app` or `window` or `x11` plus `window_id` to pin a single target; do not assume the display equals one app. A window ID belongs to a specific display, and an ambiguous selector must error rather than guess.
- Create: `cf_mirror_open({mode:"web",app:"Terminal",ttl:"5m"})`, `cf_mirror_open({mode:"web",x11:":10",window_id:50362571,ttl:"5m"})`, `cf_mirror_open({mode:"local",app:"wechat"})`, or `cf_mirror_open({mode:"local",x11:":124",full:true})`. `window` and `window_id` are exclusive, and `window_id` requires `x11`.
- Session inspection: \`cf_mirror_status({})\` lists URLs and expiry **without ever re-disclosing web passwords**.
- Revoke: \`cf_mirror_close({name:"exact-session-name"})\` (or \`all\` only on explicit owner request).
- Screenshot if explicitly requested: \`cf_mirror_screenshot({name:"exact-session-name"})\`.
- Web result fields: \`{ok,name,mode:"web",source,url,local_url,expires_at,interval,password,note,presentation}\`.
- Local result fields: \`{ok,name,mode:"local",source,url,local_url,expires_at:null,interval,note,presentation}\` with **no** password.
- For LOCAL, \`presentation.url_display=copy_only\`, \`url_copyable=true\`, \`url_clickable=false\`, \`copy_value=url\`, and \`copy_label\` direct the copy-first UI; for WEB keep the HTTPS URL tappable and the password copyable.
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

## Exact X11 window framing and pinning (2026-11-16)

The mirror X11 engine reads `xdotool getwindowgeometry --shell` for client coordinates, then queries `xprop -id WINDOW_ID _NET_FRAME_EXTENTS` and expands x/y/width/height by the reported left/right/top/bottom frame offsets. It clips to X11 display bounds and uses even grab dimensions, preferring to round up so the last border pixel remains. For native undecorated Xvfb windows with no EWMH extents, it leaves client geometry unchanged. The Terminal on `:10` showed actual outer capture `(311,1280,828,518)` instead of client-only `818×483`, and WeChat on `:97` remained `912×666` in live validation. The `source.windowId` returned with an app/window selection is used by the running backend and remains fixed; closing or hiding the pinned window stops capture instead of switching to a different app. Existing x11-only calls stay compatible, but may select a different largest window when the display changes. X11 capture samples the actual display region, so overlapping windows on the same desktop can still appear over the target; this does not isolate an occluded app's framebuffer. All new sessions use the updated engine without modifying current active ones.

## Viewer input toggle (2026-11-16)

The same mirror viewer has a **Mouse / Touchpad** toggle among its bottom buttons. **LOCAL mirrors default to Mouse** (visible desktop pointer, absolute click/tap and drag). **INTERNET/WEB mirrors default to Touchpad** (relative movement, touchpad taps click at the current remote cursor, optional ⌖ predictive cursor ring). Either mode can be selected manually in either mirror without creating a new session; selection is retained for the current browser tab using `sessionStorage`. A refresh of the server browser (`Ctrl+Shift+R`) activates the input mode toolbar on a previously running mirror. This is an input interaction choice, **not** a VPN workaround, security control or transport mode. No password or TTL is added to a local mirror by switching input mode. Do not confuse these defaults when presenting a new mirror.

The public and local workflows are deliberately distinct. Internet mode always has an access password and expiry. Local mode has neither; passing TTL in LOCAL is rejected by both the official MCP adapter and the CLI.
