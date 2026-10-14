#!/bin/bash
# WeChat v11.6 single live run. Writes everything to /tmp/wxeng/run116/
set -u
OUT=/tmp/wxeng/run116
mkdir -p "$OUT"; rm -f "$OUT/STATUS"
exec > "$OUT/console.txt" 2>&1 < /dev/null
step(){ echo; echo "===== $* ($(date +%T))"; }
shot(){ ( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c 'ffmpeg -nostdin -v error -y -f x11grab -draw_mouse 0 -i "$DISPLAY" -frames:v 1 "$0"' "$OUT/$1" ) || echo "SHOT_FAILED $1"; }
L=/tmp/wx-v11.sh
step LOADER
curl -fsSL "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/eceefdb4e7de9fbcd4bed1a51faf9e5b0ffdd80e/research-stage/wechat-ui-engine-v2/b646116375493c0784cef8f6558fcea60124959c/stage-and-run.sh" -o $L
H=$(git hash-object $L); echo "loader_blob=$H"
if [ "$H" != "f50b60d62c2629f996314d5e50fe81d3066068b3" ]; then echo "STOP LOADER_HASH_MISMATCH"; echo STOPPED > "$OUT/STATUS"; exit 1; fi
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
step ACCEPTANCE
timeout 900 sh $L --v10 acceptance --allow-typing; echo "acceptance_exit=$?"
cp /tmp/wxeng/v10_last.json "$OUT/acceptance.json" 2>/dev/null
cp /tmp/wxeng/v10_search_dump.json "$OUT/" 2>/dev/null
step SHOT_AFTER_ACCEPTANCE; shot after_acceptance.png
SKIPVOICE=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(1 if d.get('blocked') or (d.get('result') or {}).get('stopped') else 0)" "$OUT/acceptance.json" 2>/dev/null || echo 0); echo "skipvoice=$SKIPVOICE"
step VOICE_PROBE
sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
if ! grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  echo "probe not ready -> starting PulseAudio in WeChat env"
  ( cd /tmp/wxeng && bash ./with_wechat_env.sh pulseaudio --start --exit-idle-time=-1 ); sleep 2
  sh $L --v10 voice-probe; cp /tmp/wxeng/v10_last.json "$OUT/voice_probe.json" 2>/dev/null
fi
if [ "$SKIPVOICE" = 0 ] && grep -q '"ready": *true' "$OUT/voice_probe.json" 2>/dev/null; then
  step VOICE_ACCEPT
  ( cd /tmp/wxeng && bash ./with_wechat_env.sh pactl info | grep "Default Source" ) > "$OUT/default_source_before.txt" 2>&1
  timeout 600 sh $L --v10 voice-accept; echo "voice_exit=$?"
  cp /tmp/wxeng/v10_last.json "$OUT/voice_accept.json" 2>/dev/null
  cp /tmp/wxeng/voice_toggle_*.png "$OUT/" 2>/dev/null
  step SHOT_AFTER_VOICE; shot after_voice.png
  ( cd /tmp/wxeng && echo "modules_wxv11:"; bash ./with_wechat_env.sh pactl list short modules | grep wxv11; echo "after:"; bash ./with_wechat_env.sh pactl info | grep "Default Source" ) > "$OUT/voice_cleanup.txt" 2>&1
else
  echo "VOICE_SKIPPED (probe not ready or acceptance blocked)"
fi
step WINDOWS_END
( cd /tmp/wxeng && bash ./with_wechat_env.sh python3 "$OUT/winfix.py" "$OUT/windows_end.json" )
step MONTAGE
# one 2x2 picture: after_acceptance | voice_toggle_1 / before | after_voice (half size each)
A="$OUT/after_acceptance.png"; B="$OUT/voice_toggle_1.png"; C="$OUT/before.png"; D="$OUT/after_voice.png"
[ -f "$B" ] || B="$A"; [ -f "$C" ] || C="$A"; [ -f "$D" ] || D="$A"
ffmpeg -nostdin -v error -y -i "$A" -i "$B" -i "$C" -i "$D" -filter_complex "[0]scale=iw/2:-1[a];[1]scale=iw/2:-1[b];[2]scale=iw/2:-1[c];[3]scale=iw/2:-1[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack" "$OUT/montage.png" || echo MONTAGE_FAILED
step SUMMARY
cat > "$OUT/summary.py" <<'PYEOF'
import json, os, glob
OUT = "/tmp/wxeng/run116"
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
                      "present", "closed_by", "steps", "pre_dismiss", "post_dismiss", "search_cleared"):
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
S["windows_before"] = wins(OUT + "/windows_before.json")
S["windows_end"] = wins(OUT + "/windows_end.json")
S["screenshots"] = sorted(os.path.basename(x) for x in glob.glob(OUT + "/*.png"))
with open(OUT + "/SUMMARY.json", "w", encoding="utf8") as f:
    json.dump(S, f, ensure_ascii=False, indent=1)
print("SUMMARY bytes", os.path.getsize(OUT + "/SUMMARY.json"))
PYEOF
python3 "$OUT/summary.py"
echo DONE > "$OUT/STATUS"
