"""WeChat voice timing fix v11.15 (owner requested 2026-10-14). Loaded ON TOP of the
hash-verified v11.7 engine in /tmp/wxeng (no engine file is changed).

Problem seen live: every voice message was ~6-8 s longer than the audio, with
silence at the START. Cause: WeChat opens its microphone stream already when
voice mode is switched on (toggle click), and the message contains everything
the mic delivered since then. Between toggle and press the engine waited
several seconds (diagnostic screenshots), so that much silence was recorded.

Fix (strategy "suspend", default):
 1. our virtual mic is SUSPENDED (delivers no samples) until the moment the
    voice button is pressed; it is resumed right after the press -> nothing
    from before the press can end up in the message;
 2. no slow diagnostics between toggle and press;
 3. a precise timeline (toggle, mic stream seen, press, resume, play, release)
    plus the bubble length WeChat shows, so the result can be checked.
Strategy "legacy" (WXV_STRATEGY=legacy) = old behaviour, for comparison only.
Usage: python3 wx_voice_fix.py send-voice NAME PATH SHA [MAX_CHUNKS]
Mouse only, never keys; same one-shot markers, lock and modal guard as before.
"""
import json, os, re, subprocess, sys, threading, time
os.chdir("/tmp/wxeng"); sys.path.insert(0, "/tmp/wxeng")
import wx_voice as wv

STRATEGY = os.environ.get("WXV_STRATEGY", "suspend")
T0 = time.monotonic()
TL = []
CAP = {"first_seen": None, "sources": []}


def mark(k, **kw):
    TL.append(dict(ev=k, t=round(time.monotonic() - T0, 3), **kw))


def suspend(src, on):
    try:
        wv._run("pactl", "suspend-source", src, "1" if on else "0", check=False)
        return True
    except Exception as e:
        mark("suspend_error", src=src, err=str(e)[:80])
        return False


def _cap_sources():
    try:
        return sorted({o["source"] or "?" for o in wv.wechat_captures()})
    except Exception:
        return None


class _Watch(threading.Thread):
    """Notes when WeChat's microphone stream appears / disappears (read-only)."""
    daemon = True

    def __init__(self):
        super().__init__(); self.stop = False; self.last = None

    def run(self):
        while not self.stop:
            s = _cap_sources()
            if s is not None and s != self.last:
                mark("wechat_mic_streams", sources=s)
                if s and CAP["first_seen"] is None:
                    CAP["first_seen"] = time.monotonic() - T0
                self.last = s
            time.sleep(0.1)


_W = _Watch()
_orig_enter = wv.VirtualMic.__enter__
_orig_exit = wv.VirtualMic.__exit__


def _enter(self):
    r = _orig_enter(self)
    mark("virtual_mic_ready", strategy=STRATEGY)
    self.suspended = []
    if STRATEGY == "suspend":
        srcs = {wv.MIC} | set(s for s in (_cap_sources() or []) if s and s != "?")
        for s in sorted(srcs):
            if suspend(s, True):
                self.suspended.append(s)
        mark("mic_suspended", sources=self.suspended)
    if not _W.is_alive():
        _W.start()
    return r


def _exit(self, *exc):
    for s in getattr(self, "suspended", []):
        if s != wv.MIC:
            suspend(s, False)
    _W.stop = True
    mark("virtual_mic_closed")
    return _orig_exit(self, *exc)


wv.VirtualMic.__enter__, wv.VirtualMic.__exit__ = _enter, _exit
if STRATEGY != "legacy":
    wv._after_toggle_diag = lambda: [{"skipped": "fast path v11.15"}]
_orig_evm = wv.enter_voice_mode


def _evm(backend, report):
    mark("voice_mode_start")
    h = _orig_evm(backend, report)
    mark("voice_mode_ready", hold_found=h is not None)
    return h


wv.enter_voice_mode = _evm


def _hold_and_play(backend, mic, hold, raw, seconds, name):
    from pointer_mapping import hover_target
    from x11_modal_guard import assert_no_wechat_modal
    snap = backend.snapshot()
    wv.c.require_chat(snap, name)
    plan = hover_target(backend, hold, snap=snap, label="V11_VOICE_HOLD")
    if not (isinstance(plan, tuple) and len(plan) == 3):
        raise wv.UIBlocked("VOICE_HOLD_PLAN_INVALID")
    assert_no_wechat_modal()
    r = {"pressed": False, "strategy": STRATEGY, "audio_s": round(seconds, 2)}
    t0 = time.monotonic()
    try:
        wv._HELD[0] = True
        subprocess.run(("xdotool", "mousemove", str(plan[1]), str(plan[2]), "mousedown", "1"),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                       timeout=5, check=False)
        r["pressed"] = True; mark("press")
        started, deadline = False, time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if wv.wechat_captures():
                r["routed"] = mic.route_wechat(); started = True; break
            time.sleep(0.05)
        r["capture_seen"] = started
        for s in getattr(mic, "suspended", []):
            suspend(s, False)
        if getattr(mic, "suspended", []):
            mark("mic_resumed")
        r["recording_hint"] = wv._recording_hint(backend.snapshot())
        if not started and not r["recording_hint"]:
            r["status"] = "VOICE_RECORD_NOT_STARTED"
            return r
        r["start_ms"] = round((time.monotonic() - t0) * 1000)
        mark("play_start")
        r["pacat_rc"] = mic.play(raw, seconds)
        mark("play_end")
        time.sleep(0.15)
    finally:
        wv._release()
        mark("release")
        r["held_s"] = round(time.monotonic() - t0, 2)
    r["status"] = "RELEASED"
    return r


wv.hold_and_play = _hold_and_play
_orig_send = wv.send_voice


def bubble_seconds(row):
    m = re.search(r'(\d+)\s*(?:"|\u201d|\u2033|s\b|sec|\u79d2)', row or "")
    return int(m.group(1)) if m else None


def _send(backend, name, path, confirm_sha, **kw):
    rep = _orig_send(backend, name, path, confirm_sha, **kw)
    rep["timeline"] = TL
    rep["fix_version"] = "v11.15"
    rep["strategy"] = STRATEGY
    t = {e["ev"]: e["t"] for e in TL}
    for r in rep.get("results") or []:
        b = bubble_seconds(r.get("new_row"))
        r["bubble_s"] = b
        if b is not None:
            r["bubble_minus_audio_s"] = round(b - r.get("audio_s", 0), 2)
    if CAP["first_seen"] is not None:
        rep["mic_stream_first_seen_t"] = round(CAP["first_seen"], 3)
        if "press" in t:
            rep["mic_open_before_press_s"] = round(t["press"] - CAP["first_seen"], 2)
    if "press" in t and "release" in t:
        rep["press_to_release_s"] = round(t["release"] - t["press"], 2)
    if "voice_mode_start" in t and "press" in t:
        rep["toggle_to_press_s"] = round(t["press"] - t["voice_mode_start"], 2)
    return rep


wv.send_voice = _send

if __name__ == "__main__":
    import wx_v10
    sys.exit(wx_v10.main(sys.argv[1:]))
