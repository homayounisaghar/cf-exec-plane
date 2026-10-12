"""Concrete AT-SPI backend for the live official Linux WeChat client.

Transport: UI / AT-SPI accessibility. NEVER a native WeChat messaging API.
Research code. Owner-authored (2026-10-11) to unblock Gate D; it is NOT
live-qualified until `python3 atspi_backend.py --selftest` and
test_atspi_live.py have been run against the real client with captured output.

Runtime context (required): run as the same Unix user as the official WeChat
client, with WeChat's own DISPLAY and DBUS_SESSION_BUS_ADDRESS (the context of
capability-fabric-pcg-wechat-semantic.service). Use with_wechat_env.sh.

Design:
  * AT-SPI interfaces first (Action, Component, Text, EditableText). Synthetic
    keyboard events only as documented last resort.
  * snapshot(): SCREEN-coordinate rects, display scale, cheap stable revision
    hash over (role, name, states, rect); event_epoch increments on any
    accepted WeChat AT-SPI event so the resolver cache busts.
  * wait_change(): blocks on AT-SPI events through a bounded GLib loop. No sleep.
  * Node names can contain chat text IN MEMORY only. This module never writes
    names to disk or logs; --selftest prints counts/roles/booleans only.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from hashlib import sha1
from typing import Optional

from engine import Node, Rect, Snapshot, UIBlocked

try:
    import gi  # type: ignore
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib  # type: ignore
    _HAVE_ATSPI = True
except Exception:  # import-safe for offline logic tests
    _HAVE_ATSPI = False

MAX_DEPTH = 40
MAX_NODES = 8000
_EVENTS = ("object:state-changed", "object:children-changed",
           "object:text-changed", "object:property-change:accessible-name",
           "object:bounds-changed", "window:activate", "focus:")
_ACTION_NAMES = ("click", "press", "activate", "push", "jump", "default")
_KEY_RETURN = 0xFF0D
_KEY_DELETE = 0xFFFF
_KEY_CTRL_L = 0xFFE3
_KEY_A = 0x0061

_STATE_NAMES = {
    "VISIBLE": "visible", "SHOWING": "showing", "ENABLED": "enabled",
    "SENSITIVE": "sensitive", "SELECTED": "selected", "EDITABLE": "editable",
    "MULTI_LINE": "multi-line", "FOCUSED": "focused", "FOCUSABLE": "focusable",
    "CHECKED": "checked", "EXPANDED": "expanded",
}


def _revision(entries: list[tuple]) -> str:
    h = sha1()
    for role, name, states, rect in entries:
        h.update(f"{role}|{name}|{sorted(states)}|{rect}".encode("utf-8", "replace"))
    return h.hexdigest()[:16]


def _action_name(act, i) -> str:
    """Use the supported localized AT-SPI action API, never deprecated fallback.

    If the provider has no recognized action, activation must fail closed.
    """
    fn = getattr(act, "get_localized_name", None)
    if fn is None:
        return ""
    try:
        return (fn(i) or "").casefold()
    except Exception:
        return ""


def _display_scale() -> float:
    for var in ("QT_SCALE_FACTOR", "GDK_SCALE"):
        try:
            v = float(os.environ.get(var, ""))
            if v > 0:
                return v
        except ValueError:
            pass
    return 1.0


def _screen_dpi() -> Optional[float]:
    """Read X11 DPI without modifying the running client or its display."""
    try:
        p = subprocess.run(("xdpyinfo",), capture_output=True, text=True,
                           timeout=1.5, check=False)
        m = re.search(r"resolution:\s*(\d+)x(\d+)\s+dots per inch",
                      p.stdout if p.returncode == 0 else "")
        if m:
            dpi = (float(m.group(1)) + float(m.group(2))) / 2.0
            return dpi if 25.0 < dpi < 800.0 else None
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


class AtspiBackend:
    """Implements engine.Backend against the live client."""

    def __init__(self, app_name_candidates=("wechat", "\u5fae\u4fe1")):
        if not _HAVE_ATSPI:
            raise UIBlocked("ATSPI_UNAVAILABLE")
        self.app_name_candidates = tuple(c.casefold() for c in app_name_candidates)
        self._epoch = 0
        self._events = 0
        Atspi.init()
        self._app = self._locate_app()
        if self._app is None:
            raise UIBlocked("WECHAT_APP_NOT_FOUND")
        try:
            self._pid = self._app.get_process_id()
        except Exception:
            self._pid = None
        self._scale = _display_scale()
        self._initial_dpi = _screen_dpi()
        self._last_revision: Optional[str] = None
        self._listener = Atspi.EventListener.new(self._on_event)
        for ev in _EVENTS:
            try:
                self._listener.register(ev)
            except Exception:
                pass

    # ---- helpers -----------------------------------------------------------
    def _locate_app(self):
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            nm = (app.get_name() or "").casefold()
            if nm in self.app_name_candidates or "wechat" in nm:
                return app
        return None

    def _on_event(self, event) -> None:
        try:
            src = event.source
            if self._pid is not None and src is not None and src.get_process_id() != self._pid:
                return
        except Exception:
            pass
        self._events += 1

    def _drain(self) -> None:
        ctx = GLib.MainContext.default()
        while ctx.pending():
            ctx.iteration(False)

    @staticmethod
    def _states(acc) -> frozenset:
        out = set()
        try:
            ss = acc.get_state_set()
            for k, tok in _STATE_NAMES.items():
                st = getattr(Atspi.StateType, k, None)
                if st is not None and ss.contains(st):
                    out.add(tok)
        except Exception:
            pass
        return frozenset(out)

    @staticmethod
    def _rect(acc) -> Optional[Rect]:
        try:
            comp = acc.get_component_iface()
            if comp is None:
                return None
            r = comp.get_extents(Atspi.CoordType.SCREEN)
            return Rect(int(r.x), int(r.y), int(r.width), int(r.height))
        except Exception:
            return None

    @staticmethod
    def _actions(acc) -> tuple:
        try:
            act = acc.get_action_iface()
            if act is None:
                return ()
            return tuple(_action_name(act, i) for i in range(act.get_n_actions()))
        except Exception:
            return ()

    def _to_node(self, acc, path: tuple, with_actions: bool = True) -> Node:
        try:
            role = acc.get_role_name() or ""
        except Exception:
            role = ""
        try:
            name = acc.get_name() or ""
        except Exception:
            name = ""
        actions = self._actions(acc) if with_actions else ()
        return Node(tuple(path), role, name, self._states(acc), self._rect(acc), actions)

    # ---- Backend contract --------------------------------------------------
    def snapshot(self) -> Snapshot:
        self._drain()
        if self._events:
            self._epoch += self._events
            self._events = 0
        nodes: list[Node] = []
        stack = [(self._app.get_child_at_index(i), (i,))
                 for i in range(self._app.get_child_count() - 1, -1, -1)]
        while stack and len(nodes) < MAX_NODES:
            acc, path = stack.pop()
            if acc is None:
                continue
            node = self._to_node(acc, path, with_actions=False)
            nodes.append(node)
            if len(path) >= MAX_DEPTH or "showing" not in node.states:
                continue  # hidden subtrees cannot be targets (visible() needs showing)
            try:
                n = acc.get_child_count()
            except Exception:
                n = 0
            for i in range(n - 1, -1, -1):
                try:
                    stack.append((acc.get_child_at_index(i), path + (i,)))
                except Exception:
                    continue
        if len(nodes) >= MAX_NODES:
            raise UIBlocked("ATSPI_TREE_TOO_LARGE")
        frames = [n for n in nodes if n.role in ("frame", "window") and n.visible() and n.rect]
        main = max(frames, key=lambda n: n.rect.w * n.rect.h, default=None)
        if main is None:
            raise UIBlocked("WECHAT_WINDOW_NOT_VISIBLE")
        self._drain()
        self._events = 0  # baseline: only changes AFTER this snapshot wake wait_change
        entries = [(n.role, n.name, n.states, n.rect) for n in nodes]
        revision = _revision(entries)
        self._last_revision = revision
        now_dpi = _screen_dpi()
        dpi_ratio = (now_dpi / self._initial_dpi
                     if now_dpi is not None and self._initial_dpi else 1.0)
        return Snapshot(revision=revision, width=main.rect.w, height=main.rect.h,
                        nodes=tuple(nodes), event_epoch=self._epoch,
                        scale=round(_display_scale() * dpi_ratio, 5))

    def _find(self, node: Node):
        """Fail closed when index paths have shifted to a different control."""
        acc = self._app
        for idx in node.path:
            try:
                acc = acc.get_child_at_index(idx)
            except Exception:
                acc = None
            if acc is None:
                raise UIBlocked("STALE_NODE")
        current = self._to_node(acc, node.path, with_actions=False)
        if current.role != node.role or current.rect != node.rect:
            raise UIBlocked("STALE_NODE")
        # The live Qt composer may report its *current text* as its name.
        # Only that editable text role is exempted from name stability.
        volatile_composer_name = (node.role == "text" and "editable" in node.states
                                  and node.name not in ("Search", "搜索"))
        if not volatile_composer_name and current.name != node.name:
            raise UIBlocked("STALE_NODE")
        for state in ("selected", "visible", "showing", "enabled", "sensitive", "editable"):
            if (state in node.states) != (state in current.states):
                raise UIBlocked("STALE_NODE")
        return acc

    def _key(self, keysym: int, kind) -> bool:
        try:
            return bool(Atspi.generate_keyboard_event(keysym, None, kind))
        except Exception:
            return False

    def activate(self, target: Node) -> bool:
        acc = self._find(target)
        try:
            act = acc.get_action_iface()
            if act is not None:
                names = [_action_name(act, i) for i in range(act.get_n_actions())]
                for wanted in _ACTION_NAMES:
                    if wanted in names:
                        return bool(act.do_action(names.index(wanted)))
                # Unknown actions must not be invoked by index guessing.
        except Exception:
            pass
        # Return fallback only for a visible, enabled, named control.
        if (target.role not in ("button", "push button", "list item",
                                "list-item", "menu item", "check box")
                or not target.name or not target.visible() or not target.enabled()):
            return False
        if not self.focus(target):
            return False
        return self._key(_KEY_RETURN, Atspi.KeySynthType.SYM)

    def focus(self, target: Node) -> bool:
        acc = self._find(target)
        try:
            comp = acc.get_component_iface()
            return bool(comp and comp.grab_focus())
        except Exception:
            return False

    def editable_text(self, target: Node) -> Optional[str]:
        acc = self._find(target)
        try:
            txt = acc.get_text_iface()
            if txt is None:
                return None
            n = txt.get_character_count()
            return txt.get_text(0, n) if n > 0 else ""
        except Exception:
            return None

    def replace_text(self, target: Node, value: str) -> bool:
        """One AT-SPI text edit attempt, with exact semantic readback.

        CRITICAL R2 defect: Qt's set_text_contents() may mutate the composer
        but its return value or subsequent get_text_iface() is unavailable.
        Falling through to synthetic typing after such an ambiguous mutation
        duplicated a real unsent draft. Never perform a second input transport
        after attempting EditableText; return False and let the caller
        reconcile/clear the draft with a separately qualified, scoped action.
        """
        if (not isinstance(value, str) or len(value) > 20000
                or target.role.casefold() != "text"
                or "editable" not in target.states):
            raise UIBlocked("TEXT_TARGET_OR_LENGTH_INVALID")
        acc = self._find(target)
        try:
            editor = acc.get_editable_text_iface()
        except Exception:
            return False
        if editor is None:
            # No synthetic keyboard fallback with unverifiable text state.
            return False
        try:
            accepted = bool(editor.set_text_contents(value))
        except Exception:
            return False  # the call MAY have mutated; never retry blindly
        if not accepted:
            return False
        try:
            return self.editable_text(target) == value
        except Exception:
            return False

    def _path_of(self, acc) -> Optional[tuple]:
        path = []
        cur = acc
        for _ in range(MAX_DEPTH + 2):
            try:
                parent = cur.get_parent()
            except Exception:
                return None
            if parent is None:
                return None
            idx = cur.get_index_in_parent()
            if idx < 0:
                return None
            path.append(idx)
            if parent == self._app or (parent.get_role_name() == "application"
                                        and parent.get_process_id() == self._pid):
                return tuple(reversed(path))
            cur = parent
        return None

    def hit_test(self, x: int, y: int) -> Optional[Node]:
        """AT-SPI hit (get_accessible_at_point), refined to the deepest visible
        descendant whose fresh SCREEN rect contains the point. Qt often reports
        a container/filler at the point instead of the leaf control."""
        x, y = int(x), int(y)
        hit = None
        for i in range(self._app.get_child_count()):
            top = self._app.get_child_at_index(i)
            if top is None:
                continue
            r = self._rect(top)
            if r is None or not r.contains(x, y):
                continue
            cur = top
            for _ in range(MAX_DEPTH):
                try:
                    comp = cur.get_component_iface()
                    nxt = comp.get_accessible_at_point(x, y, Atspi.CoordType.SCREEN) if comp else None
                except Exception:
                    nxt = None
                if nxt is None or nxt == cur:
                    break
                cur = nxt
            hit = cur
            break
        if hit is None:
            return None
        path = self._path_of(hit) if hit is not None else None
        if path is None:
            return None
        snap = self.snapshot()
        # Qt commonly gives an unnamed filler *inside* the actual editor.
        # Reconcile against visible semantic ancestors AND descendants of the
        # fresh AT-SPI point hit; never accept an unrelated overlapping sibling.
        ranked = []
        for n in snap.nodes:
            if not (n.visible() and n.rect and n.rect.contains(x, y)):
                continue
            same_chain = (n.path[:len(path)] == path or path[:len(n.path)] == n.path)
            if not same_chain:
                continue
            role = n.role.casefold()
            if role == "text" and "editable" in n.states:
                rank = 5
            elif role in ("button", "push button", "list item", "list-item",
                          "menu item", "check box") and n.name:
                rank = 4
            elif role == "list" and n.name:
                rank = 3
            elif role in ("text", "label") and n.name:
                rank = 2
            else:
                continue
            ranked.append((rank, len(n.path), n))
        if not ranked:
            return None
        ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
        if len(ranked) > 1 and ranked[0][:2] == ranked[1][:2]:
            return None
        best = ranked[0][2]
        return self._to_node(self._find(best), best.path)

    def wait_change(self, timeout_seconds: float) -> bool:
        """Event-driven wait; return only for a real changed accessibility tree.

        A queued event from a previous scan is not evidence that a UI change
        occurred.  Compare against the last captured semantic revision.
        """
        if timeout_seconds <= 0:
            return False
        reference = self._last_revision
        if reference is None:
            reference = self.snapshot().revision
        ctx = GLib.MainContext.default()
        fired = {"t": False}
        deadline = time.monotonic() + timeout_seconds

        def _timeout():
            fired["t"] = True
            return False

        tid = GLib.timeout_add(max(1, int(timeout_seconds * 1000)), _timeout)
        try:
            while not fired["t"] and time.monotonic() < deadline:
                self._drain()
                if self._events:
                    self._epoch += self._events
                    self._events = 0
                    if self.snapshot().revision != reference:
                        return True
                # True means block on the AT-SPI main context, not sleep().
                if not fired["t"] and time.monotonic() < deadline:
                    ctx.iteration(True)
            return False
        finally:
            if not fired["t"]:
                GLib.source_remove(tid)

    def visible_sent_message(self, exact_text: str) -> bool:
        """Same-client UI evidence only -> ACKNOWLEDGED, never PROVIDER_CONFIRMED.

        True only if the bottom-most visible item in the unique Messages list
        (or a text descendant of it) has exactly this text. Outgoing direction
        is not proven by AT-SPI on this build; callers must treat as ACK only.
        """
        snap = self.snapshot()
        lists = [n for n in snap.nodes if n.role == "list" and n.name.strip().casefold()
                 in ("messages", "\u6d88\u606f") and n.visible()]
        if len(lists) != 1:
            return False
        root = lists[0]
        items = [n for n in snap.nodes if len(n.path) == len(root.path) + 1
                 and n.path[:len(root.path)] == root.path and n.visible() and n.rect]
        if not items:
            return False
        last = max(items, key=lambda n: (n.rect.y + n.rect.h, n.path))
        # Do not confuse a same-client UI echo (or an incoming message) with
        # a sent outgoing bubble.  Direction needs explicit semantic metadata.
        # The current Qt build may not expose it: then return False/IN_DOUBT.
        try:
            acc = self._find(last)
            attributes = acc.get_attributes_as_array() or ()
            tokens = {str(a).casefold().replace(" ", "") for a in attributes}
            outgoing = any(t in tokens for t in (
                "direction:outgoing", "direction:outbound",
                "message-direction:outgoing", "outgoing:true"))
        except Exception:
            return False
        if not outgoing:
            return False
        want = " ".join(exact_text.split())
        return any(n.path[:len(last.path)] == last.path
                   and n.role in ("text", "label")
                   and " ".join(n.name.split()) == want
                   for n in snap.nodes)


# ---- read-only self test (prints no names / no chat text) -------------------
def _selftest() -> int:
    from engine import Resolver, TARGETS
    t0 = time.monotonic()
    b = AtspiBackend()
    snap = b.snapshot()
    t1 = time.monotonic()
    print(f"SNAPSHOT_OK nodes={len(snap.nodes)} frame={snap.width}x{snap.height} "
          f"scale={snap.scale} epoch={snap.event_epoch} ms={int((t1-t0)*1000)}")
    r = Resolver(b)
    ok = 0
    for key in TARGETS:
        try:
            n = r.resolve(key)
            print(f"RESOLVE {key}: OK role={n.role} depth={len(n.path)} enabled={n.enabled()}")
            ok += 1
        except UIBlocked as e:
            print(f"RESOLVE {key}: {e.code}")
    try:
        comp = r.resolve("message_input")
        txt = b.editable_text(comp)
        print(f"COMPOSER_READ: {'EMPTY' if txt == '' else ('UNREADABLE' if txt is None else 'NONEMPTY_DRAFT')}")
        if comp.rect:
            cx, cy = comp.rect.x + comp.rect.w // 2, comp.rect.y + comp.rect.h // 2
            hit = b.hit_test(cx, cy)
            print(f"HIT_TEST composer: {'MATCH' if hit and hit.path == comp.path else ('OTHER role=' + hit.role if hit else 'NONE')}")
    except UIBlocked as e:
        print(f"COMPOSER: {e.code}")
    t2 = time.monotonic()
    changed = b.wait_change(1.0)
    print(f"WAIT_CHANGE 1.0s: event={changed} ms={int((time.monotonic()-t2)*1000)}")
    print(f"SELFTEST_DONE resolved={ok}/{len(TARGETS)} (send_button TARGET_NOT_FOUND is expected while composer is empty: it is disabled)")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print("usage: python3 atspi_backend.py --selftest")
