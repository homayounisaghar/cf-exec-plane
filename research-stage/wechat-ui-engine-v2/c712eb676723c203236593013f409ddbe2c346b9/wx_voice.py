"""Voice messages v11: send ANY audio file as WeChat voice message(s).

How: a temporary virtual microphone (PulseAudio/PipeWire-pulse null sink +
remap source) becomes the default input; we press-and-HOLD WeChat's own
"Send voice message" button with the mouse, play the audio into the virtual
mic, then release. Mouse only, never a keyboard key. The left button is
ALWAYS released and the audio defaults ALWAYS restored (finally blocks).
WeChat caps one voice message at ~60 s, so longer audio is split into
chunks of CHUNK_S seconds (each chunk = one voice message, own marker).
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from engine import UIBlocked
import wx_common as c

SINK = "wxv11_sink"
MIC = "wxv11_mic"
RATE = 48000
CHUNK_S = 55.0
LEAD_S = 0.35          # silence before audio (WeChat warms up its capture)
TAIL_S = 0.45          # silence after audio before release
MIN_S = 1.2            # WeChat refuses very short voice messages
HOLD_LABELS = {"send voice message", "hold to talk", "\u6309\u4f4f \u8bf4\u8bdd", "\u6309\u4f4f\u8bf4\u8bdd"}
TOGGLE_LABELS = {"send voice", "\u53d1\u9001\u8bed\u97f3", "voice", "\u8bed\u97f3"}
RECORDING_HINTS = ("release to send", "\u677e\u5f00", "move here", "slide up", "cancel")
BACK_TO_TEXT = re.compile(r"keyboard|text input|switch to text|\u952e\u76d8|\u6587\u5b57", re.I)


# ------------------------------------------------------------ small utils
def _run(*a, timeout=10, check=True, stdin=None) -> str:
    try:
        p = subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=stdin,
                           timeout=timeout, check=False)
    except FileNotFoundError:
        raise UIBlocked("VOICE_TOOL_MISSING_" + os.path.basename(a[0]).upper())
    except subprocess.TimeoutExpired:
        raise UIBlocked("VOICE_TOOL_TIMEOUT_" + os.path.basename(a[0]).upper())
    if check and p.returncode != 0:
        raise UIBlocked("VOICE_TOOL_FAILED_" + os.path.basename(a[0]).upper())
    return p.stdout.decode("utf8", "replace")


def _sha_str(s: str) -> str:
    return hashlib.sha256(s.encode("utf8")).hexdigest()


def _file_digest(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def plan_chunks(duration: float, chunk_s: float = CHUNK_S) -> list:
    """[(start, length)] covering duration; a tiny last piece is merged/extended."""
    if duration <= 0:
        raise UIBlocked("VOICE_AUDIO_EMPTY")
    out, t = [], 0.0
    while t < duration - 1e-6:
        ln = min(chunk_s, duration - t)
        out.append([t, ln])
        t += ln
    if len(out) > 1 and out[-1][1] < MIN_S:
        last = out.pop()
        out[-1][1] += last[1]          # may exceed chunk_s by < MIN_S: still < 60 s
    return [(round(a, 3), round(b, 3)) for a, b in out]


def probe_duration(path: str) -> float:
    out = _run("ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path, timeout=30)
    try:
        return float(out.strip().splitlines()[0])
    except (ValueError, IndexError):
        raise UIBlocked("VOICE_AUDIO_UNREADABLE")


def render_chunk(src: str, start: float, length: float, dst: str) -> None:
    """Decode any audio (ogg/opus/mp3/m4a/wav/video) to raw s16le mono 48 kHz,
    with lead/tail silence and loudness kept sane (no clipping)."""
    af = ("adelay=%d:all=1,apad=pad_dur=%.2f,alimiter=limit=0.9" % (int(LEAD_S * 1000), TAIL_S))
    _run("ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(start), "-t", str(length),
         "-i", src, "-vn", "-ac", "1", "-ar", str(RATE), "-af", af,
         "-f", "s16le", dst, timeout=120)
    if not os.path.isfile(dst) or os.path.getsize(dst) < RATE * 2 * 0.5:
        raise UIBlocked("VOICE_RENDER_FAILED")


# ------------------------------------------------------------ pulse layer
def _short(kind: str) -> list:
    return [ln.split("\t") for ln in _run("pactl", "list", "short", kind).splitlines() if ln.strip()]


def parse_source_outputs(text: str) -> list:
    """Parse `pactl list source-outputs` into [{id, source, pid, app}]."""
    res, cur = [], None
    for ln in text.splitlines():
        m = re.match(r"\s*Source Output #(\d+)", ln)
        if m:
            cur = {"id": m.group(1), "source": None, "pid": None, "app": ""}
            res.append(cur)
            continue
        if cur is None:
            continue
        s = ln.strip()
        if s.startswith("Source:"):
            cur["source"] = s.split(":", 1)[1].strip()
        m = re.match(r'application\.process\.id = "(\d+)"', s)
        if m:
            cur["pid"] = m.group(1)
        m = re.match(r'(application\.name|application\.process\.binary|node\.name) = "(.*)"', s)
        if m:
            cur["app"] += " " + m.group(2)
    return res


def _wechat_pids() -> set:
    pids = set()
    for args in (("-x", "wechat"), ("-f", "/opt/wechat/")):
        out = subprocess.run(("pgrep", "-u", str(os.getuid())) + args,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode()
        pids |= {p for p in out.split() if p.isdigit()}
    pids.discard(str(os.getpid()))
    return pids


def wechat_captures() -> list:
    pids = _wechat_pids()
    outs = parse_source_outputs(_run("pactl", "list", "source-outputs"))
    return [o for o in outs if (o["pid"] in pids) or re.search(r"wechat|weixin", o["app"], re.I)]


def audio_probe() -> dict:
    """Read-only readiness report (no module changes)."""
    rep = {}
    for t in ("ffmpeg", "ffprobe", "pactl", "pacat"):
        rep[t] = bool(shutil.which(t))
    if rep["pactl"]:
        try:
            info = _run("pactl", "info")
            rep["server"] = next((l.split(":", 1)[1].strip() for l in info.splitlines()
                                  if l.startswith("Server Name")), "?")
            rep["default_source"] = next((l.split(":", 1)[1].strip() for l in info.splitlines()
                                          if l.startswith("Default Source")), "?")
            rep["sources"] = [r[1] for r in _short("sources") if len(r) > 1]
            rep["leftover_modules"] = [r[0] for r in _short("modules") if "wxv11_" in "\t".join(r)]
            rep["wechat_capturing_now"] = len(wechat_captures())
        except UIBlocked as e:
            rep["pactl_error"] = e.code
    rep["ready"] = all(rep[t] for t in ("ffmpeg", "ffprobe", "pactl", "pacat")) and "server" in rep
    return rep


class VirtualMic:
    """Temporary virtual mic. Restores the previous default source and unloads
    its own modules on exit, even after errors."""

    def __init__(self):
        self.mods, self.prev = [], None

    def __enter__(self):
        for row in _short("modules"):          # leftovers from a crashed run
            if "wxv11_" in "\t".join(row):
                _run("pactl", "unload-module", row[0], check=False)
        info = _run("pactl", "info")
        self.prev = next((l.split(":", 1)[1].strip() for l in info.splitlines()
                          if l.startswith("Default Source")), None)
        self.mods.append(_run("pactl", "load-module", "module-null-sink", "sink_name=" + SINK,
                              "rate=%d" % RATE, "channels=1",
                              "sink_properties=device.description=" + SINK).strip())
        self.mods.append(_run("pactl", "load-module", "module-remap-source",
                              "master=%s.monitor" % SINK, "source_name=" + MIC,
                              "source_properties=device.description=" + MIC).strip())
        _run("pactl", "set-default-source", MIC)
        return self

    def route_wechat(self) -> int:
        n = 0
        for o in wechat_captures():
            if o["source"] != MIC:
                _run("pactl", "move-source-output", o["id"], MIC, check=False)
            n += 1
        return n

    def play(self, raw: str, seconds: float) -> int:
        with open(raw, "rb") as f:
            p = subprocess.run(("pacat", "--playback", "-d", SINK, "--format=s16le",
                                "--rate=%d" % RATE, "--channels=1", "--latency-msec=60"),
                               stdin=f, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=seconds + 15, check=False)
        return p.returncode

    def __exit__(self, *exc):
        if self.prev and self.prev != MIC:
            _run("pactl", "set-default-source", self.prev, check=False)
        for m in reversed(self.mods):
            if m.isdigit():
                _run("pactl", "unload-module", m, check=False)
        return False


# ------------------------------------------------------------ UI layer
def _visible_named(snap) -> dict:
    return {(n.role, c.norm(n.name)): n for n in snap.nodes
            if n.visible() and (n.name or "").strip()}


def _find(snap, labels: set) -> Optional[object]:
    hits = [n for n in snap.nodes if n.role in ("button", "push button") and n.visible()
            and n.enabled() and n.rect and c.norm(n.name).split("(")[0].strip() in labels]
    if len(hits) > 1:
        raise UIBlocked("VOICE_BUTTON_NOT_UNIQUE")
    return hits[0] if hits else None


def _recording_hint(snap) -> bool:
    return any(n.visible() and any(h in c.norm(n.name) for h in RECORDING_HINTS)
               for n in snap.nodes)


_HELD = [False]


def _release():
    """Release the left button only if WE pressed it (no stray events)."""
    if _HELD[0]:
        subprocess.run(("xdotool", "mouseup", "1"), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=5, check=False)
        _HELD[0] = False


def _rows_names(snap) -> list:
    return [r.name or "" for r in c.message_rows(snap)]


def enter_voice_mode(backend, report: dict):
    """Gives back the hold button node (after clicking the toolbar toggle if needed)."""
    from pointer_mapping import hover_target, click_once
    snap = backend.snapshot()
    hold = _find(snap, HOLD_LABELS)
    if hold is not None:
        report["mode_toggle_clicked"] = False
        return hold
    tog = _find(snap, TOGGLE_LABELS)
    if tog is None:
        raise UIBlocked("VOICE_TOGGLE_NOT_FOUND")
    before = _visible_named(snap)
    click_once(hover_target(backend, tog, snap=snap, label="V11_VOICE_TOGGLE"))
    report["mode_toggle_clicked"] = True
    snap, ok, _ = c.wait_until(backend, lambda s: _find(s, HOLD_LABELS) is not None, 2.0, 0.1)
    after = _visible_named(snap)
    report["ui_new_after_toggle"] = sorted("%s:%s" % k for k in after.keys() - before.keys())[:40]
    report["ui_gone_after_toggle"] = sorted("%s:%s" % k for k in before.keys() - after.keys())[:40]
    try:
        report["capture_started_by_toggle"] = len(wechat_captures())
    except UIBlocked:
        pass
    if not ok:
        report["voice_ui"] = "NO_HOLD_BUTTON_AFTER_TOGGLE"
        _cancel_unknown_voice_ui(backend, snap, before, report)
        return None
    return _find(snap, HOLD_LABELS)


CANCEL_RE = re.compile(r"^(cancel|\u53d6\u6d88)$", re.I)


def _cancel_unknown_voice_ui(backend, snap, before: dict, report: dict) -> None:
    """Unknown voice UI (e.g. click-to-record): click ONE newly shown Cancel
    button if exactly one exists; never anything that could send."""
    from pointer_mapping import hover_target, click_once
    new = [n for k, n in _visible_named(snap).items() if k not in before
           and n.role in ("button", "push button") and n.enabled() and n.rect
           and CANCEL_RE.match(c.norm(n.name))]
    if len(new) != 1:
        report["voice_ui_cancel"] = "none_clicked:%d" % len(new)
        return
    click_once(hover_target(backend, new[0], snap=snap, label="V11_VOICE_CANCEL"))
    report["voice_ui_cancel"] = "clicked"


def leave_voice_mode(backend, report: dict) -> None:
    """Best effort: bring the text composer back (mouse only)."""
    from pointer_mapping import hover_target, click_once
    snap = backend.snapshot()
    try:
        c.composer(snap)
        report["text_mode_restored"] = "already"
        return
    except UIBlocked:
        pass
    cands = [n for n in snap.nodes if n.role in ("button", "push button") and n.visible()
             and n.enabled() and n.rect and BACK_TO_TEXT.search(n.name or "")]
    tgt = cands[0] if len(cands) == 1 else _find(snap, TOGGLE_LABELS)
    if tgt is None:
        report["text_mode_restored"] = "no_toggle_found"
        return
    click_once(hover_target(backend, tgt, snap=snap, label="V11_TEXT_TOGGLE"))
    def back(s):
        try:
            c.composer(s)
            return True
        except UIBlocked:
            return False
    _, ok, _ = c.wait_until(backend, back, 2.0, 0.1)
    report["text_mode_restored"] = "yes" if ok else "no"


def hold_and_play(backend, mic: VirtualMic, hold, raw: str, seconds: float, name: str) -> dict:
    """Press-and-hold the WeChat voice button, play raw audio, release."""
    from pointer_mapping import hover_target
    from x11_modal_guard import assert_no_wechat_modal
    snap = backend.snapshot()
    c.require_chat(snap, name)
    plan = hover_target(backend, hold, snap=snap, label="V11_VOICE_HOLD")
    if not (isinstance(plan, tuple) and len(plan) == 3):
        raise UIBlocked("VOICE_HOLD_PLAN_INVALID")
    assert_no_wechat_modal()
    r = {"pressed": False}
    t0 = time.monotonic()
    try:
        _HELD[0] = True
        subprocess.run(("xdotool", "mousemove", str(plan[1]), str(plan[2]), "mousedown", "1"),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        r["pressed"] = True
        started = False
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            caps = wechat_captures()
            if caps:
                r["routed"] = mic.route_wechat()
                started = True
                break
            time.sleep(0.08)
        r["capture_seen"] = started
        r["recording_hint"] = _recording_hint(backend.snapshot())
        if not started and not r["recording_hint"]:
            r["status"] = "VOICE_RECORD_NOT_STARTED"
            return r
        r["start_ms"] = round((time.monotonic() - t0) * 1000)
        r["pacat_rc"] = mic.play(raw, seconds)
        time.sleep(0.15)
    finally:
        _release()
        r["held_s"] = round(time.monotonic() - t0, 2)
    r["status"] = "RELEASED"
    return r


def send_voice(backend, name: str, path: str, confirm_sha: str, *,
               pixels=None, max_chunks: int = 3) -> dict:
    """Send audio file `path` to chat `name` as 1..max_chunks voice messages."""
    from x11_modal_guard import assert_no_wechat_modal
    import wx_nav as nav
    import wx_send as ws
    real = os.path.realpath(path)
    if not os.path.isfile(real) or os.path.getsize(real) > 300 * 1024 * 1024:
        raise UIBlocked("FILE_INVALID")
    if _sha_str(real) != confirm_sha:
        raise UIBlocked("SEND_CONFIRM_SHA_MISMATCH")
    if not (1 <= max_chunks <= 12):
        raise UIBlocked("VOICE_MAX_CHUNKS_RANGE")
    digest = _file_digest(real)
    dur = probe_duration(real)
    chunks = plan_chunks(dur)
    if len(chunks) > max_chunks:
        raise UIBlocked("VOICE_TOO_LONG_FOR_MAX_CHUNKS")
    rep = {"file": os.path.basename(real), "duration_s": round(dur, 2),
           "chunks": len(chunks), "results": []}
    snap = backend.snapshot()
    if not c.chat_identity_ok(snap, name):
        try:
            rep["opened"] = nav.find_and_open(backend, name, pixels=pixels)
        except UIBlocked as e:
            if e.code not in ("CHAT_NOT_FOUND_IN_LIST", "CHAT_NOT_VISIBLE"):
                raise
            rep["opened"] = nav.search_and_open(backend, name)
    snap = backend.snapshot()
    c.require_chat(snap, name)
    if c.read_text(backend, c.composer(snap)) != "":
        raise UIBlocked("COMPOSER_NOT_EMPTY")
    work = tempfile.mkdtemp(prefix="wxv11-", dir="/tmp")
    try:
        raws = []
        for i, (st, ln) in enumerate(chunks):
            dst = os.path.join(work, "c%02d.raw" % i)
            render_chunk(real, st, ln, dst)
            raws.append((dst, ln + LEAD_S + TAIL_S))
        assert_no_wechat_modal()
        with VirtualMic() as mic:
            try:
                hold = enter_voice_mode(backend, rep)
                for i, (raw, secs) in enumerate(raws if hold is not None else []):
                    payload = "voice:%s:%s:%d/%d" % (real, digest, i + 1, len(raws))
                    if c.already_attempted(name, payload):
                        rep["results"].append({"chunk": i + 1, "status": "SKIPPED_ALREADY_ATTEMPTED"})
                        continue
                    snap = backend.snapshot()
                    c.require_chat(snap, name)
                    before = _rows_names(snap)
                    c.claim_send(name, payload)
                    r = hold_and_play(backend, mic, hold, raw, secs, name)
                    r["chunk"] = i + 1
                    rep["results"].append(r)
                    try:
                        assert_no_wechat_modal()
                    except UIBlocked as e:
                        r["status"] = "STOPPED_UNEXPECTED_WINDOW"
                        r["guard"] = e.code
                        r["extra"] = ws._extra_windows_report()
                        break
                    if r["status"] != "RELEASED":
                        # Nothing recorded: if no new row appears, free the marker.
                        _, grew, _ = c.wait_until(backend, lambda s: _rows_names(s) != before, 2.0, 0.15)
                        if not grew:
                            mk = c.MARKER_DIR / (c.send_key(name, payload) + ".attempt")
                            try:
                                mk.unlink()
                                r["marker_released"] = True
                            except OSError:
                                pass
                        break
                    snap, ok, ms = c.wait_until(
                        backend, lambda s: _rows_names(s) != before and len(_rows_names(s)) >= len(before), 4.0, 0.12)
                    if not ok:
                        r["status"] = "IN_DOUBT_NO_NEW_ROW"
                        break
                    r["new_row"] = (_rows_names(snap) or [""])[-1][:80]
                    r["direction"] = ws._last_direction(backend, pixels)
                    r["status"] = "VOICE_SENT_VERIFIED" if r["direction"] == "out" else "VOICE_SENT_UNVERIFIED"
                    time.sleep(0.8)
                    hold = _find(backend.snapshot(), HOLD_LABELS) or hold
            finally:
                _release()
                try:
                    leave_voice_mode(backend, rep)
                except UIBlocked as e:
                    rep["text_mode_restored"] = "error:" + e.code
    finally:
        shutil.rmtree(work, ignore_errors=True)
    sent = sum(1 for r in rep["results"] if str(r.get("status", "")).startswith("VOICE_SENT"))
    rep["status"] = ("VOICE_UI_DISCOVERY_ONLY" if "voice_ui" in rep else
                     "VOICE_ALL_SENT" if sent == len(chunks) else
                     "VOICE_PARTIAL" if sent else "VOICE_NOT_SENT")
    return rep


def make_test_audio(dst: str, text: str = "This is a WeChat voice message test. One, two, three.") -> str:
    """Spoken test clip if espeak-ng exists, otherwise a 4 s tone melody."""
    if shutil.which("espeak-ng"):
        wav = dst + ".wav"
        _run("espeak-ng", "-v", "en", "-s", "150", "-w", wav, text, timeout=30)
        _run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", wav, "-ar", str(RATE), "-ac", "1", dst, timeout=60)
        os.remove(wav)
    else:
        _run("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
             "sine=frequency=523:duration=4", "-af", "volume=0.4", "-ar", str(RATE), "-ac", "1", dst, timeout=60)
    return dst
