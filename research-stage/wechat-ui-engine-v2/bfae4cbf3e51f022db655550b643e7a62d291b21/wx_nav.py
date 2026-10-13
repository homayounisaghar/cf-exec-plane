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


# ------------------------------------------------- search dropdown (own popup)
def _guard(allow: bool = True):
    from x11_modal_guard import assert_no_wechat_modal
    return assert_no_wechat_modal(allow_search_popup=allow)


def _popup_info():
    """None if no extra window; dict if ONLY the verified search dropdown is open.
    Any other extra window raises (fail closed)."""
    r = _guard(True)
    return r if isinstance(r, dict) and r.get("search_popup") else None


def _main_click(backend, node, snap, label):
    """One click on a MAIN-window control while the search dropdown may be open.
    Pointer target verified (semantic hit + X11 pointer over the main window)."""
    from wechat_live_lock import require_wechat_lock
    from pointer_mapping import hover_target
    require_wechat_lock()
    _guard(True)
    plan = hover_target(backend, node, snap=snap, label=label)
    p = subprocess.run(("xdotool", "click", "1"), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=5, check=False)
    print(label + " click physical_x=%d physical_y=%d" % (plan[1], plan[2]), flush=True)
    if p.returncode != 0:
        raise UIBlocked("POINTER_CLICK_IN_DOUBT")
    time.sleep(0.4)
    return _popup_info()


def _popup_root(snap):
    from pointer_mapping import main_frame_rect
    frame = main_frame_rect(snap)
    roots = [n for n in snap.nodes if len(n.path) == 1 and n.visible() and n.rect
             and n.role.casefold() == "filler" and n.rect != frame]
    if len(roots) != 1:
        raise UIBlocked("SEARCH_POPUP_ROOT_NOT_UNIQUE")
    return roots[0]


def _popup_candidates(snap, name: str) -> list:
    root = _popup_root(snap)
    key = " ".join(name.casefold().split())
    return [n for n in snap.nodes if n.path[:1] == root.path and n.role in ("list item", "list-item")
            and n.visible() and n.rect
            and " ".join((n.name or "").split("\n", 1)[0].casefold().split()) == key]


def _popup_click(backend, node, snap, popup: dict, label="V114_SEARCH_RESULT"):
    """One click on a result row INSIDE the verified search dropdown."""
    from wechat_live_lock import require_wechat_lock
    from pointer_mapping import main_frame_rect
    require_wechat_lock()
    root = _popup_root(snap)
    r = node.rect
    if not (node.path[:1] == root.path and root.rect.x <= r.x and root.rect.y <= r.y
            and r.x + r.w <= root.rect.x + root.rect.w + 1 and r.y + r.h <= root.rect.y + root.rect.h + 1):
        raise UIBlocked("SEARCH_RESULT_OUTSIDE_POPUP")
    import wx_pixels as px
    frame = main_frame_rect(snap)
    win, scale = px.main_window_and_scale(frame)
    gx, gy, _, _ = px.window_geometry(win)
    x = int(round(gx + (r.x + r.w / 2 - frame.x) * scale))
    y = int(round(gy + (r.y + r.h / 2 - frame.y) * scale))
    qx, qy, qw, qh = popup["geometry"]
    if not (qx + 2 <= x <= qx + qw - 2 and qy + 2 <= y <= qy + qh - 2):
        raise UIBlocked("SEARCH_RESULT_POINT_OUTSIDE_POPUP_WINDOW")
    if _popup_info() is None:
        raise UIBlocked("SEARCH_POPUP_GONE_BEFORE_CLICK")
    subprocess.run(("xdotool", "mousemove", str(x), str(y)), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=5, check=False)
    loc = subprocess.run(("xdotool", "getmouselocation", "--shell"), stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=5,
                         check=False).stdout.decode()
    g = dict(l.split("=", 1) for l in loc.splitlines() if "=" in l)
    if g.get("X") != str(x) or g.get("Y") != str(y) or g.get("WINDOW") != str(popup["window_id"]):
        raise UIBlocked("SEARCH_RESULT_POINTER_UNVERIFIED")
    p = subprocess.run(("xdotool", "click", "1"), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=5, check=False)
    print(label + " click physical_x=%d physical_y=%d" % (x, y), flush=True)
    if p.returncode != 0:
        raise UIBlocked("POINTER_CLICK_IN_DOUBT")


def dismiss_search_popup(backend) -> dict:
    """Close WeChat's search dropdown if it is open. No keys. Steps:
    1) empty the search text (EditableText), 2) one click into the (empty)
    message composer, 3) one click on the open chat's header title.
    Any other extra window blocks. Verifies the dropdown is gone."""
    info = _popup_info()
    if info is None:
        return {"present": False}
    out = {"present": True, "items": info.get("items"), "steps": []}
    try:
        snap = backend.snapshot()
        if c.read_text(backend, c.search_field(snap)) != "":
            c.set_text_once(backend, c.search_field(snap), "")
            time.sleep(0.6)
            out["steps"].append("cleared_text")
            if _popup_info() is None:
                out["closed_by"] = "cleared_text"
                return out
    except UIBlocked as e:
        out["steps"].append("clear_failed:" + e.code)
    try:
        snap = backend.snapshot()
        comp = c.composer(snap)
        before = c.read_text(backend, comp)
        left = _main_click(backend, comp, snap, "V114_DISMISS_COMPOSER")
        out["steps"].append("composer_click")
        if c.read_text(backend, c.composer(backend.snapshot())) != before:
            raise UIBlocked("COMPOSER_CHANGED_DURING_DISMISS")
        if left is None:
            out["closed_by"] = "composer_click"
            return out
    except UIBlocked as e:
        if e.code == "COMPOSER_CHANGED_DURING_DISMISS":
            raise
        out["steps"].append("composer_failed:" + e.code)
    try:
        snap = backend.snapshot()
        name = rr._selected_chat_name(snap)
        lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
        hdr = [n for n in snap.nodes if n.role == "label" and n.visible() and n.rect and lst.rect
               and (n.name or "").strip() == name and lst.rect.y - 120 <= n.rect.y < lst.rect.y]
        if hdr:
            hdr.sort(key=lambda n: len(n.path))
            left = _main_click(backend, hdr[-1], snap, "V114_DISMISS_HEADER")
            out["steps"].append("header_click")
            if left is None:
                out["closed_by"] = "header_click"
                return out
    except UIBlocked as e:
        out["steps"].append("header_failed:" + e.code)
    raise UIBlocked("SEARCH_POPUP_NOT_CLOSED")


def search_and_open(backend, name: str, *, allow_typing: bool = False,
                    dump_path: str = "/tmp/wxeng/v10_search_dump.json") -> dict:
    """Open a chat via WeChat's search. Results appear in the separate search
    dropdown window; only that verified dropdown is accepted meanwhile."""
    t0 = time.monotonic()
    dismissed = dismiss_search_popup(backend)
    snap = backend.snapshot()
    sf = c.search_field(snap)
    if c.read_text(backend, sf) != "":
        clear_search(backend)
        snap = backend.snapshot()
        sf = c.search_field(snap)
        if c.read_text(backend, sf) != "":
            raise UIBlocked("SEARCH_FIELD_NOT_EMPTY_AT_START")
    before_composer = c.read_text(backend, c.composer(snap))

    def found(s):
        try:
            return len(_popup_candidates(s, name)) >= 1
        except UIBlocked:
            return False
    method = "editable_text"
    c.set_text_once(backend, sf, name)
    snap, ok, ms = c.wait_until(backend, found, 3.0, allow_search_popup=True)
    if not ok and allow_typing:
        method = "typed"
        clear_search(backend)
        dismiss_search_popup(backend)
        snap = backend.snapshot()
        sf = c.search_field(snap)
        _main_click(backend, sf, snap, "V114_SEARCH_FOCUS")
        snap = backend.snapshot()
        sf = c.search_field(snap)
        if "focused" not in backend._states(backend._find(sf)):
            raise UIBlocked("SEARCH_FOCUS_UNVERIFIED")
        if c.read_text(backend, sf) != "":
            raise UIBlocked("SEARCH_FIELD_NOT_EMPTY_AT_START")
        from wechat_live_lock import require_wechat_lock
        require_wechat_lock()
        _guard(True)
        subprocess.run(("xdotool", "type", "--delay", "40", "--", name), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=15, check=False)
        snap, ok, ms = c.wait_until(backend, found, 4.0, allow_search_popup=True)
    if c.read_text(backend, c.composer(snap)) != before_composer:
        raise UIBlocked("COMPOSER_CHANGED_DURING_SEARCH")
    try:
        cands = _popup_candidates(snap, name)
    except UIBlocked:
        cands = []
    if len(cands) != 1:
        _dump_showing(snap, dump_path)
        clear_search(backend)
        dismiss_search_popup(backend)
        raise UIBlocked("SEARCH_RESULT_NOT_FOUND" if not cands else "SEARCH_RESULT_AMBIGUOUS")
    popup = _popup_info()
    if popup is None:
        raise UIBlocked("SEARCH_POPUP_GONE_BEFORE_CLICK")
    _popup_click(backend, cands[0], snap, popup)
    _, ok2, ms2 = c.wait_until(backend, lambda s: c.chat_identity_ok(s, name), 3.0,
                               allow_search_popup=True)
    cleared = clear_search(backend)
    after = dismiss_search_popup(backend)
    if not ok2:
        raise UIBlocked("OPEN_CONVERSATION_UNVERIFIED")
    return {"opened": name, "method": method, "results_ms": ms, "verify_ms": ms2,
            "search_cleared": cleared, "pre_dismiss": dismissed, "post_dismiss": after,
            "ms": round((time.monotonic() - t0) * 1000)}
