"""Context-menu discovery (no item is ever chosen) + read-only new-message watcher."""
from __future__ import annotations

import os
import re
import subprocess
import time

from engine import UIBlocked
import receive_readonly as rr
import wx_common as c
import wx_send as ws


def _run(*a, timeout=5):
    return subprocess.run(a, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
                          check=False).stdout.decode("utf8", "replace")


def _wechat_windows():
    pid = _run("pgrep", "-u", str(os.getuid()), "-x", "wechat").split()
    if len(pid) != 1:
        raise UIBlocked("WECHAT_PID_NOT_UNIQUE")
    return pid[0], set(_run("xdotool", "search", "--onlyvisible", "--pid", pid[0]).split())


def _focus_is(wid: str) -> bool:
    f = _run("xdotool", "getwindowfocus").strip()
    target = int(wid)
    try:
        cur = int(f, 0)
    except ValueError:
        return False
    for _ in range(12):
        if cur == target:
            return True
        tree = _run("xwininfo", "-id", str(cur), "-tree")
        m = re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)", tree)
        if not m:
            return False
        nxt = int(m.group(1), 16)
        if nxt == cur:
            return False
        cur = nxt
    return False


def discover_context_menu(backend, name: str) -> dict:
    """Right-click the LAST message row of `name` once, read the menu items,
    close the menu with Escape ONLY after verified X focus on that new popup.
    Never selects an item. Stops (reports) if the popup cannot be proven."""
    from pointer_mapping import hover_target
    from wechat_live_lock import require_wechat_lock
    from x11_modal_guard import assert_no_wechat_modal
    snap = backend.snapshot()
    c.require_chat(snap, name)
    lst = rr._unique_list(snap, rr.MESSAGES_NAMES)
    rows = [r for r in rr._rows(snap, lst) if not rr.is_separator(r.name)
            and (rr.visible_fraction(r, lst) or 0) >= 0.999]
    if not rows:
        raise UIBlocked("NO_FULL_MESSAGE_ROW")
    row = rows[-1]
    plan = hover_target(backend, row, snap=snap, label="V10_MENU_HOVER")
    pid, before = _wechat_windows()
    require_wechat_lock()
    assert_no_wechat_modal()
    _run("xdotool", "click", "3")
    t0 = time.monotonic()
    new = set()
    while time.monotonic() - t0 < 2.0:
        _, now = _wechat_windows()
        new = now - before
        if new:
            break
        time.sleep(0.08)
    report = ws._extra_windows_report()
    if len(new) != 1:
        # Menu window not visible to xdotool (override-redirect) or no menu.
        # Close any menu with ONE click on the chat header label (harmless;
        # hit-test must prove the label is on top, else stop).
        closed_by = None
        try:
            s2 = backend.snapshot()
            lst2 = rr._unique_list(s2, rr.MESSAGES_NAMES)
            hdr = [n for n in s2.nodes if n.role == "label" and n.visible() and n.rect
                   and (n.name or "").strip() == name and lst2.rect
                   and lst2.rect.y - 120 <= n.rect.y < lst2.rect.y]
            hdr.sort(key=lambda n: len(n.path))
            if hdr:
                c.click_node(backend, hdr[-1], s2, label="V10_MENU_CLOSE_HEADER")
                closed_by = "header_click"
        except UIBlocked as e:
            closed_by = "FAILED:" + e.code
        return {"status": "MENU_NOT_PROVEN", "new_windows": len(new), "extra": report,
                "closed_by": closed_by, "after": ws._extra_windows_report()}
    wid = new.pop()
    _run("xdotool", "windowfocus", "--sync", wid)
    if not _focus_is(wid):
        return {"status": "MENU_OPEN_FOCUS_UNVERIFIED_LEFT_OPEN", "menu_window": hex(int(wid)),
                "extra": report}
    _run("xdotool", "key", "Escape")
    end = time.monotonic() + 2.0
    closed = False
    while time.monotonic() < end:
        _, now = _wechat_windows()
        if wid not in now:
            closed = True
            break
        time.sleep(0.08)
    if closed:
        assert_no_wechat_modal()
    return {"status": "MENU_READ_AND_CLOSED" if closed else "MENU_STILL_OPEN",
            "menu_window": hex(int(wid)), "open_ms": None, "extra": report}


def watch_chats(backend, seconds: int = 120, interval: float = 3.0) -> dict:
    """Read-only polling of the visible chat list; events on preview/time change."""
    from x11_modal_guard import assert_no_wechat_modal
    seconds = max(5, min(int(seconds), 900))
    events, polls = [], 0
    prev = None
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        assert_no_wechat_modal()
        snap = backend.snapshot()
        cur = {x["name"]: (x["preview"], x["time"]) for x in rr.list_chats(snap)["chats"]}
        polls += 1
        if prev is not None:
            for nm, v in cur.items():
                if nm not in prev:
                    events.append({"t": round(seconds - (end - time.monotonic()), 1), "chat": nm,
                                   "kind": "appeared", "preview": v[0], "time": v[1]})
                elif prev[nm] != v:
                    events.append({"t": round(seconds - (end - time.monotonic()), 1), "chat": nm,
                                   "kind": "changed", "preview": v[0], "time": v[1]})
        prev = cur
        time.sleep(interval)
    return {"events": events, "polls": polls, "seconds": seconds}
