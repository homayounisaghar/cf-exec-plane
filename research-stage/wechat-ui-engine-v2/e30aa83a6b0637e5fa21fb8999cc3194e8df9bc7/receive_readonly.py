"""Read-only WeChat receive API (receive_v1).

list_chats(snapshot)      -> visible chat-list rows: name, preview, time, muted
read_open_chat(snapshot,n,expect_chat) -> last n visible bodies, ONLY if the
                            selected chat AND header are exactly expect_chat

STRICTLY READ-ONLY: no clicks, no keys, no focus, no scrolling, no chat
switching. Only AT-SPI reads plus the existing no-extra-window guard.

Known limits (fixtures/receive_v1/NOTES.md):
- Only rows currently rendered by Qt are visible (virtualized lists).
- Sender, direction and per-message time are NOT exposed -> "unknown".
- Unread counts are NOT exposed -> None. A leading "[N]" in a group preview
  is returned raw as preview_bracket_number (unconfirmed meaning).
- Time-only rows ("08:24", "Yesterday 03:11", "Friday", dates) are
  separators, never messages.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Optional

from engine import Node, Snapshot, UIBlocked

CHATS_NAMES = ("Chats", "\u804a\u5929", "\u4f1a\u8bdd")
MESSAGES_NAMES = ("Messages", "\u6d88\u606f")
VISIBLE_ONLY_NOTE = ("visible rows only: the list is virtualized; older or "
                     "off-screen items are not included")

_DAYS = ("monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
         "today|yesterday|"
         "\u661f\u671f[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]|"
         "\u5468[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]|"
         "\u4eca\u5929|\u6628\u5929")
_TIME = r"\d{1,2}:\d{2}(?:\s?[ap]m)?"
_DATE = (r"\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|"
         r"\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5|\d{1,2}\u6708\d{1,2}\u65e5")
_SEPARATOR_RE = re.compile(
    rf"^(?:(?:{_DAYS}|{_DATE})(?:\s+{_TIME})?|{_TIME})$", re.IGNORECASE)
_BRACKET_RE = re.compile(r"^\[(\d+)\]\s*(.*)$", re.DOTALL)
_QUOTE_RE = re.compile(r"^Quote (.+?)'s message:\s?(.*)$", re.DOTALL)
_MUTE_MARKERS = ("Mute Notifications", "\u6d88\u606f\u514d\u6253\u6270")


def is_separator(text: str) -> bool:
    t = (text or "").strip()
    return bool(t) and "\n" not in t and bool(_SEPARATOR_RE.match(t))


def _unique_list(snap: Snapshot, names: tuple) -> Node:
    folded = {n.casefold() for n in names}
    hits = [n for n in snap.nodes
            if n.role == "list" and (n.name or "").casefold() in folded
            and n.visible()]
    if len(hits) != 1:
        raise UIBlocked(f"LIST_NOT_UNIQUE:{names[0]}:{len(hits)}")
    return hits[0]


def _rows(snap: Snapshot, lst: Node) -> list[Node]:
    depth = len(lst.path) + 1
    rows = [n for n in snap.nodes
            if len(n.path) == depth and n.path[:-1] == lst.path
            and n.role == "list item" and n.visible()]
    rows.sort(key=lambda n: (n.rect.y if n.rect else 0, n.path))
    return rows


def parse_chat_row(raw: str) -> dict:
    """name = first line; time = LAST line that looks like a time/day/date;
    preview = everything between (previews can span several lines)."""
    lines = (raw or "").split("\n")
    muted = any(ln.strip() in _MUTE_MARKERS for ln in lines)
    core = [ln for ln in lines if ln.strip() not in _MUTE_MARKERS]
    while core and not core[-1].strip():
        core.pop()
    name = core[0] if core else ""
    rest = core[1:]
    time = None
    if rest and is_separator(rest[-1]):
        time = rest[-1].strip()
        rest = rest[:-1]
    preview = "\n".join(rest).strip("\n")
    bracket = None
    m = _BRACKET_RE.match(preview)
    if m:
        bracket = int(m.group(1))
    return {"name": name, "preview": preview, "time": time, "muted": muted,
            "unread": None, "preview_bracket_number": bracket, "raw": raw}


def visible_fraction(row: Node, container: Node) -> Optional[float]:
    """Share of the row's height inside the list viewport (None = unknown)."""
    r, c = row.rect, container.rect
    if r is None or c is None or r.h <= 0:
        return None
    top, bot = max(r.y, c.y), min(r.y + r.h, c.y + c.h)
    return round(max(0, bot - top) / r.h, 3)


def parse_message_row(raw: str) -> dict:
    body, quote = raw or "", None
    if "\n" in body:
        first, rest = body.split("\n", 1)
        m = _QUOTE_RE.match(rest)
        if m:
            body, quote = first, {"sender": m.group(1), "text": m.group(2)}
    return {"body": body, "quote": quote, "sender": "unknown",
            "direction": "unknown", "time": None, "raw": raw}


def list_chats(snap: Snapshot) -> dict:
    lst = _unique_list(snap, CHATS_NAMES)
    out = []
    for r in _rows(snap, lst):
        item = parse_chat_row(r.name)
        item["selected"] = "selected" in r.states
        out.append(item)
    return {"chats": out, "visible_count": len(out), "note": VISIBLE_ONLY_NOTE}


def _selected_chat_name(snap: Snapshot) -> str:
    sel = [r for r in _rows(snap, _unique_list(snap, CHATS_NAMES))
           if "selected" in r.states]
    if len(sel) != 1:
        raise UIBlocked(f"NO_UNIQUE_SELECTED_CHAT:{len(sel)}")
    return parse_chat_row(sel[0].name)["name"]


def _header_matches(snap: Snapshot, msgs: Node, expect_chat: str) -> bool:
    """A visible label == expect_chat above the message list, inside its x-span."""
    if msgs.rect is None:
        return False
    m = msgs.rect
    for n in snap.nodes:
        if (n.role == "label" and n.visible() and n.rect is not None
                and (n.name or "").strip() == expect_chat
                and m.x <= n.rect.x < m.x + m.w
                and m.y - 120 <= n.rect.y < m.y):
            return True
    return False


def read_open_chat(snap: Snapshot, n: int, expect_chat: str) -> dict:
    """Read the open chat ONLY if it is exactly expect_chat (fail closed)."""
    if n < 1:
        raise ValueError("n must be >= 1")
    if not isinstance(expect_chat, str) or not expect_chat.strip():
        raise UIBlocked("EXPECT_CHAT_REQUIRED")
    expect_chat = expect_chat.strip()
    chat = _selected_chat_name(snap)
    if chat != expect_chat:
        raise UIBlocked("SELECTED_CHAT_MISMATCH")
    msgs_list = _unique_list(snap, MESSAGES_NAMES)
    if not _header_matches(snap, msgs_list, expect_chat):
        raise UIBlocked("CHAT_HEADER_MISMATCH")
    msgs, last_sep = [], None
    for r in _rows(snap, msgs_list):
        if is_separator(r.name):
            last_sep = r.name.strip()
            continue
        if not (r.name or "").strip():
            continue
        item = parse_message_row(r.name)
        item["after_separator"] = last_sep
        frac = visible_fraction(r, msgs_list)
        item["visible_fraction"] = frac
        item["partially_hidden"] = frac is not None and frac < 0.999
        msgs.append(item)
    hidden = sum(1 for m in msgs if m["partially_hidden"])
    return {"chat": chat, "messages": msgs[-n:], "visible_message_count": len(msgs),
            "partially_hidden_count": hidden,
            "returned": len(msgs[-n:]), "note": VISIBLE_ONLY_NOTE}


def snapshot_from_dump(dump: dict) -> Snapshot:
    """Build an engine Snapshot from a fixtures/receive_v1 dump.json."""
    from engine import Rect
    nodes = []
    for d in dump["nodes"]:
        e = d.get("extents_screen")
        rect = Rect(*e) if e and len(e) == 4 else None
        nodes.append(Node(tuple(d["path"]), d.get("role", ""), d.get("name", "") or "",
                          frozenset(d.get("states", [])), rect))
    root = nodes[0]
    w, h = (root.rect.w, root.rect.h) if root.rect else (0, 0)
    return Snapshot("fixture", w, h, tuple(nodes))


def live_read(n: int, expect_chat: str) -> dict:
    """Live, read-only: lock -> guard -> one fresh snapshot -> guard."""
    from atspi_backend import AtspiBackend
    from wechat_live_lock import WeChatLiveLock
    from x11_modal_guard import assert_no_wechat_modal
    with WeChatLiveLock():
        assert_no_wechat_modal()
        snap = AtspiBackend().snapshot()
        result = {"list_chats": list_chats(snap),
                  "read_open_chat": read_open_chat(snap, n, expect_chat)}
        assert_no_wechat_modal()
    return result


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or not argv[0].isdigit():
        print(json.dumps({"ok": False, "blocked": "USAGE: receive_readonly.py N EXPECT_CHAT"}))
        return 2
    n, expect_chat = int(argv[0]), argv[1]
    try:
        out = live_read(n, expect_chat)
    except UIBlocked as e:
        print(json.dumps({"ok": False, "blocked": e.code}))
        return 3
    print(json.dumps({"ok": True, **out}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
