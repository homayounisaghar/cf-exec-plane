"""WeChat engine v10 CLI. One process = one lock = one guarded session.

  wx_v10.py state
  wx_v10.py list-all
  wx_v10.py open NAME            (visible row or scroll; refuses unread unless Moe/File Transfer)
  wx_v10.py search-open NAME [--allow-typing] [--click-result]   (default: discovery only, no result click)
  wx_v10.py read NAME N
  wx_v10.py history NAME PAGES
  wx_v10.py send-text NAME TEXT_B64 SHA256_OF_TEXT
  wx_v10.py send-file NAME PATH SHA256_OF_REALPATH
  wx_v10.py menu NAME
  wx_v10.py watch SECONDS
  wx_v10.py acceptance [--allow-typing]
  wx_v10.py flush-self-draft                    (File Transfer only: send a leftover staged attachment)
  wx_v10.py voice-probe                         (read-only audio readiness)
  wx_v10.py send-voice NAME PATH SHA256_OF_REALPATH [MAX_CHUNKS]
  wx_v10.py voice-accept                        (test clip -> File Transfer)

Output: one JSON document on stdout (also /tmp/wxeng/v10_last.json).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
import traceback

from engine import UIBlocked
import receive_readonly as rr
import wx_common as c
import wx_nav as nav

ACCEPT_TEXT = "\u0622\u0632\u0645\u0627\u06cc\u0634 \u062c\u0633\u062a\u062c\u0648 \u0648 \u0627\u0631\u0633\u0627\u0644 \u2014 \u067e\u06cc\u0627\u0645 \u0628\u0647 \u062e\u0648\u062f\u0645"
SELF_CHAT = "File Transfer"
HOME_CHAT = "Moe"
SAFE_CODES = {"CHAT_NOT_VISIBLE", "CHAT_NOT_FOUND_IN_LIST", "CHAT_HAS_UNREAD_NOT_OPENED",
              "UNREAD_STATE_UNKNOWN_NOT_OPENED", "SEARCH_RESULT_NOT_FOUND",
              "SEARCH_RESULT_AMBIGUOUS", "SEARCH_FIELD_NOT_UNIQUE", "CHAT_LIST_TOP_NOT_REACHED",
              "WINDOW_CAPTURE_FAILED", "MAIN_WINDOW_NOT_UNIQUE", "NO_FULL_MESSAGE_ROW",
              "CHOOSER_FILENAME_FIELD_NOT_UNIQUE", "FILE_INVALID", "SEARCH_FOCUS_UNVERIFIED",
              "TOOLBAR_BUTTON_NOT_UNIQUE", "UNREAD_STATE_UNKNOWN_NOT_OPENED",
              "CHAT_HAS_UNREAD_NOT_OPENED", "COMPOSER_NOT_EMPTY",
              "SEARCH_RESULT_POINTER_UNVERIFIED", "SEARCH_RESULT_OUTSIDE_POPUP",
              "SEARCH_RESULT_POINT_OUTSIDE_POPUP_WINDOW", "SEARCH_POPUP_ROOT_NOT_UNIQUE",
              "SEARCH_POPUP_GONE_BEFORE_CLICK", "OPEN_CONVERSATION_UNVERIFIED",
              "SEARCH_FIELD_NOT_EMPTY_AT_START", "POINTER_TARGET_HIT_TEST_FAILED",
              "SEARCH_POPUP_ATSPI_NO_ITEMS", "SEARCH_POPUP_NOT_CLOSED"}
OUT = "/tmp/wxeng/v10_last.json"
# Commands that touch the UI: first close WeChat's own search dropdown (if open).
LIVE_CMDS = {"state", "list-all", "open", "search-open", "read", "history", "send-text",
             "send-file", "menu", "watch", "flush-self-draft", "send-voice", "voice-accept",
             "acceptance"}


def state(backend) -> dict:
    from x11_modal_guard import assert_no_wechat_modal
    assert_no_wechat_modal()
    s = backend.snapshot()
    sel = None
    try:
        sel = rr._selected_chat_name(s)
    except UIBlocked as e:
        sel = "?" + e.code
    out = {"selected": sel}
    try:
        out["header_ok"] = c.chat_identity_ok(s, sel) if isinstance(sel, str) else False
        out["composer_empty"] = c.read_text(backend, c.composer(s)) == ""
        out["send_enabled"] = c.send_button(s, require_enabled=False).enabled()
        out["search_empty"] = c.read_text(backend, c.search_field(s)) == ""
    except UIBlocked as e:
        out["error"] = e.code
    out["no_extra_window"] = True
    return out


def _calibration(backend, pixels) -> dict:
    """Direction check against KNOWN rows of Moe's chat (4 out, 1 in)."""
    s = backend.snapshot()
    c.require_chat(s, HOME_CHAT)
    dirs = nav.directions(s, pixels)
    known_out = ("\u067e\u06cc\u0627\u0645 \u0622\u0632\u0645\u0627\u06cc\u0634\u06cc \u0633\u0631\u0639\u062a",
                 "\u0627\u06cc\u0646 \u067e\u06cc\u0627\u0645 \u0622\u0632\u0645\u0627\u06cc\u0634\u06cc \u0627\u0633\u062a")
    known_in = ("\u0633\u0631\u0645\u0648\u0646 \u062f\u0631\u062f \u06af\u0631\u0641\u062a",)
    ok = bad = 0
    detail = []
    lst = rr._unique_list(s, rr.MESSAGES_NAMES)
    for r in rr._rows(s, lst):
        exp = "out" if r.name.startswith(known_out) else "in" if r.name in known_in else None
        if exp is None or r.path not in dirs:
            continue
        got = dirs[r.path]
        if got == "unknown":
            detail.append({"expected": exp, "got": got})
            continue
        ok += got == exp
        bad += got != exp
        detail.append({"expected": exp, "got": got})
    return {"correct": ok, "wrong": bad, "rows": detail, "capture_error": pixels.err}


def write_test_png(path: str, w: int = 240, h: int = 160) -> str:
    """Small colourful PNG (pure Python, no PIL needed)."""
    import struct
    import zlib
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(((x * 255) // w, (y * 255) // h, 160))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
    return path


def acceptance(backend, allow_typing: bool) -> dict:
    import wx_send as ws
    pixels = nav.Pixels()
    stamp = time.strftime("%m%d-%H%M%S")
    rep = {"phases": {}, "stopped": None, "run_stamp": stamp}
    text = ACCEPT_TEXT + " " + stamp   # unique per run: one-shot send markers never skip it

    def phase(name, fn):
        if rep["stopped"]:
            rep["phases"][name] = {"skipped": True}
            return None
        t = time.monotonic()
        try:
            r = fn()
            rep["phases"][name] = {"ok": True, "ms": round((time.monotonic() - t) * 1000), "result": r}
            return r
        except UIBlocked as e:
            rep["phases"][name] = {"ok": False, "code": e.code}
            if e.code not in SAFE_CODES:
                rep["stopped"] = name + ":" + e.code
        except Exception as e:  # unexpected: record; the next phase's guard decides
            rep["phases"][name] = {"ok": False, "exception": type(e).__name__,
                                   "trace": traceback.format_exc()[-1500:]}
        return None

    phase("A0_flush_leftover_self_draft", lambda: ws.flush_self_draft(backend, pixels))
    phase("A_start_state", lambda: state(backend))
    phase("B_open_home", lambda: nav.find_and_open(backend, HOME_CHAT, pixels=pixels))
    phase("C_direction_calibration", lambda: _calibration(backend, pixels))
    phase("D_unread_dots_visible", lambda: [
        {"name": r.name.split("\n", 1)[0], "dot": nav.unread_dot(backend.snapshot(), r, pixels)}
        for r in c.chat_rows(backend.snapshot())])
    allc = phase("E_list_all_chats", lambda: nav.list_all_chats(backend))

    def open_hidden():
        if not allc:
            raise UIBlocked("CHAT_NOT_FOUND_IN_LIST")
        visible = {r.name.split("\n", 1)[0] for r in c.chat_rows(backend.snapshot())}
        tried, errs = [], []
        for item in reversed(allc["chats"]):
            nm = item["name"]
            if nm in visible or nm in (HOME_CHAT, SELF_CHAT) or len(tried) >= 4:
                continue
            tried.append(nm)
            try:
                r = nav.find_and_open(backend, nm, pixels=pixels)
                r["read"] = rr.read_open_chat(backend.snapshot(), 5, nm)
                r["tried"] = tried
                return r
            except UIBlocked as e:
                if e.code not in ("CHAT_HAS_UNREAD_NOT_OPENED", "UNREAD_STATE_UNKNOWN_NOT_OPENED",
                                  "CHAT_NOT_FOUND_IN_LIST"):
                    raise
                errs.append(nm + ":" + e.code)
        rep["phases"]["F_tried"] = {"errors": errs, "pixels_err": pixels.err}
        raise UIBlocked(errs[-1].split(":")[-1] if errs else "CHAT_NOT_FOUND_IN_LIST")
    phase("F_open_hidden_chat_by_scroll", open_hidden)
    # v11.7: search typing removed from acceptance (list-scroll open works; the
    # dropdown stalled v11.5/v11.6). Only clear any leftover dropdown/search text.
    phase("G_dismiss_search_leftover", lambda: nav.dismiss_search_popup(backend))

    def ensure_self():
        s = backend.snapshot()
        if not c.chat_identity_ok(s, SELF_CHAT):
            return nav.find_and_open(backend, SELF_CHAT, pixels=pixels)
        return {"already": True}
    phase("H_ensure_self_chat", ensure_self)
    phase("I_send_text_self", lambda: ws.send_text(
        backend, SELF_CHAT, text, hashlib.sha256(text.encode()).hexdigest(), pixels=pixels))

    def file_send():
        p = "/tmp/wxeng/wx_file_test_%s.txt" % stamp
        if not os.path.exists(p):
            with open(p, "w", encoding="utf8") as f:
                f.write("WeChat engine file-send test to self %s\n" % stamp)
        real = os.path.realpath(p)
        return ws.send_file(backend, SELF_CHAT, real, hashlib.sha256(real.encode()).hexdigest(), pixels=pixels)
    phase("J_send_file_self", file_send)

    def image_send():
        p = "/tmp/wxeng/wx_image_test_%s.png" % stamp
        if not os.path.exists(p):
            write_test_png(p)
        real = os.path.realpath(p)
        return ws.send_file(backend, SELF_CHAT, real, hashlib.sha256(real.encode()).hexdigest(), pixels=pixels)
    phase("J2_send_image_self", image_send)
    phase("K_history_self", lambda: nav.read_history(backend, SELF_CHAT, 2, pixels=pixels))
    phase("L_back_home", lambda: nav.find_and_open(backend, HOME_CHAT, pixels=pixels))
    phase("M_history_home", lambda: nav.read_history(backend, HOME_CHAT, 3, pixels=pixels))
    import wx_menu_watch as mw
    phase("N_watch_120s", lambda: mw.watch_chats(backend, 120, 3.0))
    phase("O_context_menu_discovery_self", lambda: (
        nav.find_and_open(backend, SELF_CHAT, pixels=pixels),
        mw.discover_context_menu(backend, SELF_CHAT))[1])
    phase("P_back_home_final", lambda: nav.find_and_open(backend, HOME_CHAT, pixels=pixels))
    rep["final_state"] = None
    try:
        rep["final_state"] = state(backend)
    except UIBlocked as e:
        rep["final_state"] = {"error": e.code}
    return rep


def voice_accept(backend, pixels) -> dict:
    """Probe audio, make a short test clip, send it as voice to File Transfer."""
    import wx_voice as wv
    rep = {"probe": wv.audio_probe(), "audio_env": wv.audio_env_diag()}
    if not rep["probe"].get("ready"):
        rep["status"] = "VOICE_AUDIO_STACK_NOT_READY"
        return rep
    clip = wv.make_test_audio("/tmp/wxeng/wx_voice_test_%s.wav" % time.strftime("%m%d-%H%M%S"))
    real = os.path.realpath(clip)
    rep["send"] = wv.send_voice(backend, SELF_CHAT, real,
                                hashlib.sha256(real.encode("utf8")).hexdigest(),
                                pixels=pixels, max_chunks=1)
    rep["status"] = rep["send"].get("status")
    return rep


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(__doc__)
        return 2
    from atspi_backend import AtspiBackend
    from wechat_live_lock import WeChatLiveLock
    cmd, args = argv[0], argv[1:]
    try:
        with WeChatLiveLock():
            b = AtspiBackend()
            px = nav.Pixels()
            pre = None
            if cmd in LIVE_CMDS:
                try:
                    pre = nav.dismiss_search_popup(b)
                except UIBlocked as e:
                    if cmd != "acceptance":
                        raise
                    pre = {"error": e.code}   # every acceptance phase re-checks the guard
            if cmd == "state":
                out = state(b)
            elif cmd == "list-all":
                out = nav.list_all_chats(b)
            elif cmd == "open" and len(args) == 1:
                out = nav.find_and_open(b, args[0], pixels=px)
            elif cmd == "search-open" and 1 <= len(args) <= 3:
                out = nav.search_and_open(b, args[0], allow_typing="--allow-typing" in args,
                                          click_result="--click-result" in args)
            elif cmd == "read" and len(args) == 2:
                out = rr.read_open_chat(b.snapshot(), int(args[1]), args[0])
            elif cmd == "history" and len(args) == 2:
                out = nav.read_history(b, args[0], int(args[1]), pixels=px)
            elif cmd == "send-text" and len(args) == 3:
                import wx_send as ws
                text = base64.b64decode(args[1]).decode("utf8")
                out = ws.send_text(b, args[0], text, args[2], pixels=px)
            elif cmd == "send-file" and len(args) == 3:
                import wx_send as ws
                out = ws.send_file(b, args[0], args[1], args[2], pixels=px)
            elif cmd == "menu" and len(args) == 1:
                import wx_menu_watch as mw
                out = mw.discover_context_menu(b, args[0])
            elif cmd == "watch" and len(args) == 1:
                import wx_menu_watch as mw
                out = mw.watch_chats(b, int(args[0]))
            elif cmd == "flush-self-draft" and not args:
                import wx_send as ws
                out = ws.flush_self_draft(b, px)
            elif cmd == "voice-probe" and not args:
                import wx_voice as wv
                out = wv.audio_probe()
            elif cmd == "send-voice" and len(args) in (3, 4):
                import wx_voice as wv
                out = wv.send_voice(b, args[0], args[1], args[2], pixels=px,
                                    max_chunks=int(args[3]) if len(args) == 4 else 3)
            elif cmd == "voice-accept" and not args:
                out = voice_accept(b, px)
            elif cmd == "acceptance":
                out = acceptance(b, "--allow-typing" in args)
            else:
                print(__doc__)
                return 2
        doc = {"ok": True, "cmd": cmd, "preflight": pre, "result": out}
        code = 0
    except UIBlocked as e:
        doc, code = {"ok": False, "cmd": cmd, "blocked": e.code}, 3
    text = json.dumps(doc, ensure_ascii=False, indent=1, default=str)
    try:
        with open(OUT, "w", encoding="utf8") as f:
            f.write(text)
    except OSError:
        pass
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
