# cf-mirror — standard mirroring tool (CF server)

Shows a hidden browser (Chrome DevTools/CDP port: Telegram, WhatsApp, Bale, Snapp, Alibaba…) or an X11 display (WeChat on :97 etc.) on a local web page `http://127.0.0.1:PORT/` with mouse + keyboard.

- Real cursor feedback: CDP mirrors switch the viewer cursor to the page's real cursor (pointer/hand on links, text on inputs, grab…); X11 mirrors draw the real X cursor in the image (owner prefers the real cursor).
- Viewport matched to the viewer window (CDP; `--no-fit` to disable; override cleared on stop).
- Live stream (MJPEG). Default `--interval auto`: 0.05 s (20 fps); when whole-server CPU >= 75 % it slows to 0.1 s, then 0.2 s; back to faster after ~15 s below 50 %. Fixed: `--interval 0.1`. Viewer shows current rate + CPU.
- `--open` opens the mirror in the owner's remote desktop (xrdp, DISPLAY :10).
- Local only (binds 127.0.0.1), runs as `cfserver`, Node ≥ 22 stdlib only.

```
cf-mirror list
cf-mirror start tg --cdp 9346 --open
cf-mirror start wechat --x11 :97 --open
cf-mirror status
cf-mirror stop tg   # or: cf-mirror stop all
```

Install (root): `install -D -m0755 tools/cf-mirror/cf-mirror.mjs /usr/local/lib/capability-fabric/cf-mirror/cf-mirror.mjs` and `/usr/local/bin/cf-mirror` = `exec /usr/bin/node /usr/local/lib/capability-fabric/cf-mirror/cf-mirror.mjs "$@"`.
Agents call it via CF-Server `server_exec` (no root needed).
