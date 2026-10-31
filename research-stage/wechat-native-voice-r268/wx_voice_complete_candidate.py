"""Owner-self native voice candidate: full PCM drain, source suspension, 54s runtime cap.

Derived from the pinned v11.16 timing overlay and the fail-closed 59s engine.
Not deployed and not a CF tool. This module never retries an attempted source.
"""
from __future__ import annotations
import os, sys, subprocess, time, threading
sys.path.insert(0, "/tmp/wxeng")
import wx_voice_fail_closed_candidate as wv
sys.modules["wx_voice"] = wv

STRATEGY = "complete"
# The source remains governed by the owner's 59s absolute maximum. Until
# full-drain timing is qualified at 59s on the real client, 54s leaves room
# for capture startup and PulseAudio drain overhead under WeChat's ~60s cap.
SAFE_SOURCE_CAP_S = 54.0
_ORIGINAL_PLAN = wv.plan_chunks
def _safe_plan(duration, chunk_s=None):
    cap = SAFE_SOURCE_CAP_S if chunk_s is None else min(float(chunk_s), 59.0)
    chunks = _ORIGINAL_PLAN(duration, cap)
    if not chunks or any(length > 59.0 or length > cap + 1e-6 or length < wv.MIN_S for _, length in chunks):
        raise wv.UIBlocked("VOICE_CHUNK_PLAN_UNSAFE")
    return chunks
wv.plan_chunks = _safe_plan
wv.LEAD_S = 0.0
wv.TAIL_S = 0.0

def _suspend(source, enabled):
    return wv._run("pactl", "suspend-source", source, "1" if enabled else "0", check=False)

_orig_enter = wv.VirtualMic.__enter__
_orig_exit = wv.VirtualMic.__exit__
def _enter(self):
    result = _orig_enter(self)
    self.suspended = []
    sources = {wv.MIC}
    try:
        sources.update(x["source"] for x in wv.wechat_captures() if x.get("source") and x["source"] != "?")
    except Exception:
        pass
    for source in sorted(sources):
        _suspend(source, True)
        self.suspended.append(source)
    return result

def _exit(self, *exc):
    for source in getattr(self, "suspended", []):
        _suspend(source, False)
    return _orig_exit(self, *exc)
wv.VirtualMic.__enter__ = _enter
wv.VirtualMic.__exit__ = _exit

def _hold_and_play(backend, mic, hold, raw, seconds, name):
    from pointer_mapping import hover_target
    from x11_modal_guard import assert_no_wechat_modal
    snap = backend.snapshot()
    wv.c.require_chat(snap, name)
    plan = hover_target(backend, hold, snap=snap, label="V11_VOICE_HOLD_COMPLETE")
    if not (isinstance(plan, tuple) and len(plan) == 3):
        raise wv.UIBlocked("VOICE_HOLD_PLAN_INVALID")
    assert_no_wechat_modal()
    result = {"pressed": False, "strategy": STRATEGY, "audio_s": round(seconds, 3)}
    t0 = time.monotonic()
    try:
        wv._HELD[0] = True
        p = subprocess.run(("xdotool", "mousemove", str(plan[1]), str(plan[2]), "mousedown", "1"),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           stdin=subprocess.DEVNULL, timeout=5, check=False)
        if p.returncode != 0:
            result["status"] = "IN_DOUBT_MOUSE_PRESS"
            return result
        result["pressed"] = True
        started = False
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            captures = wv.wechat_captures()
            if captures:
                result["routed"] = mic.route_wechat()
                started = True
                break
            time.sleep(0.05)
        result["capture_seen"] = started
        # Resume only after the native WeChat capture stream is visible.
        for source in getattr(mic, "suspended", []):
            _suspend(source, False)
        result["recording_hint"] = wv._recording_hint(backend.snapshot())
        if not started and not result["recording_hint"]:
            result["status"] = "VOICE_RECORD_NOT_STARTED"
            return result
        play_start = time.monotonic()
        try:
            result["pacat_rc"] = mic.play(raw, seconds)  # synchronous full drain
            result["pacat_elapsed_s"] = round(time.monotonic() - play_start, 3)
            result["pacat_finished_before_release"] = result["pacat_rc"] == 0
        except subprocess.TimeoutExpired:
            result["pacat_rc"] = -1
            result["pacat_elapsed_s"] = round(time.monotonic() - play_start, 3)
            result["pacat_finished_before_release"] = False
            result["status"] = "IN_DOUBT_PLAYBACK_TIMEOUT"
            return result
        if result["pacat_rc"] != 0:
            result["status"] = "IN_DOUBT_PLAYBACK_FAILED"
            return result
        result["status"] = "RELEASED"
        return result
    finally:
        wv._release()
        result["held_s"] = round(time.monotonic() - t0, 3)
        if result.get("status") == "RELEASED" and result["held_s"] > 60.0:
            result["status"] = "IN_DOUBT_CAPTURE_OVER_PROVIDER_LIMIT"

wv.hold_and_play = _hold_and_play

if __name__ == "__main__":
    import wx_v10
    sys.exit(wx_v10.main(sys.argv[1:]))
