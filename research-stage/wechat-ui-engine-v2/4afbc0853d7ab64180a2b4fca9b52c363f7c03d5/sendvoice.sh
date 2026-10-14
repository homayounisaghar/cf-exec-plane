#!/bin/bash
# WeChat general tool: send ONE owner-chosen audio file (any Telegram voice/audio, link or path) to
# a chosen WeChat chat as a NATIVE voice message. Owner requested (2026-10-14).
# Usage: bash sendvoice.sh <https-link|relative-download-path|local-path|NONE> [wechat_chat_name, default "File Transfer"] [expected_size_bytes] [base_url]
# Writes everything to /tmp/wxeng/sendvoice/ . Sends at most once (one-shot marker).
set -u
SRC="${1:-}"; CHAT="${2:-File Transfer}"; EXP="${3:-}"
OUT=/tmp/wxeng/sendvoice
mkdir -p "$OUT" /tmp/wxeng/in; rm -f "$OUT"/STATUS "$OUT"/SUMMARY.json "$OUT"/*.png "$OUT"/send_voice.json
find /tmp/wxeng/in -type f -mtime +2 -delete 2>/dev/null
exec > "$OUT/console.txt" 2>&1 < /dev/null
step(){ echo; echo "===== $* ($(date +%T))"; }
shot(){ ( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c 'ffmpeg -nostdin -v error -y -f x11grab -draw_mouse 0 -i "$DISPLAY" -frames:v 1 "$0"' "$OUT/$1" ) || echo "SHOT_FAILED $1"; }
step GET_AUDIO
F=""
BASE="${4:-}"
okaudio(){ [ -s "$1" ] && ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null | grep -q '[0-9]' && { [ -z "$EXP" ] || [ "$(stat -c %s "$1")" = "$EXP" ]; }; }
TMPD=/tmp/wxeng/in/voice_in.bin
case "$SRC" in
  http://*|https://*)
    curl -fsSL --max-time 120 "$SRC" -o "$TMPD" && okaudio "$TMPD" && F="$TMPD" || echo "DOWNLOAD_FAILED";;
  ""|NONE) echo "NO_LINK_GIVEN";;
  *)
    if [ -f "$SRC" ] && okaudio "$SRC"; then F="$SRC"
    else
      # Relative download path from the CF server: try the given base URL, then
      # every local web port of this server (the CF server runs here), 127.0.0.1 only.
      REL="/${SRC#/}"
      PORTS=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -nE 's/^(127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]|\[::1\]):([0-9]+)$/\2/p' | sort -un)
      for B in $BASE $(for p in $PORTS; do echo "http://127.0.0.1:$p"; done); do
        rm -f "$TMPD"
        if curl -fsSL --max-time 60 "${B%/}$REL" -o "$TMPD" 2>/dev/null && okaudio "$TMPD"; then F="$TMPD"; echo "downloaded via ${B%/} (relative path)"; break; fi
      done
      [ -z "$F" ] && echo "RELATIVE_PATH_NOT_REACHABLE $REL ports=$(echo $PORTS)"
    fi;;
esac
if [ -z "$F" ] && [ -n "$EXP" ]; then
  echo "searching the server for a recent audio file of exactly $EXP bytes"
  for C in $(timeout 90 find /var/lib /srv /opt /home /tmp /var/tmp /run -xdev -type f -not -path '/tmp/wxeng/*' -size "${EXP}c" -mmin -1440 -readable -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -5 | cut -d' ' -f2-); do
    if okaudio "$C"; then F="$C"; echo "found $C"; break; fi
  done
  [ -z "$F" ] && echo "no readable file of that size (it may be stored under another user that this account cannot read)"
fi
if [ -z "$F" ] || [ ! -s "$F" ]; then echo "STOP AUDIO_NOT_AVAILABLE"; echo STOPPED_NO_AUDIO > "$OUT/STATUS"; exit 1; fi
B=/tmp/wxeng/in/voice_$(date +%Y%m%d_%H%M%S); cp -f "$F" "$B" && F="$B"; rm -f /tmp/wxeng/in/voice_in.bin
SIZE=$(stat -c %s "$F"); DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$F" 2>/dev/null | head -1)
CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$F" 2>/dev/null | head -1)
echo "audio size=$SIZE duration=$DUR codec=$CODEC sha256=$(sha256sum "$F" | cut -c1-16)"
printf '{"size": %s, "duration": "%s", "codec": "%s", "expected_size": "%s"}\n' "$SIZE" "$DUR" "$CODEC" "$EXP" > "$OUT/audio.json"
if [ -z "$DUR" ]; then echo "STOP AUDIO_UNREADABLE"; echo STOPPED_AUDIO_UNREADABLE > "$OUT/STATUS"; exit 1; fi
N=$(python3 -c "import math;print(max(1,math.ceil(float('$DUR')/55)))")
if [ "$N" -gt 6 ]; then echo "STOP TOO_LONG"; echo STOPPED_TOO_LONG > "$OUT/STATUS"; exit 1; fi
L=/tmp/wx-v11.sh
step LOADER
curl -fsSL "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/22b2197dbcd43b5fffd090783860db4137f5d147/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/stage-and-run.sh" -o $L
H=$(git hash-object $L); echo "loader_blob=$H"
if [ "$H" != "ecdb4ec6dda2f4cc1fe7c8b0bf26b38e9251cc3e" ]; then echo "STOP LOADER_HASH_MISMATCH"; echo STOPPED > "$OUT/STATUS"; exit 1; fi
sh $L --stage-only | tee "$OUT/stage.txt"
if ! grep -q "WX_V11_STAGE_OK files=23 hashes=23" "$OUT/stage.txt"; then echo "STOP STAGE_FAILED"; echo STOPPED > "$OUT/STATUS"; exit 1; fi
rm -f /tmp/wxeng/v10_search_dump.json /tmp/wxeng/voice_toggle_*.png
step SHOT_BEFORE; shot before.png
step WINDOWS_FIX
cat > "$OUT/winfix.py" <<'WINEOF'
# Inventory of ALL visible X windows + gracefully close WeChat's own web/search
# windows that cover the WeChat main window (WM_DELETE_WINDOW = same as clicking X).
# Never touches the WeChat main window, never sends keys.
import ctypes, json, os, re, subprocess, sys, time
OUT = sys.argv[1]
DO_CLOSE = "--close" in sys.argv
def sh(*a):
    try:
        return subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                              timeout=5, text=True).stdout
    except Exception:
        return ""
def geom(w):
    g = dict(l.split("=", 1) for l in sh("xdotool", "getwindowgeometry", "--shell", w).splitlines() if "=" in l)
    try:
        return [int(g["X"]), int(g["Y"]), int(g["WIDTH"]), int(g["HEIGHT"])]
    except Exception:
        return None
def cmdline(pid):
    try:
        return open("/proc/%s/cmdline" % pid, "rb").read().replace(b"\0", b" ").decode("utf8", "replace")[:200]
    except Exception:
        return ""
def overlap(a, b):
    return a and b and a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]
def inventory():
    main_pid = (sh("pgrep", "-u", str(os.getuid()), "-x", "wechat").split() or [None])[0]
    rows = []
    for w in sh("xdotool", "search", "--onlyvisible", "--name", ".").split()[:80]:
        p = sh("xprop", "-id", w, "WM_NAME", "_NET_WM_NAME", "WM_CLASS", "_NET_WM_PID", "WM_PROTOCOLS",
               "WM_TRANSIENT_FOR", "_NET_WM_WINDOW_TYPE")
        name = re.search(r'^_NET_WM_NAME[^=]*=\s*"(.*)"', p, re.M) or re.search(r'^WM_NAME[^=]*=\s*"(.*)"', p, re.M)
        cls = re.search(r'^WM_CLASS[^=]*=\s*(.*)$', p, re.M)
        pid = re.search(r'^_NET_WM_PID[^=]*=\s*(\d+)', p, re.M)
        pid = pid.group(1) if pid else None
        rows.append({"id": w, "name": name.group(1)[:80] if name else "", "class": cls.group(1)[:80] if cls else "",
                     "pid": pid, "cmd": cmdline(pid) if pid else "", "geometry": geom(w),
                     "deletable": "WM_DELETE_WINDOW" in p, "is_main": pid == main_pid and bool(name)
                     and name.group(1) == "WeChat", "type": (re.search(r'^_NET_WM_WINDOW_TYPE[^=]*=\s*(.*)$', p, re.M)
                                                            or [None, ""])[1][:80] if True else ""})
    return main_pid, rows
DANGER = re.compile(r"log ?in|log ?out|sign|verify|password|\u767b\u5f55|\u9000\u51fa|\u9a8c\u8bc1", re.I)
def candidates(main_pid, rows):
    mains = [r for r in rows if r["is_main"]]
    if len(mains) != 1:
        return [], "MAIN_NOT_UNIQUE"
    m = mains[0]
    out = []
    for r in rows:
        if r is m or r["pid"] in (None, main_pid):
            continue
        family = "wechat" in (r["cmd"] + " " + r["class"]).casefold() or "xweb" in r["cmd"].casefold() \
            or "wmpf" in r["cmd"].casefold() or "radium" in r["cmd"].casefold()
        if family and r["deletable"] and overlap(r["geometry"], m["geometry"]) and not DANGER.search(r["name"]):
            out.append(r)
    return out, None
def wm_delete(wid):
    X = ctypes.cdll.LoadLibrary("libX11.so.6")
    X.XOpenDisplay.restype = ctypes.c_void_p
    X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XInternAtom.restype = ctypes.c_ulong
    X.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    class CM(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]
    class EV(ctypes.Union):
        _fields_ = [("xclient", CM), ("pad", ctypes.c_long * 24)]
    X.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(EV)]
    d = X.XOpenDisplay(None)
    if not d:
        return "NO_DISPLAY"
    ev = EV()
    ev.xclient.type = 33  # ClientMessage
    ev.xclient.window = int(wid)
    ev.xclient.message_type = X.XInternAtom(d, b"WM_PROTOCOLS", 0)
    ev.xclient.format = 32
    ev.xclient.l[0] = X.XInternAtom(d, b"WM_DELETE_WINDOW", 0)
    ev.xclient.l[1] = 0
    st = X.XSendEvent(d, int(wid), 0, 0, ctypes.byref(ev))
    X.XFlush(d)
    X.XCloseDisplay(d)
    return "sent" if st else "send_failed"
if __name__ == "__main__":
    main_pid, before = inventory()
    cands, err = candidates(main_pid, before)
    rep = {"main_pid": main_pid, "before": before, "error": err, "to_close": [c["id"] for c in cands], "closed": []}
    if DO_CLOSE and not err:
        for c in cands[:3]:
            rep["closed"].append({"id": c["id"], "name": c["name"], "result": wm_delete(c["id"])})
        if cands:
            time.sleep(2.5)
    rep["after"] = inventory()[1]
    rep["covering_after"] = [r["id"] for r in candidates(main_pid, rep["after"])[0]]
    json.dump(rep, open(OUT, "w"), ensure_ascii=False, indent=1)
    print("WINFIX to_close=%d closed=%s covering_after=%d" % (len(cands), [c["result"] for c in rep["closed"]],
                                                             len(rep["covering_after"])))
WINEOF
( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/winfix.py" "$OUT/windows_before.json" --close )
step PULSE_FIND
cat > "$OUT/pulsefind.py" <<'PFEOF'
# READ-ONLY: which PulseAudio server(s) exist, which one (if any) WeChat is
# connected to, and WeChat's own HOME audio config. Writes ONE small config
# file only with --fix: <WeChat HOME>/.config/pulse/client.conf if it is absent.
import json, os, re, subprocess, sys
OUT, FIX = sys.argv[1], "--fix" in sys.argv
uid = os.getuid()
def run(*a):
    try:
        return subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                              timeout=10, text=True).stdout
    except Exception:
        return ""
def comm(p):
    try: return open("/proc/%s/comm" % p).read().strip()
    except Exception: return ""
def env_of(p, keys=("HOME", "XDG_RUNTIME_DIR", "PULSE_SERVER", "PULSE_RUNTIME_PATH", "DISPLAY")):
    try:
        e = dict(x.decode("utf8", "replace").split("=", 1) for x in open("/proc/%s/environ" % p, "rb").read().split(b"\0") if b"=" in x)
    except Exception:
        return {}
    return {k: e[k] for k in keys if k in e}
pids = [d for d in os.listdir("/proc") if d.isdigit() and os.path.exists("/proc/" + d)
        and os.stat("/proc/" + d).st_uid == uid]
def fd_inodes(p):
    out = set()
    try:
        fds = os.listdir("/proc/%s/fd" % p)
    except Exception:
        fds = []
    for f in fds:
        try:
            t = os.readlink("/proc/%s/fd/%s" % (p, f))
            if t.startswith("socket:["): out.add(t[8:-1])
        except Exception:
            pass
    return out
listen = {}
try:
    for l in open("/proc/net/unix").read().splitlines()[1:]:
        f = l.split()
        if len(f) >= 8 and f[3] == "00010000" and f[7].startswith("/"):
            listen[f[6]] = f[7]
except Exception:
    pass
servers = []
for p in pids:
    if comm(p) == "pulseaudio":
        socks = sorted({listen[i] for i in fd_inodes(p) if i in listen})
        servers.append({"pid": p, "cmd": open("/proc/%s/cmdline" % p, "rb").read().replace(b"\0", b" ").decode()[:120],
                        "started": run("ps", "-o", "lstart=", "-p", p).strip(), "env": env_of(p), "listen": socks})
wech = [p for p in pids if comm(p) in ("wechat", "WeChatAppEx", "wxplayer", "wxutility")]
conn = {}
for sv in servers:
    for sock in sv["listen"]:
        if not sock.endswith("native"): continue
        e = dict(os.environ, PULSE_SERVER="unix:" + sock)
        try:
            txt = subprocess.run(("pactl", "list", "clients"), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 stdin=subprocess.DEVNULL, timeout=10, text=True, env=e).stdout
        except Exception:
            txt = ""
        sv.setdefault("clients", {})[sock] = re.findall(r'application\.process\.binary = "([^"]*)"', txt)[:20]
        for blk in txt.split("Client #"):
            m = re.search(r'application\.process\.id = "(\d+)"', blk)
            if m and m.group(1) in wech:
                conn.setdefault(m.group(1) + ":" + comm(m.group(1)), {"pulse": []})["pulse"].append(sock)
main = [p for p in wech if comm(p) == "wechat"]
whome = env_of(main[0]).get("HOME") if main else None
rep = {"ss_wechat": [l[:160] for l in run("ss", "-xpn").splitlines() if "pulse" in l][:10],
       "pulse_servers": servers, "wechat_connections": conn, "wechat_home": whome}
mid = (open("/etc/machine-id").read().strip() if os.path.exists("/etc/machine-id") else "")
if whome:
    d = os.path.join(whome, ".config", "pulse")
    rep["wechat_home_pulse_dir"] = run("ls", "-la", d)[:700] or "missing"
    rt = os.path.join(d, mid + "-runtime")
    rep["wechat_runtime_link"] = os.path.realpath(rt) if os.path.lexists(rt) else None
    cc = os.path.join(d, "client.conf")
    rep["wechat_client_conf"] = open(cc).read()[:300] if os.path.exists(cc) else None
wpulse = sorted({x for v in conn.values() for x in v["pulse"]})
mine = re.search(r"^Server String:\s*(\S+)", run("pactl", "info"), re.M)
mine = mine.group(1) if mine else ""
rep["wechat_pulse_sockets"] = wpulse
rep["our_server"] = mine
# Target = the server WeChat already talks to (no restart needed); else our server.
target = wpulse[0] if len(wpulse) == 1 else (mine if mine else "")
if target and not target.startswith("unix:"): target = "unix:" + target
rep["target"] = target
rep["target_reason"] = "wechat_connected" if len(wpulse) == 1 else ("ambiguous:%d" % len(wpulse) if wpulse else "wechat_not_connected_use_ours")
if FIX and whome and target and rep.get("wechat_client_conf") is None and not wpulse:
    try:
        os.makedirs(os.path.join(whome, ".config", "pulse"), exist_ok=True)
        with open(os.path.join(whome, ".config", "pulse", "client.conf"), "x") as f:
            f.write("# written by WeChat engine v11.14 (owner approved): WeChat finds PulseAudio\ndefault-server = %s\n" % target)
        rep["fix"] = "WECHAT_CLIENT_CONF_WRITTEN"
    except Exception as e:
        rep["fix"] = "WRITE_FAILED:" + type(e).__name__
else:
    rep["fix"] = "NOT_NEEDED_OR_EXISTS"
json.dump(rep, open(OUT, "w"), ensure_ascii=False, indent=1)
open(OUT + ".target", "w").write(target)
print("PULSEFIND servers=%d wechat_pulse=%s target=%s fix=%s" % (len(servers), wpulse, target, rep["fix"]))
PFEOF
python3 "$OUT/pulsefind.py" "$OUT/pulse_find.json" --fix
T=$(cat "$OUT/pulse_find.json.target" 2>/dev/null)
if [ -n "$T" ]; then export PULSE_SERVER="$T"; echo "voice test uses PULSE_SERVER=$T"; fi
step LOGIN_OWNER_APPROVED_NO_RESTART
cat > "$OUT/loginui.py" <<'LUEOF'
# WeChat login screen helper (owner approved re-login). READ: is the real chat
# window there (a showing list named "Chats") or a login screen (button "Open
# WeChat"/"Log in"/...)? With --press: press that ONE button once — AT-SPI action
# first; if WeChat offers no action, ONE mouse click on the button centre
# (position verified from WeChat's own window). Never keys.
import json, os, re, subprocess, sys, gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
OUT, PRESS = sys.argv[1], "--press" in sys.argv
LOGIN = {"open wechat", "log in", "login", "enter wechat", "\u8fdb\u5165\u5fae\u4fe1", "\u767b\u5f55", "\u6253\u5f00\u5fae\u4fe1"}
uid = os.getuid()
d = Atspi.get_desktop(0)
rows, buttons, chats, frames, wpid = [], [], 0, [], None
for i in range(d.get_child_count()):
    a = d.get_child_at_index(i)
    try:
        pid = a.get_process_id()
        if os.stat("/proc/%d" % pid).st_uid != uid or open("/proc/%d/comm" % pid).read().strip() != "wechat":
            continue
    except Exception:
        continue
    wpid = pid
    for k in range(a.get_child_count()):
        f = a.get_child_at_index(k)
        try:
            if f and f.get_state_set().contains(Atspi.StateType.SHOWING):
                e = f.get_extents(Atspi.CoordType.SCREEN); frames.append((f.get_name() or "", e.x, e.y, e.width, e.height))
        except Exception:
            pass
    st, n = [a], 0
    while st and n < 2000:
        x = st.pop(); n += 1
        if x is None: continue
        try:
            sh = x.get_state_set().contains(Atspi.StateType.SHOWING)
            role, name = x.get_role_name(), (x.get_name() or "").strip()
        except Exception:
            continue
        if sh and name and len(rows) < 80: rows.append([role, name[:60]])
        if sh and "list" in role and "item" not in role and name == "Chats": chats += 1
        if sh and role in ("push button", "button") and name.casefold() in LOGIN: buttons.append((x, name))
        for k in range(min(x.get_child_count(), 150) - 1, -1, -1): st.append(x.get_child_at_index(k))
rep = {"visible": rows, "chats_lists": chats, "login_buttons": [b[1] for b in buttons], "frames": frames}
rep["logged_in"] = chats >= 1 and not buttons
if PRESS and len(buttons) == 1 and not rep["logged_in"]:
    b = buttons[0][0]
    act = b.get_action_iface()
    names = [act.get_action_name(k) for k in range(act.get_n_actions())] if act else []
    rep["actions"] = names
    k = next((k for k, nm in enumerate(names) if nm.casefold() in ("press", "click", "activate")), None)
    ok = False
    if act is not None and k is not None:
        try: ok = bool(act.do_action(k))
        except Exception: ok = False
    rep["pressed_by"] = "atspi_action" if ok else None
    if not ok and len(frames) == 1:
        # Map AT-SPI (logical) to X (physical) with WeChat's own window geometry.
        ids = subprocess.run(("xdotool", "search", "--onlyvisible", "--pid", str(wpid), "--name", "."),
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.split()
        geo = []
        for w in ids:
            g = dict(l.split("=", 1) for l in subprocess.run(("xdotool", "getwindowgeometry", "--shell", w),
                     stdout=subprocess.PIPE, text=True).stdout.splitlines() if "=" in l)
            try: geo.append((w, int(g["X"]), int(g["Y"]), int(g["WIDTH"]), int(g["HEIGHT"])))
            except Exception: pass
        _, fx, fy, fw, fh = frames[0]
        fit = [g for g in geo if fw and fh and 0.9 < g[3] / fw < 1.2 and 0.9 < g[4] / fh < 1.2]
        if len(fit) == 1:
            w, X, Y, W, Hh = fit[0]
            s = W / fw
            e = b.get_extents(Atspi.CoordType.SCREEN)
            px = round(X + (e.x - fx + e.width / 2) * s); py = round(Y + (e.y - fy + e.height / 2) * s)
            rep["click"] = {"window": w, "scale": round(s, 4), "x": px, "y": py}
            if X <= px < X + W and Y <= py < Y + Hh:
                rc = subprocess.run(("xdotool", "mousemove", str(px), str(py), "click", "1"),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
                rep["pressed_by"] = "pointer_click" if rc == 0 else None
        else:
            rep["click"] = {"error": "WINDOW_NOT_UNIQUE", "candidates": len(fit)}
json.dump(rep, open(OUT, "w"), ensure_ascii=False, indent=1)
print("LOGINUI chats=%d login_buttons=%s logged_in=%s pressed_by=%s" % (chats, rep["login_buttons"], rep["logged_in"], rep.get("pressed_by")))
LUEOF
cat > "$OUT/mirror.py" <<'MREOF'
# Private LOCAL-ONLY live view (127.0.0.1) of WeChat's hidden screen, so the
# owner can open it in the server's own desktop browser and scan a login QR
# code with his phone (owner requested). 1 frame/second, secret path, stops
# automatically after login or after 15 minutes. Not reachable from the internet.
import http.server, os, socketserver, sys
DIR, PORT, TOKEN = sys.argv[1], int(sys.argv[2]), sys.argv[3]
PAGE = ("<!doctype html><meta name=viewport content='width=device-width'><title>WeChat</title>"
        "<body style='margin:0;background:#222'><img id=i style='max-width:100%' src='f.jpg'>"
        "<script>setInterval(function(){document.getElementById('i').src='f.jpg?'+Date.now()},1000)</script>")
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/%s/" % TOKEN, "/%s" % TOKEN):
            body, ct = PAGE.encode(), "text/html"
        elif path == "/%s/f.jpg" % TOKEN:
            try: body = open(os.path.join(DIR, "frame.jpg"), "rb").read()
            except Exception: body = b""
            ct = "image/jpeg"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
S(("127.0.0.1", PORT), H).serve_forever()
MREOF
cat > "$OUT/login.py" <<'LGEOF'
# Wait until WeChat is REALLY logged in (chat list "Chats" showing, no login
# button), max 12 min. Press the login button once (owner approved; owner then
# confirms on his phone). If not logged in 25 s after that: start the
# LOCAL-ONLY live view and put its link in STATUS for the owner. No keys ever.
import json, os, secrets, subprocess, sys, time
OUT = sys.argv[1]
ENV = ["bash", "/tmp/wxeng/with_wechat_env.sh"]
rep = {"events": []}
T0 = time.time()
def ev(x): rep["events"].append([round(time.time() - T0), x]); print("LOGIN", x, flush=True)
def ui(press=False):
    f = os.path.join(OUT, "login_ui_press.json" if press else "login_ui.json")
    try:
        subprocess.run(ENV + ["python3", os.path.join(OUT, "loginui.py"), f] + (["--press"] if press else []),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                       timeout=60, cwd="/tmp/wxeng")
        return json.load(open(f))
    except Exception:
        return {}
pressed_at, procs = None, []
mdir = os.path.join(OUT, "mirror"); os.makedirs(mdir, exist_ok=True)
while time.time() - T0 < 720:
    u = ui()
    if u.get("logged_in"):
        ev("LOGGED_IN chats=%s" % u.get("chats_lists")); rep["logged_in"] = True; break
    if pressed_at is None and u.get("login_buttons"):
        p = ui(press=True); pressed_at = time.time()
        ev("PRESS %s by=%s click=%s" % (p.get("login_buttons"), p.get("pressed_by"), p.get("click")))
        rep["press"] = {k: p.get(k) for k in ("login_buttons", "actions", "pressed_by", "click", "frames")}
    wait_from = pressed_at or T0
    if time.time() - wait_from > 25 and not procs:
        port = 8100 + secrets.randbelow(800); tok = secrets.token_urlsafe(9)
        procs.append(subprocess.Popen(ENV + ["sh", "-c", 'exec ffmpeg -nostdin -v error -f x11grab -draw_mouse 0 -framerate 1 -i "$DISPLAY" -q:v 5 -update 1 -y "$0/frame.jpg"', mdir],
                                      cwd="/tmp/wxeng", stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        procs.append(subprocess.Popen(["python3", os.path.join(OUT, "mirror.py"), mdir, str(port), tok],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        url = "http://127.0.0.1:%d/%s/" % (port, tok)
        open(os.path.join(OUT, "STATUS"), "w").write("WAITING_LOGIN_SCAN %s\n" % url)
        ev("MIRROR_STARTED (local only); visible=%s" % json.dumps(u.get("visible", [])[:15], ensure_ascii=False))
    time.sleep(4)
else:
    ev("LOGIN_TIMEOUT_12MIN"); rep["logged_in"] = False
for p in procs:
    try: p.terminate()
    except Exception: pass
try: os.remove(os.path.join(OUT, "STATUS"))
except Exception: pass
try: os.remove(os.path.join(mdir, "frame.jpg"))
except Exception: pass
json.dump(rep, open(os.path.join(OUT, "login.json"), "w"), ensure_ascii=False, indent=1)
LGEOF
LOGGED=0
python3 "$OUT/login.py" "$OUT"
grep -q '"logged_in": true' "$OUT/login.json" 2>/dev/null && LOGGED=1
step SHOT_AFTER_LOGIN; shot after_login.png
if [ "$LOGGED" = 1 ]; then sleep 5; ( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/winfix.py" "$OUT/windows_after_login.json" --close ); fi
echo "logged_in=$LOGGED"
step PERSISTENT_MIC
# OWNER APPROVED: a permanent virtual test microphone WeChat can always see (the
# server had only a "monitor" input). It hears nothing from any room; it only
# carries audio the engine deliberately plays into it. Also route ALSA to
# PulseAudio inside WeChat's own home. Nothing existing is overwritten.
( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c '
  if ! pactl list short sources | grep -q wxmic_persist_src; then
    pactl load-module module-null-sink sink_name=wxmic_persist_sink rate=48000 channels=1 sink_properties=device.description=WeChatMicSink
    pactl load-module module-remap-source master=wxmic_persist_sink.monitor source_name=wxmic_persist_src source_properties=device.description=Microphone
  fi
  pactl set-default-source wxmic_persist_src
  echo "sources:"; pactl list short sources | cut -f2
  echo "default:"; pactl info | grep "Default Source"
' ) > "$OUT/persist_mic.txt" 2>&1
WH=$(python3 -c "import json;print(json.load(open('$OUT/pulse_find.json')).get('wechat_home') or '')" 2>/dev/null)
if [ -n "$WH" ] && [ ! -e "$WH/.asoundrc" ] && [ -w "$WH" ]; then
  printf "%s\n%s\n%s\n" "# written by WeChat engine v11.14 (owner approved): ALSA programs use PulseAudio" "pcm.!default { type pulse }" "ctl.!default { type pulse }" > "$WH/.asoundrc" && echo "wechat_home_asoundrc=WRITTEN" >> "$OUT/persist_mic.txt"
else echo "wechat_home_asoundrc=NOT_WRITTEN" >> "$OUT/persist_mic.txt"; fi
cat "$OUT/persist_mic.txt"; sleep 6
step VOICE_PROBE
sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
if ! grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  echo "probe not ready -> starting PulseAudio in WeChat env"
  ( cd /tmp/wxeng && bash ./with_wechat_env.sh pulseaudio --start --exit-idle-time=-1 ); sleep 2
  sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
fi
step SEND_VOICE_ONCE
VSTAT="SKIPPED"
if [ "$LOGGED" = 1 ] && grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  RF=$(realpath "$F"); SHA=$(printf '%s' "$RF" | sha256sum | cut -d' ' -f1)
  rm -f /tmp/wxeng/v10_last.json
  timeout 600 sh $L --v10 send-voice "$CHAT" "$RF" "$SHA" "$N"; echo "voice_exit=$?"
  cp /tmp/wxeng/v10_last.json "$OUT/send_voice.json" 2>/dev/null
  cp /tmp/wxeng/voice_toggle_*.png "$OUT/" 2>/dev/null
  VSTAT=$(python3 -c "import json;d=json.load(open('$OUT/send_voice.json'));r=d.get('result') or {};print(r.get('status') or d.get('error') or d.get('status') or 'UNKNOWN')" 2>/dev/null || echo NO_RESULT)
else
  echo "VOICE_SKIPPED logged_in=$LOGGED (probe not ready or not logged in)"
fi
echo "voice_status=$VSTAT"
sleep 2
step SHOT_AFTER; shot after_voice.png
step MONTAGE
A="$OUT/before.png"; B="$OUT/voice_toggle_1.png"; D="$OUT/after_voice.png"
[ -f "$B" ] || B="$A"; [ -f "$D" ] || D="$A"
ffmpeg -nostdin -v error -y -i "$A" -i "$B" -i "$D" -filter_complex "[0]scale=iw/2:-1[a];[1]scale=iw/2:-1[b];[2]scale=iw/2:-1[c];[a][b]hstack[t];[c]pad=iw*2:ih[u];[t][u]vstack" "$OUT/montage.png" || cp "$D" "$OUT/montage.png"
step SUMMARY
python3 - "$OUT" "$VSTAT" "$LOGGED" "$CHAT" <<'PYEOF'
import json, sys
OUT, VSTAT, LOGGED = sys.argv[1], sys.argv[2], sys.argv[3]
def load(n):
    try: return json.load(open(OUT + "/" + n, encoding="utf8"))
    except Exception as e: return {"_missing": type(e).__name__}
sv = load("send_voice.json"); r = sv.get("result") if isinstance(sv.get("result"), dict) else sv
s = {"run": "sendvoice", "chat": sys.argv[4], "voice_status": VSTAT, "logged_in": LOGGED == "1", "audio": load("audio.json"),
     "duration_s": r.get("duration_s"), "chunks": r.get("chunks"),
     "results": [{k: x.get(k) for k in ("chunk", "status", "pressed", "routed", "capture_seen", "held_s", "new_row", "direction", "guard")}
                 for x in (r.get("results") or []) if isinstance(x, dict)],
     "text_mode_restored": r.get("text_mode_restored"), "error": sv.get("error") or sv.get("code"),
     "login_events": (load("login.json").get("events") or [])[-4:]}
s["success"] = VSTAT == "VOICE_ALL_SENT"
json.dump(s, open(OUT + "/SUMMARY.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps(s, ensure_ascii=False)[:1500])
PYEOF
echo DONE > "$OUT/STATUS"
