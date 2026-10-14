#!/bin/bash
# WeChat v11.13 voice-only live run (mic fix without restarting WeChat). Writes everything to /tmp/wxeng/run1113/
set -u
OUT=/tmp/wxeng/run1113
mkdir -p "$OUT"; rm -f "$OUT/STATUS"
exec > "$OUT/console.txt" 2>&1 < /dev/null
step(){ echo; echo "===== $* ($(date +%T))"; }
shot(){ ( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c 'ffmpeg -nostdin -v error -y -f x11grab -draw_mouse 0 -i "$DISPLAY" -frames:v 1 "$0"' "$OUT/$1" ) || echo "SHOT_FAILED $1"; }
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
step SHOT_AFTER_WINDOWS_FIX; shot after_winfix.png
cat > "$OUT/audiodiag.py" <<'ADEOF'
# READ-ONLY: which WeChat processes exist, which audio libraries each one loaded,
# which audio env vars each one has, and what the Pulse server sees.
import glob, json, os, subprocess, sys
def sh(*a):
    try:
        return subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                              timeout=8, text=True).stdout
    except Exception as e:
        return "ERR " + type(e).__name__
uid = os.getuid()
rows = []
for d in glob.glob("/proc/[0-9]*"):
    try:
        if os.stat(d).st_uid != uid:
            continue
        cmd = open(d + "/cmdline", "rb").read().replace(b"\0", b" ").decode("utf8", "replace")
        exe = os.readlink(d + "/exe") if os.path.exists(d + "/exe") else ""
    except Exception:
        continue
    low = (cmd + " " + exe).casefold()
    if not ("wechat" in low or "/opt/wechat" in low or "radium" in low or "wmpf" in low):
        continue
    if "python" in low or "wx_" in low or "run1113" in low or "audiodiag" in low:
        continue
    libs = set()
    try:
        for line in open(d + "/maps", encoding="utf8", errors="replace"):
            for k in ("libpulse", "libasound", "libpipewire", "libportaudio", "Multimedia", "libopenal",
                      "libSDL", "libjack", "libsndio"):
                if k in line:
                    libs.add(line.split()[-1].rsplit("/", 1)[-1] if "/" in line else k)
    except Exception:
        pass
    env = {}
    try:
        for e in open(d + "/environ", "rb").read().split(b"\0"):
            k, _, v = e.decode("utf8", "replace").partition("=")
            if k.startswith(("PULSE", "PIPEWIRE", "ALSA", "XDG_RUNTIME_DIR", "HOME", "DISPLAY")):
                env[k] = v[:120]
            elif k.startswith(("DBUS_SESSION", "QT_")):
                env[k] = "(set)"
    except Exception:
        pass
    socks = 0
    try:
        socks = sum(1 for f in os.listdir(d + "/fd") if os.readlink(d + "/fd/" + f).startswith("socket:"))
    except Exception:
        pass
    rows.append({"pid": d[6:], "exe": exe[-80:], "cmd": cmd[:140], "libs": sorted(libs), "env": env, "sockets": socks})
rows.sort(key=lambda r: int(r["pid"]))
home = os.path.expanduser("~")
inst = sorted({os.path.dirname(r["exe"]) for r in rows if r["exe"].startswith("/")})
bundled = []
for top in inst[:3]:
    bundled += sh("sh", "-c", "find '%s' -maxdepth 3 \\( -iname '*pulse*' -o -iname '*asound*' -o -iname '*Multimedia*' -o -iname '*portaudio*' -o -iname '*openal*' -o -iname '*pipewire*' \\) 2>/dev/null | head -30" % top).split()
rep = {
    "wechat_processes": rows,
    "pactl_info": sh("pactl", "info")[:900],
    "pulse_clients": [l for l in sh("pactl", "list", "short", "clients").splitlines()][:30],
    "source_outputs": sh("pactl", "list", "short", "source-outputs")[:600],
    "client_conf": open(home + "/.config/pulse/client.conf").read()[:400] if os.path.exists(home + "/.config/pulse/client.conf") else None,
    "asoundrc": open(home + "/.asoundrc").read()[:400] if os.path.exists(home + "/.asoundrc") else None,
    "alsa_pulse_plugin": sorted(glob.glob("/usr/lib*/alsa-lib/libasound_module_pcm_pulse.so") +
                                glob.glob("/usr/lib/*/alsa-lib/libasound_module_pcm_pulse.so")),
    "system_libasound": sorted(glob.glob("/usr/lib*/libasound.so*") + glob.glob("/usr/lib/*/libasound.so*"))[:4],
    "system_libpulse": sorted(glob.glob("/usr/lib*/libpulse.so*") + glob.glob("/usr/lib/*/libpulse.so*"))[:4],
    "install_dirs": inst, "bundled_audio_files": bundled[:30],
    "runtime_dir_sockets": sh("sh", "-c", "ls -la /run/user/%d/pulse/ 2>&1; ls -d /tmp/pulse-* 2>&1" % uid)[:500],
}
json.dump(rep, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print("AUDIODIAG processes=%d clients=%d" % (len(rows), len(rep["pulse_clients"])))
ADEOF
step AUDIO_DIAG_BEFORE
( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/audiodiag.py" "$OUT/audio_before.json" )
step AUDIO_FIX
# Make the Pulse server findable by ANY program of this user, also programs started
# without XDG_RUNTIME_DIR (like WeChat). Existing files are never overwritten.
( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c '
  S=$(pactl info 2>/dev/null | sed -n "s/^Server String: *//p")
  echo "server_string=$S"
  case "$S" in /*) S="unix:$S";; esac
  mkdir -p "$HOME/.config/pulse"
  if [ -n "$S" ] && [ ! -e "$HOME/.config/pulse/client.conf" ]; then
    printf "%s\n%s\n" "# written by WeChat engine v11.13 (owner approved): lets programs without XDG_RUNTIME_DIR find PulseAudio" "default-server = $S" > "$HOME/.config/pulse/client.conf"
    echo "client_conf=WRITTEN"
  else echo "client_conf=KEPT_EXISTING_OR_NO_SERVER"; fi
  PLUG=$(ls /usr/lib*/alsa-lib/libasound_module_pcm_pulse.so /usr/lib/*/alsa-lib/libasound_module_pcm_pulse.so 2>/dev/null | head -1)
  if [ -n "$PLUG" ] && [ ! -e "$HOME/.asoundrc" ]; then
    printf "%s\n%s\n%s\n" "# written by WeChat engine v11.13 (owner approved): ALSA programs use PulseAudio" "pcm.!default { type pulse }" "ctl.!default { type pulse }" > "$HOME/.asoundrc"
    echo "asoundrc=WRITTEN plugin=$PLUG"
  else echo "asoundrc=NOT_WRITTEN plugin=${PLUG:-none}"; fi
' ) > "$OUT/audio_fix.txt" 2>&1; cat "$OUT/audio_fix.txt"
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
            f.write("# written by WeChat engine v11.13 (owner approved): WeChat finds PulseAudio\ndefault-server = %s\n" % target)
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
step LINK_FIX
cat > "$OUT/linkfix.py" <<'LFEOF'
# Make the audio-service address WeChat already looks for actually work, without
# restarting WeChat: WeChat's own runtime folder (<WeChat HOME>/.config/pulse/
# <machine-id>-runtime -> /tmp/pulse-XXXX) has no server socket. Add ONE symlink
# "native" there pointing to the running PulseAudio socket. Nothing is overwritten.
# --check: only report whether WeChat is now a client of that server.
import json, os, re, subprocess, sys, time
OUT, TARGET = sys.argv[1], sys.argv[2]
CHECK = "--check" in sys.argv
uid = os.getuid()
def comm(p):
    try: return open("/proc/%s/comm" % p).read().strip()
    except Exception: return ""
def wechat_pids():
    return {d for d in os.listdir("/proc") if d.isdigit() and comm(d) in ("wechat", "WeChatAppEx", "wxplayer", "wxutility")}
def clients(sock):
    try:
        t = subprocess.run(("pactl", "list", "clients"), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           stdin=subprocess.DEVNULL, timeout=10, text=True,
                           env=dict(os.environ, PULSE_SERVER="unix:" + sock)).stdout
    except Exception:
        return []
    w = wechat_pids()
    return [m for m in re.findall(r'application\.process\.id = "(\d+)"', t) if m in w]
sock = TARGET[5:] if TARGET.startswith("unix:") else TARGET
rep = {"target_socket": sock}
main = [p for p in wechat_pids() if comm(p) == "wechat"]
home = None
if main:
    for e in open("/proc/%s/environ" % main[0], "rb").read().split(b"\0"):
        if e.startswith(b"HOME="): home = e[5:].decode()
mid = open("/etc/machine-id").read().strip() if os.path.exists("/etc/machine-id") else ""
link = os.path.join(home, ".config", "pulse", mid + "-runtime") if home else None
rep["runtime_link"] = link
rd = os.path.realpath(link) if link and os.path.lexists(link) else None
rep["runtime_dir"] = rd
if not CHECK:
    if not (sock.startswith("/") and os.path.exists(sock)):
        rep["result"] = "TARGET_SOCKET_MISSING"
    elif not rd:
        rep["result"] = "NO_WECHAT_RUNTIME_LINK"
    else:
        try:
            if not os.path.isdir(rd):
                os.mkdir(rd, 0o700); rep["created_dir"] = True
            st = os.stat(rd)
            rep["dir_owner_ok"] = st.st_uid == uid
            nat = os.path.join(rd, "native")
            if os.path.lexists(nat):
                rep["result"] = "NATIVE_ALREADY_EXISTS"
                rep["native_points_to"] = os.path.realpath(nat)
            elif st.st_uid != uid:
                rep["result"] = "RUNTIME_DIR_NOT_OURS"
            else:
                os.symlink(sock, nat); rep["result"] = "NATIVE_LINK_CREATED"
            rep["dir_listing"] = sorted(os.listdir(rd))[:20]
        except Exception as e:
            rep["result"] = "LINK_FAILED:" + type(e).__name__
    time.sleep(4)
rep["wechat_clients_on_target"] = clients(sock)
json.dump(rep, open(OUT, "w"), ensure_ascii=False, indent=1)
print("LINKFIX", rep.get("result", "check"), "wechat_clients=%d" % len(rep["wechat_clients_on_target"]))
LFEOF
[ -n "${PULSE_SERVER:-}" ] && python3 "$OUT/linkfix.py" "$OUT/link_fix.json" "$PULSE_SERVER"
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
  printf "%s\n%s\n%s\n" "# written by WeChat engine v11.13 (owner approved): ALSA programs use PulseAudio" "pcm.!default { type pulse }" "ctl.!default { type pulse }" > "$WH/.asoundrc" && echo "wechat_home_asoundrc=WRITTEN" >> "$OUT/persist_mic.txt"
else echo "wechat_home_asoundrc=NOT_WRITTEN" >> "$OUT/persist_mic.txt"; fi
cat "$OUT/persist_mic.txt"; sleep 6
step VOICE_PROBE
sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
if ! grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  echo "probe not ready -> starting PulseAudio in WeChat env"
  ( cd /tmp/wxeng && bash ./with_wechat_env.sh pulseaudio --start --exit-idle-time=-1 ); sleep 2
  sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
fi
voice_try(){
if [ "$LOGGED" = 1 ] && grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  step VOICE_ACCEPT_TRY_$1
  ( cd /tmp/wxeng && bash ./with_wechat_env.sh pactl info | grep "Default Source" ) > "$OUT/default_source_before.txt" 2>&1
  timeout 600 sh $L --v10 voice-accept; echo "voice_exit=$?"
  cp /tmp/wxeng/v10_last.json "$OUT/voice_accept.json" 2>/dev/null
  cp /tmp/wxeng/voice_toggle_*.png "$OUT/" 2>/dev/null
  step SHOT_AFTER_VOICE; shot after_voice.png
  ( cd /tmp/wxeng && echo "modules_wxv11:"; bash ./with_wechat_env.sh pactl list short modules | grep wxv11; echo "after:"; bash ./with_wechat_env.sh pactl info | grep "Default Source" ) > "$OUT/voice_cleanup.txt" 2>&1
else
  echo "VOICE_SKIPPED (not logged in after restart, or probe not ready)"
fi
}
voice_try 1
VOK=$(python3 -c "import json;d=json.load(open('$OUT/voice_accept.json'));print(1 if ((d.get('result') or {}).get('status')=='VOICE_ALL_SENT') else 0)" 2>/dev/null || echo 0)
echo "voice_ok_try1=$VOK"
if [ "$LOGGED" = 1 ] && [ "$VOK" = 0 ] && grep -q "NO_HOLD_BUTTON_AFTER_TOGGLE" "$OUT/voice_accept.json" 2>/dev/null; then
  cp "$OUT/voice_accept.json" "$OUT/voice_accept_1.json"; cp "$OUT/login.json" "$OUT/login_1.json" 2>/dev/null
  for f in "$OUT"/voice_toggle_*.png; do [ -f "$f" ] && mv "$f" "$OUT/try1_$(basename "$f")"; done
  rm -f "$OUT/voice_accept.json"
  step OWNER_APPROVED_RESTART_SO_WECHAT_SEES_THE_NEW_MIC
  cat > "$OUT/restart.py" <<'RSEOF'
# OWNER-APPROVED (2026-10-14): restart the owner's own WeChat ONCE so it starts
# with access to the audio service (WeChat only looks for a microphone at start).
# Only processes of THIS uid under /opt/wechat are touched. Never the X server,
# never other users' processes, never Desktop Commander. Order: record launch
# info -> polite stop of the wechat main process -> wait -> (only leftovers of
# WeChat itself) force stop -> wait for the launcher to start it again; if no
# launcher does, start /opt/wechat/wechat again with its own saved environment.
import json, os, re, signal, subprocess, sys, time
OUT, PULSE = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
uid = os.getuid()
def comm(p):
    try: return open("/proc/%s/comm" % p).read().strip()
    except Exception: return ""
def ppid(p):
    try: return re.search(r"^PPid:\s*(\d+)", open("/proc/%s/status" % p).read(), re.M).group(1)
    except Exception: return None
def argv(p):
    try: return [a.decode("utf8", "replace") for a in open("/proc/%s/cmdline" % p, "rb").read().split(b"\0")[:-1]]
    except Exception: return []
def mine(p):
    try: return os.stat("/proc/" + p).st_uid == uid
    except Exception: return False
def wechat_family():
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit() and mine(d):
            a = " ".join(argv(d))
            if a.startswith("/opt/wechat/") or comm(d) in ("wechat", "WeChatAppEx", "wxplayer", "wxutility", "wxocr"):
                out.append(d)
    return out
def mains():
    return [p for p in wechat_family() if comm(p) == "wechat" and comm(ppid(p) or "") != "wechat"]
SECRET = re.compile(r"(token|secret|passw|apikey|bearer)", re.I)
rep = {"steps": []}
m = mains()
if len(m) != 1:
    rep["result"] = "SKIPPED_MAIN_NOT_UNIQUE"; rep["mains"] = m
    json.dump(rep, open(OUT, "w"), indent=1); print(rep["result"]); sys.exit(0)
main = m[0]; rep["old_main"] = main
chain, p = [], main
while p and p not in ("0", "1") and len(chain) < 8:
    chain.append({"pid": p, "comm": comm(p), "argv": [("(redacted)" if SECRET.search(x) else x[:300]) for x in argv(p)[:12]]})
    p = ppid(p)
rep["chain"] = chain
try: rep["cgroup"] = open("/proc/%s/cgroup" % main).read().strip()[-200:]
except Exception: pass
env = dict(e.decode("utf8", "replace").split("=", 1) for e in open("/proc/%s/environ" % main, "rb").read().split(b"\0") if b"=" in e)
cwd = os.readlink("/proc/%s/cwd" % main)
margv = argv(main)
rep["env_keys"] = sorted(env)
disp = env.get("DISPLAY")
xserver = [q for q in os.listdir("/proc") if q.isdigit() and comm(q).startswith("Xvfb") and disp and disp in argv(q)]
rep["x_server_alive_before"] = bool(xserver)
os.kill(int(main), signal.SIGTERM); rep["steps"].append("SIGTERM wechat main")
t = time.time()
while time.time() - t < 25 and main in wechat_family():
    time.sleep(0.5)
left = wechat_family()
if left:
    for q in left:
        try: os.kill(int(q), signal.SIGKILL)
        except Exception: pass
    rep["steps"].append("SIGKILL %d leftover WeChat processes" % len(left)); time.sleep(3)
rep["wechat_left_after_stop"] = len(wechat_family())
rep["x_server_alive_after_stop"] = all(os.path.exists("/proc/" + q) for q in xserver) if xserver else False
t = time.time()
while time.time() - t < 25 and not mains():
    time.sleep(1)
if mains():
    rep["steps"].append("restarted_by_launcher")
elif rep["x_server_alive_after_stop"]:
    ne = dict(env)
    if os.path.isdir("/run/user/%d" % uid): ne["XDG_RUNTIME_DIR"] = "/run/user/%d" % uid
    if PULSE: ne["PULSE_SERVER"] = PULSE
    # The old session bus (dbus-run-session) may have ended with WeChat; the
    # accessibility bus needs a live one. Reuse it if alive, else start a new one.
    bus_ok = False
    if env.get("DBUS_SESSION_BUS_ADDRESS"):
        try:
            bus_ok = subprocess.run(("dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus",
                                     "/org/freedesktop/DBus", "org.freedesktop.DBus.GetId"),
                                    env=dict(ne), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    stdin=subprocess.DEVNULL, timeout=5).returncode == 0
        except Exception:
            bus_ok = False
    rep["old_session_bus_alive"] = bus_ok
    cmdv = list(margv)
    if not bus_ok:
        ne.pop("DBUS_SESSION_BUS_ADDRESS", None); ne.pop("AT_SPI_BUS_ADDRESS", None)
        cmdv = ["/usr/bin/dbus-run-session", "--"] + margv
    pid = os.fork()
    if pid == 0:
        os.setsid()
        fd = os.open("/dev/null", os.O_RDWR)
        for k in (0, 1, 2): os.dup2(fd, k)
        if os.fork() == 0:
            os.chdir(cwd); os.execve(cmdv[0], cmdv, ne)
        os._exit(0)
    os.waitpid(pid, 0)
    rep["steps"].append("started_again_with_saved_env" + ("" if bus_ok else "_new_session_bus"))
else:
    rep["steps"].append("x_server_gone_not_started")
t = time.time()
while time.time() - t < 40 and not mains():
    time.sleep(1)
rep["new_main"] = (mains() or [None])[0]
rep["result"] = "RESTARTED" if rep["new_main"] else "RESTART_FAILED_NOT_RUNNING"
json.dump(rep, open(OUT, "w"), indent=1, ensure_ascii=False)
print(rep["result"], rep["steps"])
RSEOF
  python3 "$OUT/restart.py" "$OUT/restart.json" "${PULSE_SERVER:-}"
  LOGGED=0
  if grep -q '"result": "RESTARTED"' "$OUT/restart.json" 2>/dev/null; then
    sleep 10
    step WAIT_FOR_LOGIN_2
    python3 "$OUT/login.py" "$OUT"
    grep -q '"logged_in": true' "$OUT/login.json" 2>/dev/null && LOGGED=1
    step SHOT_AFTER_LOGIN_2; shot after_login.png
    if [ "$LOGGED" = 1 ]; then sleep 8; ( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/winfix.py" "$OUT/windows_after_login2.json" --close ); fi
    voice_try 2
  fi
fi
step LINK_CHECK_AFTER_VOICE
[ -n "${PULSE_SERVER:-}" ] && python3 "$OUT/linkfix.py" "$OUT/link_check.json" "$PULSE_SERVER" --check
step RESTART_PLAN
cat > "$OUT/restartplan.py" <<'RPEOF'
# READ-ONLY: how WeChat is started (for a later, separately approved restart).
import json, os, re, subprocess, sys
OUT = sys.argv[1]
def run(*a):
    try: return subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=10, text=True).stdout
    except Exception as e: return "ERR " + type(e).__name__
def comm(p):
    try: return open("/proc/%s/comm" % p).read().strip()
    except Exception: return ""
def ppid(p):
    try: return re.search(r"^PPid:\s*(\d+)", open("/proc/%s/status" % p).read(), re.M).group(1)
    except Exception: return None
def cmd(p):
    try: return [a.decode("utf8", "replace") for a in open("/proc/%s/cmdline" % p, "rb").read().split(b"\0")[:-1]]
    except Exception: return []
SECRET = re.compile(r"(token|secret|passw|key=|apikey|bearer)", re.I)
main = sorted((d for d in os.listdir("/proc") if d.isdigit() and comm(d) == "wechat"), key=int)
rep = {"wechat_main": main[:1], "chain": []}
p = main[0] if main else None
while p and p not in ("0", "1") and len(rep["chain"]) < 8:
    c = cmd(p)
    rep["chain"].append({"pid": p, "comm": comm(p), "cmd": [("(redacted)" if SECRET.search(x) else x[:120]) for x in c[:8]]})
    p = ppid(p)
try: cg = open("/proc/%s/cgroup" % main[0]).read().strip()
except Exception: cg = ""
rep["cgroup"] = cg[-300:]
u = re.findall(r"([\w@.\-]+\.service)", cg)
unit = next((x for x in reversed(u) if not x.startswith("user@")), None)
rep["unit"] = unit
if unit:
    rep["unit_show"] = run("systemctl", "show", unit, "-p", "MainPID,Restart,User,FragmentPath,ActiveState,ExecStart")[-900:]
    rep["unit_file"] = "\n".join(l for l in run("systemctl", "cat", unit).splitlines() if not SECRET.search(l))[-2000:]
    rep["sudo_n"] = run("sudo", "-n", "true")[:80] or "ok"
scripts = []
for ch in rep["chain"]:
    for a in ch["cmd"][1:3]:
        if a.endswith((".sh", ".bash")) and os.path.isfile(a):
            try: scripts.append({"path": a, "head": "\n".join(l for l in open(a, errors="replace").read().splitlines()[:80] if not SECRET.search(l))})
            except Exception: pass
rep["launcher_scripts"] = scripts[:2]
json.dump(rep, open(OUT, "w"), ensure_ascii=False, indent=1)
print("RESTARTPLAN unit=%s chain=%d scripts=%d" % (unit, len(rep["chain"]), len(scripts)))
RPEOF
python3 "$OUT/restartplan.py" "$OUT/restart_plan.json"
step AUDIO_DIAG_AFTER
( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/audiodiag.py" "$OUT/audio_after.json" )
step WINDOWS_END
( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/winfix.py" "$OUT/windows_end.json" )
step MONTAGE
# one 2x2 picture: voice_toggle_1 | voice_toggle_2 / before | after_voice (half size each)
A="$OUT/voice_toggle_1.png"; B="$OUT/after_login.png"; C="$OUT/before.png"; D="$OUT/after_voice.png"
[ -f "$A" ] || A="$C"; [ -f "$B" ] || B="$A"; [ -f "$D" ] || D="$A"
ffmpeg -nostdin -v error -y -i "$A" -i "$B" -i "$C" -i "$D" -filter_complex "[0]scale=iw/2:-1[a];[1]scale=iw/2:-1[b];[2]scale=iw/2:-1[c];[3]scale=iw/2:-1[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack" "$OUT/montage.png" || echo MONTAGE_FAILED
step SUMMARY
cat > "$OUT/summary.py" <<'PYEOF'
import json, os, glob
OUT = "/tmp/wxeng/run1113"
def load(p):
    try:
        with open(p, encoding="utf8") as f:
            return json.load(f)
    except Exception as e:
        return {"_load_error": type(e).__name__, "_path": p}
def cut(v, n=600):
    s = json.dumps(v, ensure_ascii=False, default=str)
    return v if len(s) <= n else s[:n] + "...(cut)"
def phases(doc):
    ph = ((doc.get("result") or {}).get("phases") or {}) if isinstance(doc, dict) else {}
    out = {}
    for k, v in ph.items():
        if not isinstance(v, dict):
            continue
        e = {"ok": v.get("ok"), "code": v.get("code"), "exception": v.get("exception")}
        if v.get("trace"):
            e["trace_tail"] = v["trace"][-400:]
        r = v.get("result")
        if isinstance(r, dict):
            for f in ("status", "match", "media", "direction", "method", "items", "closed_by",
                      "correct", "wrong", "capture_error", "total", "gaps", "count", "errors",
                      "pixels_err", "opened", "read", "tried", "menu_geometry", "new_windows",
                      "present", "closed_by", "steps", "pre_dismiss", "post_dismiss", "search_cleared", "empty",
                      "cleared_leftover_text", "clear_leftover_failed"):
                if f in r:
                    e[f] = cut(r[f], 900)
        elif isinstance(r, list):
            e["result"] = cut(r, 900)
        out[k] = e
    return out
def search_dump(p):
    d = load(p)
    if not isinstance(d, list):
        return d
    keep = [{"role": n.get("role"), "name": (n.get("name") or "")[:60], "rect": n.get("rect")}
            for n in d if (n.get("name") or "").strip()
            and n.get("role") in ("list item", "list-item", "label", "text", "button", "push button", "list", "page tab")]
    return {"visible_nodes": len(d), "named_kept": keep[:150]}
S = {}
S["console_tail"] = open(OUT + "/console.txt", encoding="utf8", errors="replace").read()[-2500:] \
    if os.path.exists(OUT + "/console.txt") else None
acc = load(OUT + "/acceptance.json")
S["acceptance_ok"] = acc.get("ok") if isinstance(acc, dict) else None
S["preflight"] = acc.get("preflight") if isinstance(acc, dict) else None
S["acceptance_blocked"] = acc.get("blocked") if isinstance(acc, dict) else None
S["acceptance_stopped"] = ((acc.get("result") or {}).get("stopped")) if isinstance(acc, dict) else None
S["phases"] = phases(acc)
S["final_state"] = cut(((acc.get("result") or {}).get("final_state")) if isinstance(acc, dict) else None)
S["search_dump"] = search_dump(OUT + "/v10_search_dump.json") if os.path.exists(OUT + "/v10_search_dump.json") else None
S["voice_probe"] = cut(load(OUT + "/voice_probe.json"), 1500) if os.path.exists(OUT + "/voice_probe.json") else None
S["voice_accept"] = cut(load(OUT + "/voice_accept.json"), 7000) if os.path.exists(OUT + "/voice_accept.json") else None
for f in ("default_source_before.txt", "voice_cleanup.txt"):
    p = OUT + "/" + f
    S[f] = open(p, encoding="utf8", errors="replace").read()[-600:] if os.path.exists(p) else None
def wins(p):
    d = load(p)
    if not isinstance(d, dict) or "before" not in d:
        return d
    short = lambda rows: [{k: r.get(k) for k in ("id", "name", "class", "pid", "geometry", "is_main", "deletable")}
                          | {"cmd": (r.get("cmd") or "")[:90]} for r in rows]
    return {"main_pid": d.get("main_pid"), "error": d.get("error"), "to_close": d.get("to_close"),
            "closed": d.get("closed"), "covering_after": d.get("covering_after"),
            "before": short(d.get("before") or [])[:25], "after": short(d.get("after") or [])[:25]}
for k in ("audio_before", "audio_after"):
    d = load(OUT + "/" + k + ".json") if os.path.exists(OUT + "/" + k + ".json") else None
    if isinstance(d, dict) and isinstance(d.get("wechat_processes"), list):
        d["wechat_processes"] = [p for p in d["wechat_processes"]
                                 if p.get("exe", "").endswith(("/wechat", "/wxplayer"))][:4]
    S[k] = cut(d, 6000)
S["pulse_find"] = cut(load(OUT + "/pulse_find.json"), 6000) if os.path.exists(OUT + "/pulse_find.json") else None
for k in ("link_fix", "link_check", "restart_plan"):
    S[k] = cut(load(OUT + "/" + k + ".json"), 6000) if os.path.exists(OUT + "/" + k + ".json") else None
for k in ("login", "login_1", "restart", "voice_accept_1", "login_ui_press"):
    S[k] = cut(load(OUT + "/" + k + ".json"), 5000) if os.path.exists(OUT + "/" + k + ".json") else None
S["persist_mic"] = open(OUT + "/persist_mic.txt", encoding="utf8", errors="replace").read()[-1200:] if os.path.exists(OUT + "/persist_mic.txt") else None
S["audio_fix"] = open(OUT + "/audio_fix.txt", encoding="utf8", errors="replace").read()[-800:] \
    if os.path.exists(OUT + "/audio_fix.txt") else None
S["windows_before"] = wins(OUT + "/windows_before.json")
S["windows_end"] = wins(OUT + "/windows_end.json")
S["screenshots"] = sorted(os.path.basename(x) for x in glob.glob(OUT + "/*.png"))
with open(OUT + "/SUMMARY.json", "w", encoding="utf8") as f:
    json.dump(S, f, ensure_ascii=False, indent=1)
print("SUMMARY bytes", os.path.getsize(OUT + "/SUMMARY.json"))
PYEOF
python3 "$OUT/summary.py"
echo DONE > "$OUT/STATUS"
