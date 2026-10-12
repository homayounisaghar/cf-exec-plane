"""Test doubles for engine.py. Lets engine LOGIC be proven without a live client.

FakeBackend simulates an AT-SPI backend over an in-memory Snapshot. build_tree()
produces a WeChat-like tree (frame -> chat list + selected row, composer toolbar
with message_input + send_button). Use mutate helpers to simulate resize, DPI
change, text entry, and node removal (to exercise the anchor fallback).
"""
from __future__ import annotations

from typing import Optional
from engine import Node, Rect, Snapshot


def build_tree(width=1200, height=800, scale=1.0, revision="r1", epoch=1,
               composer_text="", selected="FixtureRecipient", drop_message_input=False):
    S = frozenset
    base = S({"visible", "showing", "enabled", "sensitive"})
    nodes = [
        Node((0,), "frame", "WeChat", base, Rect(0, 0, width, height)),
        Node((0, 0), "list", "Chats", base, Rect(0, 60, 300, height-60)),
        Node((0, 0, 0), "list item", "FixtureRecipient",
             base | ({"selected"} if selected == "FixtureRecipient" else frozenset()), Rect(0, 60, 300, 60)),
        Node((0, 0, 1), "list item", "FixtureAlternate",
             base | ({"selected"} if selected == "FixtureAlternate" else frozenset()), Rect(0, 120, 300, 60)),
        Node((0, 1), "tool bar", "Composer", base, Rect(310, 680, width-310, 120)),
    ]
    if not drop_message_input:
        nodes.append(
            Node((0, 1, 0), "text", "",
                 base | S({"editable", "multi-line"}), Rect(320, 690, width-420, 80))
        )
    # send button enabled only when composer has text (WeChat-like)
    send_states = base if composer_text else S({"visible", "showing"})
    nodes.append(Node((0, 1, 1), "button", "Send", send_states, Rect(width-90, 740, 70, 40)))
    return Snapshot(revision=revision, width=width, height=height,
                    nodes=tuple(nodes), event_epoch=epoch, scale=scale)


class FakeBackend:
    def __init__(self, snap: Snapshot):
        self._snap = snap
        self.text = ""
        self.sent = None
        self.changes = 0

    def set_snapshot(self, snap: Snapshot):
        self._snap = snap
        self.changes += 1

    def snapshot(self) -> Snapshot:
        # reflect current composer text + send-button enablement
        return self._rebuild()

    def _rebuild(self) -> Snapshot:
        s = self._snap
        new_nodes = []
        for n in s.nodes:
            if n.path == (0, 1, 0):  # message_input reflects typed text
                states = n.states
                new_nodes.append(Node(n.path, n.role, self.text, states, n.rect, n.actions))
            elif n.path == (0, 1, 1):  # send button enablement tracks text
                base = frozenset({"visible", "showing"})
                states = base | (frozenset({"enabled", "sensitive"}) if self.text else frozenset())
                new_nodes.append(Node(n.path, n.role, n.name, states, n.rect, n.actions))
            else:
                new_nodes.append(n)
        return Snapshot(s.revision, s.width, s.height, tuple(new_nodes), s.event_epoch, s.scale)

    def activate(self, target: Node) -> bool:
        if target.path == (0, 1, 1):
            self.sent = self.text
        return True

    def focus(self, target: Node) -> bool:
        return True

    def editable_text(self, target: Node) -> Optional[str]:
        if target.path == (0, 1, 0):
            return self.text
        return None

    def replace_text(self, target: Node, value: str) -> bool:
        if target.path == (0, 1, 0):
            self.text = value
            self.changes += 1
            return True
        return False

    def hit_test(self, x: int, y: int) -> Optional[Node]:
        snap = self._rebuild()
        hit = None
        for n in snap.nodes:
            if n.rect and n.rect.contains(x, y):
                if hit is None or len(n.path) > len(hit.path):
                    hit = n  # deepest containing node
        return hit

    def wait_change(self, timeout_seconds: float) -> bool:
        return True

    def visible_sent_message(self, exact_text: str) -> bool:
        return self.sent == exact_text
