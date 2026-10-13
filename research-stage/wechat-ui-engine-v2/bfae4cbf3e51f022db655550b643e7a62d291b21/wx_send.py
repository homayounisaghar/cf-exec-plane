"""Generic sends v10: text to any chat + file via the native chooser.

Every send needs: lock, guard, exact chat identity (selected row + header),
owner confirmation sha256 of the payload, and a durable per-(recipient,
payload) marker written BEFORE the single irreversible action. No retries.
Main window: no keys at all (AT-SPI focus + EditableText + one Send click).
File chooser: keys only after verified X focus on that own-click popup.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import time
from typing import Optional

from engine import UIBlocked
import receive_readonly as rr
import wx_common as c
import wx_nav as nav


MAX_FILE_BYTES = 1000 * 1024 * 1024        # WeChat desktop file cap is ~1 GB
MEDIA_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".tif", ".tiff",
             ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".3gp", ".wmv", ".flv"}


def is_media(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in MEDIA_EXT


def all_row_names(snap) -> list:
    """Every message row name INCLUDING empty ones (photo/video bubbles may be unnamed)."""
    return [r.name or "" for r in c.message_rows(snap)]


def file_row_appeared(before: list, after: list, base: str, media: bool) -> str:
    """'' if nothing new; 'name' if the newest row shows the file name;
    'media_new_row' if a photo/video produced a new (possibly unnamed) row."""
    if not after or after == before:
        return ""
    if base in after[-1]:
        return "name"
    if media:
        return "media_new_row"
    return ""


def decide_after_chooser(send_enabled, how: str) -> tuple:
    """('staged'|'sent'|'', how). Send enabled => attachment waits in the
    composer (never count as sent, even if some row changed). A new row only
    counts while Send is DISABLED (composer empty)."""
    if send_enabled:
        return ("staged", "")
    if send_enabled is False and how:
        return ("sent", how)
    return ("", "")


def flush_self_draft(backend, pixels=None) -> dict:
    """File Transfer ONLY: if a previous run left an attachment staged in the
    composer (Send enabled), click Send once so the chat is clean."""
    from pointer_mapping import hover_target, click_once
    from x11_modal_guard import assert_no_wechat_modal
    assert_no_wechat_modal()
    snap = backend.snapshot()
    if not c.chat_identity_ok(snap, "File Transfer"):
        nav.find_and_open(backend, "File Transfer", pixels=pixels)
        snap = backend.snapshot()
    c.require_chat(snap, "File Transfer")
    sb = c.send_button(snap, require_enabled=False)
    if not sb.enabled():
        return {"status": "NOTHING_STAGED"}
    before = all_row_names(snap)
    click_once(hover_target(backend, sb, snap=snap, label="V11_FLUSH_SEND"))
    def done(s):
        return (not c.send_button(s, require_enabled=False).enabled()) and all_row_names(s) != before
    _, ok, ms = c.wait_until(backend, done, 8.0, 0.15)
    return {"status": "FLUSHED" if ok else "IN_DOUBT_FLUSH", "ms": ms,
            "direction": _last_direction_any(backend, pixels)}


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf8")).hexdigest()


def _last_direction(backend, pixels) -> str:
    if pixels is None:
        return "unknown"
    snap = backend.snapshot()
    dirs = nav.directions(snap, pixels)
    rows = [r for r in c.message_rows(snap) if not rr.is_separator(r.name) and (r.name or "").strip()]
    return dirs.get(rows[-1].path, "unknown") if rows else "unknown"


def _last_direction_any(backend, pixels) -> str:
    """Direction of the newest row even if it has no name (photo/video)."""
    if pixels is None:
        return "unknown"
    snap = backend.snapshot()
    dirs = nav.directions(snap, pixels)
    rows = [r for r in c.message_rows(snap) if not rr.is_separator(r.name)]
    return dirs.get(rows[-1].path, "unknown") if rows else "unknown"


def send_text(backend, name: str, text: str, confirm_sha: str, *,
              pixels: Optional[nav.Pixels] = None) -> dict:
    from pointer_mapping import hover_target, click_once
    from x11_modal_guard import assert_no_wechat_modal
    if not text or len(text) > 2000:
        raise UIBlocked("SEND_TEXT_INVALID")
    if _sha(text) != confirm_sha:
        raise UIBlocked("SEND_CONFIRM_SHA_MISMATCH")
    if c.already_attempted(name, "text:" + text):
        return {"status": "SKIPPED_ALREADY_ATTEMPTED"}
    t0 = time.monotonic()
    assert_no_wechat_modal()
    snap = backend.snapshot()
    c.require_chat(snap, name)
    ed = c.composer(snap)
    if c.read_text(backend, ed) != "":
        raise UIBlocked("COMPOSER_NOT_EMPTY")
    if c.send_button(snap, require_enabled=False).enabled():
        raise UIBlocked("SEND_ENABLED_BEFORE_DRAFT")
    before = c.body_tail(snap, 5)
    if not backend.focus(ed) or "focused" not in backend._states(backend._find(ed)):
        raise UIBlocked("COMPOSER_FOCUS_UNVERIFIED")
    c.set_text_once(backend, ed, text)
    if c.read_text(backend, ed) != text:
        raise UIBlocked("DRAFT_NOT_EXACT")
    draft_ms = round((time.monotonic() - t0) * 1000)
    snap = backend.snapshot()
    assert_no_wechat_modal()
    c.require_chat(snap, name)
    btn = c.send_button(snap, require_enabled=True)
    if c.read_text(backend, c.composer(snap)) != text or c.body_tail(snap, 5) != before:
        raise UIBlocked("SEND_PREFLIGHT_CHANGED")
    plan = hover_target(backend, btn, snap=snap, label="V10_SEND_POINTER")
    assert_no_wechat_modal()
    snap = backend.snapshot()
    c.require_chat(snap, name)
    if c.read_text(backend, c.composer(snap)) != text:
        raise UIBlocked("DRAFT_CHANGED_AFTER_HOVER")
    c.claim_send(name, "text:" + text)
    t1 = time.monotonic()
    try:
        click_once(plan)
    except Exception:
        return {"status": "IN_DOUBT_CLICK", "no_retry": True}
    def done(s):
        return (c.read_text(backend, c.composer(s)) == "" and
                not c.send_button(s, require_enabled=False).enabled() and
                c.chat_identity_ok(s, name) and
                c.tail_shift_ok(before, c.body_tail(s, 5), text))
    _, ok, verify_ms = c.wait_until(backend, done, 5.0, 0.12)
    if not ok:
        return {"status": "IN_DOUBT", "no_retry": True, "draft_ms": draft_ms}
    direction = _last_direction(backend, pixels)
    return {"status": "SENT_VERIFIED" if direction == "out" else "SENT_UNVERIFIED",
            "direction": direction, "draft_ms": draft_ms,
            "click_ms": round((time.monotonic() - t1) * 1000) - verify_ms,
            "verify_ms": verify_ms, "total_ms": round((time.monotonic() - t0) * 1000)}


# ------------------------------------------------------------ file send
def _chooser_text_fields(root):
    out, stack = [], [(root, 0)]
    while stack and len(out) < 20:
        acc, d = stack.pop()
        if acc is None or d > 24:
            continue
        try:
            role = (acc.get_role_name() or "").casefold()
            st = acc.get_state_set()
        except Exception:
            continue
        from atspi_backend import Atspi
        if role in ("text", "entry") and st.contains(Atspi.StateType.EDITABLE) \
                and st.contains(Atspi.StateType.SHOWING):
            out.append(acc)
        for i in range(min(acc.get_child_count(), 100) - 1, -1, -1):
            ch = acc.get_child_at_index(i)
            if ch is not None:
                stack.append((ch, d + 1))
    return out


def _acc_text(acc) -> str:
    from atspi_backend import Atspi
    t = acc.get_text_iface()
    n = t.get_character_count() if t else -1
    return Atspi.Text.get_text(t, 0, n) if n > 0 else ""


def _extra_windows_report() -> dict:
    """Read-only description of any extra viewable WeChat windows + AT-SPI roots."""
    rep = {"windows": [], "roots": []}
    try:
        pid = subprocess.run(("pgrep", "-u", str(os.getuid()), "-x", "wechat"), stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=5).stdout.decode().split()[0]
        wins = subprocess.run(("xdotool", "search", "--onlyvisible", "--pid", pid), stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5).stdout.decode().split()
        for w in wins[:20]:
            nm = subprocess.run(("xdotool", "getwindowname", w), stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=5).stdout.decode().strip()
            rep["windows"].append({"id": hex(int(w)), "name": nm})
        from atspi_backend import Atspi
        d = Atspi.get_desktop(0)
        for i in range(d.get_child_count()):
            app = d.get_child_at_index(i)
            if app is None or str(app.get_process_id()) != pid:
                continue
            for j in range(app.get_child_count()):
                r = app.get_child_at_index(j)
                names, stack = [], [(r, 0)]
                while stack and len(names) < 60:
                    a, dd = stack.pop()
                    if a is None or dd > 12:
                        continue
                    try:
                        nm = a.get_name() or ""
                        rl = a.get_role_name() or ""
                    except Exception:
                        continue
                    if nm:
                        names.append(rl + ":" + nm[:80])
                    for k in range(min(a.get_child_count(), 60)):
                        stack.append((a.get_child_at_index(k), dd + 1))
                rep["roots"].append({"role": r.get_role_name() if r else None,
                                     "name": r.get_name() if r else None, "texts": names})
    except Exception as e:  # report only
        rep["error"] = type(e).__name__
    return rep


def send_file(backend, name: str, path: str, confirm_sha: str, *,
              pixels: Optional[nav.Pixels] = None) -> dict:
    """Send one local file to `name` through the native Select File chooser."""
    import gate_file_chooser_once as gf
    import wechat_popup_e2e_v4 as v4
    from pointer_mapping import hover_target, click_once
    from x11_modal_guard import assert_no_wechat_modal, new_expected_file_chooser
    real = os.path.realpath(path)
    if not os.path.isfile(real) or os.path.getsize(real) > MAX_FILE_BYTES:
        raise UIBlocked("FILE_INVALID")
    if _sha(real) != confirm_sha:
        raise UIBlocked("SEND_CONFIRM_SHA_MISMATCH")
    with open(real, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    payload = "file:" + real + ":" + digest
    if c.already_attempted(name, payload):
        return {"status": "SKIPPED_ALREADY_ATTEMPTED"}
    t0 = time.monotonic()
    snap = backend.snapshot()
    c.require_chat(snap, name)
    if c.read_text(backend, c.composer(snap)) != "":
        raise UIBlocked("COMPOSER_NOT_EMPTY")
    before = all_row_names(snap)
    media = is_media(real)
    btn = c.toolbar_button(snap, {"send file", "\u53d1\u9001\u6587\u4ef6"})
    plan = hover_target(backend, btn, snap=snap, label="V10_FILE_BUTTON")
    scope = new_expected_file_chooser()
    click_once(plan, expected_file_scope=scope)
    root, _buttons = gf._wait_open(scope)
    open_ms = round((time.monotonic() - t0) * 1000)
    fields = _chooser_text_fields(root)
    if len(fields) != 1:
        raise UIBlocked("CHOOSER_FILENAME_FIELD_NOT_UNIQUE")
    fld = fields[0]
    edit = fld.get_editable_text_iface()
    try:
        edit.set_text_contents(real)
    except Exception:
        pass
    if _acc_text(fld) != real:
        raise UIBlocked("CHOOSER_FILENAME_NOT_EXACT")
    if not v4._focus_own_popup(scope):
        raise UIBlocked("CHOOSER_FOCUS_UNVERIFIED")
    c.claim_send(name, payload)   # Return may send immediately
    subprocess.run(("xdotool", "key", "Return"), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=5, check=False)
    deadline = time.monotonic() + 3.0
    while True:
        try:
            st = v4._window_state(scope.window_id)
        except UIBlocked:
            st = "unknown"
        if st in ("hidden", "gone"):
            break
        if time.monotonic() > deadline:
            return {"status": "IN_DOUBT_CHOOSER_STILL_OPEN", "no_retry": True,
                    "extra": _extra_windows_report()}
        time.sleep(0.1)
    try:
        assert_no_wechat_modal()
    except UIBlocked as e:
        return {"status": "STOPPED_UNEXPECTED_DIALOG_AFTER_CHOOSER", "guard": e.code,
                "no_click": True, "extra": _extra_windows_report()}
    base = os.path.basename(real)
    wait_s = min(30.0, 3.0 + os.path.getsize(real) / (2 * 1024 * 1024))
    def observe(s):
        try:
            en = c.send_button(s, require_enabled=False).enabled()
        except UIBlocked:
            en = None
        return en, file_row_appeared(before, all_row_names(s), base, media)
    def result(status, how):
        d = _last_direction_any(backend, pixels)
        if how == "media_new_row" and d != "out":
            status = "FILE_SENT_UNVERIFIED"
        return {"status": status, "match": how, "media": media, "direction": d,
                "open_ms": open_ms, "total_ms": round((time.monotonic() - t0) * 1000)}
    # 1) staged in the composer (Send enabled) or sent directly on select?
    state = {"v": ("", "")}
    def settled(s):
        en, how = observe(s)
        state["v"] = decide_after_chooser(en, how)
        return state["v"][0] != ""
    snap, ok, _ = c.wait_until(backend, settled, 2.0, 0.12)
    kind, how = state["v"]
    if kind == "sent":
        return result("FILE_SENT_ON_SELECT", how)
    if kind != "staged":
        snap, ok, _ = c.wait_until(backend, settled, wait_s, 0.2)
        kind, how = state["v"]
        if kind == "sent":
            return result("FILE_SENT_ON_SELECT", how)
        if kind != "staged":
            return {"status": "IN_DOUBT_NO_ROW_NO_SEND_BUTTON", "no_retry": True}
    # 2) staged: exactly one Send click, then Send must go disabled + row appear
    snap = backend.snapshot()
    c.require_chat(snap, name)
    sb = c.send_button(snap, require_enabled=True)
    plan2 = hover_target(backend, sb, snap=snap, label="V10_FILE_SEND_POINTER")
    click_once(plan2)
    fin = {"how": ""}
    def done(s):
        en, how = observe(s)
        fin["how"] = how
        return en is False and how != ""
    snap, ok, ms = c.wait_until(backend, done, max(5.0, wait_s), 0.15)
    if not ok:
        return {"status": "IN_DOUBT_AFTER_SEND_CLICK", "no_retry": True}
    return result("FILE_SENT_AFTER_SEND_CLICK", fin["how"])
