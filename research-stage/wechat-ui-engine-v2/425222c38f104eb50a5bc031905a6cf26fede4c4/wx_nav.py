"""Navigation v10: open by click, scroll (mouse wheel), list all chats,
find-and-open, search-and-open, read history. No main-window keys.

Search uses AT-SPI EditableText (no keyboard). Typing fallback
(xdotool type) is OFF unless allow_typing=True AND the search field is the
verified focused node; no keyboard keys are ever sent there.
"""
from __future__ import annotations

import json
import subprocess
import time
from typing import Optional

from engine import Node, Snapshot, UIBlocked
import receive_readonly as rr
import wx_common as c

ALWAYS_OPENABLE = ("Moe", "File Transfer")


# ------------------------------------------------------------ pure merging
def merge_pages(earlier: list, later: list, key=lambda x: x) -> list:
    """Join two ordered pages using the LONGEST overlap (suffix of earlier
    == prefix of later). No overlap -> plain concat (caller flags a gap)."""
    ke, kl = [key(x) for x in earlier], [key(x) for x in later]
    for size in range(min(len(ke), len(kl)), 0, -1):
        if ke[-size:] == kl[:size]:
            return list(earlier) + list(later[size:])
    return list(earlier) + list(later)


def overlap_size(earlier: list, later: list, key=lambda x: x) -> int:
    ke, kl = [key(x) for x in earlier], [key(x) for x in later]
    for size in range(min(len(ke), len(kl)), 0, -1):
        if ke[-size:] == kl[:size]:
            return size
    return 0


def chat_key(item: dict):
    return (item["name"], item.get("time"), item.get("preview"))


# ------------------------------------------------------------ pixel access
class Pixels:
    """Lazy one-capture-per-call pixel access (None if capture unavailable)."""
    def __init__(self):
        self.err = None

    def grab(self, snap: Snapshot):
        import wx_pixels as px
        from pointer_mapping import main_frame_rect
        try:
            frame = main_frame_rect(snap)
            win, scale = px.main_window_and_scale(frame)
            return px.capture_window(win), px.Mapper(frame, scale)
        except UIBlocked as e:
            self.err = e.code + ":" + ";".join(px.LAST_CAPTURE.get("errors", [])[-3:])
            return None, None


def unread_dot(snap: Snapshot, row: Node, pixels: Optional[Pixels]):
    if pixels is None:
        return None
    import wx_pixels as px
    img, m = pixels.grab(snap)
    if img is None:
        return None
    return px.chat_unread_dot(img, m, row)["unread_dot"]


def directions(snap: Snapshot, pixels: Optional[Pixels]) -> dict:
    """{row.path: direction} for visible message rows (one capture)."""
    if pixels is None:
        return {}
    import wx_pixels as px
    img, m = pixels.grab(snap)
    if img is None:
        return {}
    lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
    out = {}
    for r in rr._rows(snap, lst):
        if rr.is_separator(r.name):
            continue
        out[r.path] = px.message_direction(img, m, r, lst.rect)["direction"]
    return out


# ------------------------------------------------------------ open
def open_conversation(backend, name: str, *, pixels: Optional[Pixels] = None,
                      allow_unread: bool = False) -> dict:
    t0 = time.monotonic()
    snap = backend.snapshot()
    if c.chat_identity_ok(snap, name):
        return {"opened": name, "already": True, "ms": 0}
    row = c.row_by_name(snap, name)
    if row is None:
        raise UIBlocked("CHAT_NOT_VISIBLE")
    if not allow_unread and name not in ALWAYS_OPENABLE:
        dot = unread_dot(snap, row, pixels)
        if dot is None:
            raise UIBlocked("UNREAD_STATE_UNKNOWN_NOT_OPENED")
        if dot:
            raise UIBlocked("CHAT_HAS_UNREAD_NOT_OPENED")
    c.click_node(backend, row, snap, label="V10_OPEN_CHAT")
    _, ok, ms = c.wait_until(backend, lambda s: c.chat_identity_ok(s, name), 2.0)
    if not ok:
        raise UIBlocked("OPEN_CONVERSATION_UNVERIFIED")
    return {"opened": name, "already": False, "verify_ms": ms,
            "ms": round((time.monotonic() - t0) * 1000)}


# ------------------------------------------------------------ scrolling
def _chats_page(snap):
    return [rr.parse_chat_row(r.name) for r in c.chat_rows(snap)]


def _scroll_chats(backend, snap, direction, steps=3):
    lst = rr._unique_list(snap, rr.CHATS_NAMES)
    c.wheel(backend, lst, snap, direction, steps)
    time.sleep(0.25)
    return backend.snapshot()


def scroll_chats_to_top(backend, max_steps: int = 40) -> int:
    snap = backend.snapshot()
    prev = None
    for i in range(max_steps):
        page = [chat_key(x) for x in _chats_page(snap)]
        if page == prev:
            return i
        prev = page
        snap = _scroll_chats(backend, snap, "up", 5)
    raise UIBlocked("CHAT_LIST_TOP_NOT_REACHED")


def list_all_chats(backend, max_steps: int = 60) -> dict:
    t0 = time.monotonic()
    scroll_chats_to_top(backend)
    snap = backend.snapshot()
    acc = _chats_page(snap)
    first = [chat_key(x) for x in acc[:3]]
    gaps = 0
    for _ in range(max_steps):
        snap2 = _scroll_chats(backend, snap, "down", 3)
        page = _chats_page(snap2)
        if [chat_key(x) for x in page] == [chat_key(x) for x in _chats_page(snap)]:
            break
        if overlap_size(acc, page, chat_key) == 0:
            gaps += 1
        acc = merge_pages(acc, page, chat_key)
        snap = snap2
    scroll_chats_to_top(backend)
    top = [chat_key(x) for x in _chats_page(backend.snapshot())[:3]]
    return {"chats": acc, "total": len(acc), "gaps": gaps, "returned_to_top": top == first,
            "ms": round((time.monotonic() - t0) * 1000)}


def find_and_open(backend, name: str, *, pixels: Optional[Pixels] = None,
                  allow_unread: bool = False, max_steps: int = 60) -> dict:
    t0 = time.monotonic()
    snap = backend.snapshot()
    if c.chat_identity_ok(snap, name):
        return {"opened": name, "already": True, "scroll_steps": 0}
    steps = 0
    if c.row_by_name(snap, name) is None:
        scroll_chats_to_top(backend)
        snap = backend.snapshot()
        while c.row_by_name(snap, name) is None and steps < max_steps:
            snap2 = _scroll_chats(backend, snap, "down", 3)
            steps += 1
            if [chat_key(x) for x in _chats_page(snap2)] == [chat_key(x) for x in _chats_page(snap)]:
                snap = snap2
                break
            snap = snap2
        if c.row_by_name(snap, name) is None:
            scroll_chats_to_top(backend)
            raise UIBlocked("CHAT_NOT_FOUND_IN_LIST")
    r = open_conversation(backend, name, pixels=pixels, allow_unread=allow_unread)
    r["scroll_steps"] = steps
    r["ms"] = round((time.monotonic() - t0) * 1000)
    return r


# ------------------------------------------------------------ history
def _msg_page(snap, pixels):
    dirs = directions(snap, pixels)
    lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
    out, sep = [], None
    for r in rr._rows(snap, lst):
        if rr.is_separator(r.name):
            sep = r.name.strip()
            continue
        if not (r.name or "").strip():
            continue
        frac = rr.visible_fraction(r, lst)
        if frac is not None and frac < 0.999:
            continue  # partial rows are re-read when fully visible
        item = rr.parse_message_row(r.name)
        item["after_separator"] = sep
        item["direction"] = dirs.get(r.path, "unknown")
        out.append(item)
    return out


def read_history(backend, expect_chat: str, max_pages: int = 3, *,
                 pixels: Optional[Pixels] = None) -> dict:
    t0 = time.monotonic()
    snap = backend.snapshot()
    c.require_chat(snap, expect_chat)
    start_tail = c.body_tail(snap, 5)
    key = lambda m: m["raw"]
    acc = _msg_page(snap, pixels)
    pages, gaps = 1, 0
    lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
    for _ in range(max_pages - 1):
        c.wheel(backend, lst, snap, "up", 4)
        time.sleep(0.35)
        snap2 = backend.snapshot()
        c.require_chat(snap2, expect_chat)
        page = _msg_page(snap2, pixels)
        if [key(x) for x in page] == [key(x) for x in _msg_page(snap, None)] or not page:
            break
        if overlap_size(page, acc, key) == 0:
            gaps += 1
        acc = merge_pages(page, acc, key)
        snap, pages = snap2, pages + 1
        lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
    # back to the bottom
    for _ in range(max_pages * 3 + 3):
        snap = backend.snapshot()
        if c.body_tail(snap, 5) == start_tail:
            break
        c.wheel(backend, rr._unique_list(snap, rr.MESSAGES_NAMES), snap, "down", 5)
        time.sleep(0.3)
    back = c.body_tail(backend.snapshot(), 5) == start_tail
    counts = {d: sum(1 for m in acc if m["direction"] == d) for d in ("in", "out", "unknown")}
    return {"chat": expect_chat, "messages": acc, "count": len(acc), "pages": pages,
            "gaps": gaps, "returned_to_bottom": back, "direction_counts": counts,
            "ms": round((time.monotonic() - t0) * 1000)}


# ------------------------------------------------------------ search
def _result_candidates(snap: Snapshot, name: str) -> list[Node]:
    msgs = None
    try:
        msgs = rr._unique_list(snap, rr.MESSAGES_NAMES)
    except UIBlocked:
        pass
    out = []
    for n in snap.nodes:
        if n.role not in ("list item", "list-item") or not n.visible():
            continue
        if msgs is not None and c.is_child(n, msgs):
            continue
        if (n.name or "").split("\n", 1)[0].strip() == name:
            out.append(n)
    return out


def _dump_showing(snap: Snapshot, path: str) -> None:
    nodes = [{"path": list(n.path), "role": n.role, "name": n.name, "states": sorted(n.states),
              "rect": [n.rect.x, n.rect.y, n.rect.w, n.rect.h] if n.rect else None}
             for n in snap.nodes if n.visible()]
    with open(path, "w", encoding="utf8") as f:
        json.dump(nodes, f, ensure_ascii=False)


def clear_search(backend) -> bool:
    snap = backend.snapshot()
    sf = c.search_field(snap)
    if c.read_text(backend, sf) == "":
        return True
    c.set_text_once(backend, sf, "")
    time.sleep(0.3)
    return c.read_text(backend, c.search_field(backend.snapshot())) == ""


def search_and_open(backend, name: str, *, allow_typing: bool = False,
                    dump_path: str = "/tmp/wxeng/v10_search_dump.json") -> dict:
    t0 = time.monotonic()
    snap = backend.snapshot()
    sf = c.search_field(snap)
    if c.read_text(backend, sf) != "":
        raise UIBlocked("SEARCH_FIELD_NOT_EMPTY_AT_START")
    before_composer = c.read_text(backend, c.composer(snap))
    method = "editable_text"
    c.set_text_once(backend, sf, name)
    snap, ok, ms = c.wait_until(backend, lambda s: len(_result_candidates(s, name)) >= 1
                                and c.read_text(backend, c.search_field(s)) == name, 3.0)
    if not ok and allow_typing:
        clear_search(backend)
        snap = backend.snapshot()
        sf = c.search_field(snap)
        c.click_node(backend, sf, snap, label="V10_SEARCH_FOCUS")
        fresh = backend._find(sf)
        if "focused" not in backend._states(fresh):
            raise UIBlocked("SEARCH_FOCUS_UNVERIFIED")
        from wechat_live_lock import require_wechat_lock
        from x11_modal_guard import assert_no_wechat_modal
        require_wechat_lock()
        assert_no_wechat_modal()
        subprocess.run(("xdotool", "type", "--delay", "40", "--", name), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=False)
        assert_no_wechat_modal()
        method = "typed"
        snap, ok, ms = c.wait_until(backend, lambda s: len(_result_candidates(s, name)) >= 1, 3.0)
    if c.read_text(backend, c.composer(snap)) != before_composer:
        raise UIBlocked("COMPOSER_CHANGED_DURING_SEARCH")
    cands = _result_candidates(snap, name)
    if len(cands) != 1:
        _dump_showing(snap, dump_path)
        clear_search(backend)
        raise UIBlocked("SEARCH_RESULT_NOT_FOUND" if not cands else "SEARCH_RESULT_AMBIGUOUS")
    c.click_node(backend, cands[0], snap, label="V10_SEARCH_RESULT")
    _, ok2, ms2 = c.wait_until(backend, lambda s: c.chat_identity_ok(s, name), 2.5)
    cleared = clear_search(backend)
    if not ok2:
        raise UIBlocked("OPEN_CONVERSATION_UNVERIFIED")
    return {"opened": name, "method": method, "results_ms": ms, "verify_ms": ms2,
            "search_cleared": cleared, "ms": round((time.monotonic() - t0) * 1000)}
