"""Shared generic helpers for WeChat engine v10 (any chat, not only Moe).

Reuses the proven primitives: AtspiBackend, x11 guard, flock lock,
hover-verified pointer, receive_readonly fail-closed chat identity.
Rules: NEVER any keyboard key to the main window. Mouse wheel and
AT-SPI EditableText are the only non-click inputs to the main window.
"""
from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Optional

from engine import Node, Snapshot, UIBlocked, TARGETS
import receive_readonly as rr

MARKER_DIR = Path.home() / ".local/state/wechat-send-v10"
SEND_LABELS = {"send", "send(s)", "\u53d1\u9001"}
SEARCH_LABELS = {"search", "\u641c\u7d22"}


def norm(s) -> str:
    return " ".join(str(s or "").casefold().split())


def is_child(n: Node, a: Node) -> bool:
    return len(n.path) > len(a.path) and n.path[:len(a.path)] == a.path


# ---------------------------------------------------------------- identity
def chat_identity_ok(snap: Snapshot, name: str) -> bool:
    try:
        if rr._selected_chat_name(snap) != name:
            return False
        return rr._header_matches(snap, rr._unique_list(snap, rr.MESSAGES_NAMES), name)
    except UIBlocked:
        return False


def require_chat(snap: Snapshot, name: str) -> None:
    if not chat_identity_ok(snap, name):
        raise UIBlocked("CHAT_IDENTITY_NOT_EXACT")


def chat_rows(snap: Snapshot) -> list[Node]:
    return rr._rows(snap, rr._unique_list(snap, rr.CHATS_NAMES))


def message_rows(snap: Snapshot) -> list[Node]:
    return rr._rows(snap, rr._unique_list(snap, rr.MESSAGES_NAMES))


def row_by_name(snap: Snapshot, name: str) -> Optional[Node]:
    """Unique visible chat row whose FIRST line == name; None if absent."""
    hits = [r for r in chat_rows(snap) if r.name.split("\n", 1)[0] == name]
    if len(hits) > 1:
        raise UIBlocked("CHAT_ROW_NAME_NOT_UNIQUE")
    return hits[0] if hits else None


def search_field(snap: Snapshot) -> Node:
    hits = [n for n in snap.nodes if n.role == "text" and "editable" in n.states
            and n.visible() and norm(n.name) in SEARCH_LABELS]
    if len(hits) != 1:
        raise UIBlocked("SEARCH_FIELD_NOT_UNIQUE")
    return hits[0]


def composer(snap: Snapshot) -> Node:
    eds = [n for n in snap.nodes if n.role == "text" and "editable" in n.states
           and n.visible() and norm(n.name) not in SEARCH_LABELS]
    if len(eds) != 1:
        raise UIBlocked("COMPOSER_NOT_UNIQUE")
    return eds[0]


def send_button(snap: Snapshot, *, require_enabled: bool) -> Node:
    btns = [n for n in snap.nodes if n.role in ("button", "push button")
            and n.visible() and norm(n.name) in SEND_LABELS]
    bars = [n for n in snap.nodes if n.role in ("tool bar", "toolbar") and n.visible()
            and any(is_child(b, n) for b in btns)]
    inside = [b for b in btns if len(bars) == 1 and is_child(b, bars[0])]
    if len(inside) != 1 or inside[0].rect is None:
        raise UIBlocked("SEND_BUTTON_NOT_UNIQUE")
    if require_enabled and not inside[0].enabled():
        raise UIBlocked("SEND_BUTTON_DISABLED")
    return inside[0]


def toolbar_button(snap: Snapshot, labels: set) -> Node:
    hits = [n for n in snap.nodes if n.role in ("button", "push button") and n.visible()
            and n.enabled() and norm(n.name).split("(")[0].strip() in labels]
    if len(hits) != 1:
        raise UIBlocked("TOOLBAR_BUTTON_NOT_UNIQUE")
    return hits[0]


def read_text(backend, node: Node) -> str:
    acc = backend._find(node)
    txt = acc.get_text_iface()
    if txt is None:
        raise UIBlocked("TEXT_INTERFACE_MISSING")
    n = txt.get_character_count()
    if n < 0 or n > 5000:
        raise UIBlocked("TEXT_LENGTH_INVALID")
    if n == 0:
        return ""
    from atspi_backend import Atspi
    v = Atspi.Text.get_text(txt, 0, n)
    if not isinstance(v, str):
        raise UIBlocked("TEXT_NOT_STRING")
    return v


def set_text_once(backend, node: Node, value: str) -> None:
    """ONE EditableText mutation (no keyboard). Caller must read back."""
    from wechat_live_lock import require_wechat_lock
    require_wechat_lock()
    edit = backend._find(node).get_editable_text_iface()
    if edit is None:
        raise UIBlocked("EDITABLE_TEXT_NOT_AVAILABLE")
    try:
        edit.set_text_contents(value)
    except Exception:
        pass


# ---------------------------------------------------------------- waiting
def wait_until(backend, pred, timeout: float = 2.0, poll: float = 0.1):
    """Re-snapshot until pred(snap) is truthy. Gives back (snap, ok, ms)."""
    from x11_modal_guard import assert_no_wechat_modal
    t0 = time.monotonic()
    while True:
        assert_no_wechat_modal()
        snap = backend.snapshot()
        try:
            ok = bool(pred(snap))
        except UIBlocked:
            ok = False
        ms = round((time.monotonic() - t0) * 1000)
        if ok or time.monotonic() - t0 >= timeout:
            return snap, ok, ms
        backend.wait_change(poll)


# ---------------------------------------------------------------- pointer
def click_node(backend, node: Node, snap: Snapshot, *, allow_descendant=False, label="V10_CLICK"):
    from pointer_mapping import hover_target, click_once
    plan = hover_target(backend, node, snap=snap, allow_descendant=allow_descendant, label=label)
    click_once(plan)
    return plan


def wheel(backend, container: Node, snap: Snapshot, direction: str, steps: int = 1) -> None:
    """Mouse wheel over a verified point inside container. No keys.

    direction: "down" (button 5) or "up" (button 4). Guard before and after.
    """
    from pointer_mapping import hover_target
    from wechat_live_lock import require_wechat_lock
    from x11_modal_guard import assert_no_wechat_modal
    if direction not in ("up", "down") or not (1 <= steps <= 10):
        raise UIBlocked("WHEEL_ARGS")
    rows = [r for r in rr._rows(snap, container) if r.rect and r.rect.h > 0]
    target = rows[len(rows) // 2] if rows else container
    plan = hover_target(backend, target, snap=snap, allow_descendant=True, label="V10_WHEEL_HOVER")
    require_wechat_lock()
    assert_no_wechat_modal()
    btn = "5" if direction == "down" else "4"
    p = subprocess.run(("xdotool", "click", "--repeat", str(steps), "--delay", "40", btn),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
    assert_no_wechat_modal()
    if p.returncode != 0:
        raise UIBlocked("WHEEL_FAILED")
    _ = plan


# ---------------------------------------------------------------- markers
def send_key(recipient: str, payload: str) -> str:
    return hashlib.sha256(("v10\0" + recipient + "\0" + payload).encode("utf8")).hexdigest()


def claim_send(recipient: str, payload: str, *, root: Path = MARKER_DIR) -> str:
    """Durable O_EXCL marker BEFORE the one Send click. Never removed."""
    from wechat_live_lock import require_wechat_lock
    require_wechat_lock()
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = root.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise UIBlocked("SEND_MARKER_DIRECTORY_UNSAFE")
    key = send_key(recipient, payload)
    path = root / (key + ".attempt")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        raise UIBlocked("SEND_ALREADY_ATTEMPTED_NO_RETRY")
    with os.fdopen(fd, "wb") as f:
        f.write(b"ATTEMPTED_NO_RETRY\n")
        f.flush()
        os.fsync(f.fileno())
    dfd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    return key


def already_attempted(recipient: str, payload: str, *, root: Path = MARKER_DIR) -> bool:
    return (Path(root) / (send_key(recipient, payload) + ".attempt")).exists()


# ---------------------------------------------------------------- tails
def body_tail(snap: Snapshot, k: int = 5) -> tuple:
    """Last k NON-separator, non-empty message bodies (separators can be inserted)."""
    names = [r.name for r in message_rows(snap)
             if (r.name or "").strip() and not rr.is_separator(r.name)]
    return tuple(names[-k:])


def tail_shift_ok(before: tuple, after: tuple, body: str, k: int = 5) -> bool:
    """after must be before shifted by exactly one new body (k-window)."""
    if not after or after[-1] != body:
        return False
    if len(before) < k:
        return after == before + (body,)
    return after == before[1:] + (body,)
