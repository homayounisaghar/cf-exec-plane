"""Fail-closed semantic UI engine for official Linux WeChat.

Transport: UI / AT-SPI, NEVER a native WeChat messaging API.
Research prototype. Does not alter the running CF-server or start WeChat.
No live write is enabled by default; provider confirmation is intentionally absent.

Round-2 redesign (consultant):
  * Defect K fixed: Session.plan_send() returns a single composer Node.
  * Real anchors added: message_input, search_box, send_button, attachment_button
    are anchored so the anchor-offset and vision fallbacks are reachable (no
    longer dead code). Anchor *values* (learned ratios) still come from a real
    client via remember_offset(); the MECHANISM is now exercised and tested.
  * A documented Backend contract + a concrete AtspiBackend skeleton the
    executing chat must implement against the live client.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Callable, Optional, Protocol
import fcntl
import json
import os
import time


class UIBlocked(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    def contains(self, px: int, py: int) -> bool:
        return self.w > 0 and self.h > 0 and self.x <= px < self.x+self.w and self.y <= py < self.y+self.h

    def relative(self, px: int, py: int) -> tuple[float, float]:
        if self.w <= 0 or self.h <= 0:
            raise UIBlocked("INVALID_ANCHOR_GEOMETRY")
        return ((px-self.x)/self.w, (py-self.y)/self.h)

    def point(self, rx: float, ry: float) -> tuple[int, int]:
        if not (0 <= rx <= 1 and 0 <= ry <= 1):
            raise UIBlocked("INVALID_RELATIVE_POINT")
        return (round(self.x+self.w*rx), round(self.y+self.h*ry))


@dataclass(frozen=True)
class Node:
    path: tuple[int, ...]
    role: str
    name: str
    states: frozenset[str] = frozenset()
    rect: Optional[Rect] = None
    actions: tuple[str, ...] = ()

    def visible(self) -> bool:
        return "visible" in self.states and "showing" in self.states

    def enabled(self) -> bool:
        return "enabled" in self.states and "sensitive" in self.states


@dataclass(frozen=True)
class Snapshot:
    revision: str
    width: int
    height: int
    nodes: tuple[Node, ...]
    event_epoch: int = 0
    scale: float = 1.0  # DPI/scale factor; part of cache-busting identity

    def by_path(self, path: tuple[int, ...]) -> Optional[Node]:
        return next((n for n in self.nodes if n.path == path), None)


@dataclass(frozen=True)
class Spec:
    roles: tuple[str, ...]
    labels: tuple[str, ...] = ()
    states: tuple[str, ...] = ()
    exclude_labels: tuple[str, ...] = ()
    anchor: Optional[str] = None
    descendant_roles: tuple[str, ...] = ()
    descendant_labels: tuple[str, ...] = ()


# Anchors make the R1 fallback paths reachable. The composer-region controls
# are anchored to a composer_toolbar; nav/list controls are anchored to the
# main frame. The executing chat must confirm these parent relationships hold
# on the real a11y tree and may adjust them from the real dump.
TARGETS: dict[str, Spec] = {
    "main_frame": Spec(("frame", "window"), ("WeChat", "\u5fae\u4fe1")),
    "conversation_list": Spec(("list",), ("Chats", "\u804a\u5929", "\u4f1a\u8bdd"), anchor="main_frame"),
    "messages_container": Spec(("list",), ("Messages", "\u6d88\u606f"), anchor="main_frame"),
    "composer_toolbar": Spec(("tool bar", "toolbar"), anchor="main_frame",
                              descendant_roles=("button", "push button"),
                              descendant_labels=("Send", "Send(S)", "\u53d1\u9001")),
    "search_box": Spec(("text",), ("Search", "\u641c\u7d22"), ("editable",), anchor="main_frame"),
    "message_input": Spec(("text",), (), ("editable",), ("Search", "\u641c\u7d22"), anchor="main_frame"),
    "send_button": Spec(("button", "push button"), ("Send", "Send(S)", "\u53d1\u9001"), anchor="composer_toolbar"),
    "attachment_button": Spec(("button", "push button"), ("Send File", "\u53d1\u9001\u6587\u4ef6", "File"), anchor="composer_toolbar"),
    "nav_contacts": Spec(("button", "push button"), ("Contacts", "\u901a\u8baf\u5f55"), anchor="main_frame"),
    "nav_chats": Spec(("button", "push button"), ("WeChat", "\u5fae\u4fe1", "Chats", "\u804a\u5929"), anchor="main_frame"),
    "nav_moments": Spec(("button", "push button"), ("Moments", "\u6717\u53cb\u5708"), anchor="main_frame"),
    "nav_favorites": Spec(("button", "push button"), ("Favorites", "\u6536\u85cf"), anchor="main_frame"),
}


class Backend(Protocol):
    def snapshot(self) -> Snapshot: ...
    def activate(self, target: Node) -> bool: ...
    def focus(self, target: Node) -> bool: ...
    def editable_text(self, target: Node) -> Optional[str]: ...
    def replace_text(self, target: Node, value: str) -> bool: ...
    def hit_test(self, x: int, y: int) -> Optional[Node]: ...
    def wait_change(self, timeout_seconds: float) -> bool: ...
    def visible_sent_message(self, exact_text: str) -> bool: ...


class Vision(Protocol):
    def locate(self, target_id: str, anchor: Node, snapshot: Snapshot) -> Optional[tuple[float, float, float]]: ...
    # (relative x, relative y, confidence). Cannot authorize clicks without hit testing.


def _norm(value: str) -> str:
    return " ".join(value.casefold().split())


def _name_match(node: Node, spec: Spec) -> bool:
    if node.role.casefold() not in spec.roles:
        return False
    if not node.visible() or not node.enabled():
        return False
    name = _norm(node.name)
    if spec.labels and name not in {_norm(v) for v in spec.labels}:
        return False
    if any(name == _norm(v) for v in spec.exclude_labels):
        return False
    return set(spec.states).issubset(node.states)


def _is_child(node: Node, ancestor: Node) -> bool:
    return len(node.path) > len(ancestor.path) and node.path[:len(ancestor.path)] == ancestor.path


class Resolver:
    """Unique-name AT-SPI resolution, relative-anchor recovery, optional validated vision.

    A location obtained from cache or vision is NEVER acted on without a fresh
    accessibility hit-test that proves the intended semantic target.
    """
    def __init__(self, backend: Backend, vision: Optional[Vision] = None):
        self.backend = backend
        self.vision = vision
        self._snapshot: Optional[Snapshot] = None
        self._cache: dict[str, tuple[int, ...]] = {}
        self._offsets: dict[str, tuple[str, float, float]] = {}

    def _identity(self, snap: Snapshot) -> tuple:
        return (snap.revision, snap.width, snap.height, snap.event_epoch, snap.scale)

    def refresh(self) -> Snapshot:
        snap = self.backend.snapshot()
        if snap.width <= 0 or snap.height <= 0 or not snap.revision:
            raise UIBlocked("INVALID_DISPLAY_SNAPSHOT")
        if self._snapshot is None or self._identity(self._snapshot) != self._identity(snap):
            self._cache.clear()
        self._snapshot = snap
        return snap

    def invalidate(self) -> None:
        self._snapshot = None
        self._cache.clear()

    @staticmethod
    def _descendant_matches(snap: Snapshot, ancestor: Node, spec: Spec) -> bool:
        """Structural evidence: named visible child, never a pixel-position guess.

        The live composer toolbar has no stable accessible name, but uniquely
        contains its visible Send button. Send can be disabled before typing.
        """
        if not spec.descendant_roles and not spec.descendant_labels:
            return True
        roles = {v.casefold() for v in spec.descendant_roles}
        labels = {_norm(v) for v in spec.descendant_labels}
        return any(
            _is_child(n, ancestor) and n.visible() and n.rect is not None
            and n.rect.w > 0 and n.rect.h > 0
            and (not roles or n.role.casefold() in roles)
            and (not labels or _norm(n.name) in labels)
            for n in snap.nodes
        )

    def _candidates(self, snap: Snapshot, spec: Spec) -> list[Node]:
        anchors: list[Node] = []
        if spec.anchor:
            anchor_spec = TARGETS[spec.anchor]
            anchors = [n for n in snap.nodes
                       if _name_match(n, anchor_spec)
                       and self._descendant_matches(snap, n, anchor_spec)]
            if len(anchors) > 1:
                raise UIBlocked("ANCHOR_NOT_UNIQUE")
            if not anchors:
                return []  # absent anchor is a missing target, never an ambiguous guess
        return [
            n for n in snap.nodes
            if _name_match(n, spec) and self._descendant_matches(snap, n, spec)
            and (not anchors or _is_child(n, anchors[0]))
        ]

    def _lookup(self, snap: Snapshot, key: str, spec: Spec) -> Optional[Node]:
        path = self._cache.get(key)
        if path is not None:
            candidate = snap.by_path(path)
            if candidate and _name_match(candidate, spec) and self._descendant_matches(snap, candidate, spec):
                return candidate
            self._cache.pop(key, None)
        candidates = self._candidates(snap, spec)
        if len(candidates) > 1:
            raise UIBlocked("TARGET_AMBIGUOUS")
        if candidates:
            self._cache[key] = candidates[0].path
            return candidates[0]
        return None

    def _validated_anchor_fallback(self, snap: Snapshot, key: str, spec: Spec) -> Optional[Node]:
        offset = self._offsets.get(key)
        if offset is None or spec.anchor is None:
            return None
        anchor_name, rx, ry = offset
        if anchor_name != spec.anchor:
            return None
        anchor = self._lookup(snap, spec.anchor, TARGETS[spec.anchor])
        if anchor is None or anchor.rect is None:
            return None
        px, py = anchor.rect.point(rx, ry)
        hit = self.backend.hit_test(px, py)
        if hit and _name_match(hit, spec) and self._descendant_matches(snap, hit, spec) and _is_child(hit, anchor):
            self._cache[key] = hit.path
            return hit
        return None

    def _validated_vision(self, snap: Snapshot, key: str, spec: Spec) -> Optional[Node]:
        if self.vision is None or spec.anchor is None:
            return None
        anchor = self._lookup(snap, spec.anchor, TARGETS[spec.anchor])
        if anchor is None or anchor.rect is None:
            return None
        match = self.vision.locate(key, anchor, snap)
        if match is None:
            return None
        rx, ry, confidence = match
        if confidence < 0.94 or not (0 <= rx <= 1 and 0 <= ry <= 1):
            return None
        px, py = anchor.rect.point(rx, ry)
        hit = self.backend.hit_test(px, py)
        if hit and _name_match(hit, spec) and self._descendant_matches(snap, hit, spec) and _is_child(hit, anchor):
            self._cache[key] = hit.path
            return hit
        return None

    def resolve(self, target_id: str, *, resync_once: bool = True) -> Node:
        if target_id not in TARGETS:
            raise UIBlocked("UNKNOWN_TARGET")
        spec = TARGETS[target_id]
        snap = self.refresh()
        result = self._lookup(snap, target_id, spec)
        if result is not None:
            return result
        if resync_once:
            self.invalidate()
            snap = self.refresh()
            result = self._lookup(snap, target_id, spec)
            if result is not None:
                return result
        result = self._validated_anchor_fallback(snap, target_id, spec)
        if result is None:
            result = self._validated_vision(snap, target_id, spec)
        if result is None:
            raise UIBlocked("TARGET_NOT_FOUND")
        return result

    def remember_offset(self, target_id: str, anchor_id: str) -> None:
        """Learn ratios only from genuine semantic matches, never guessed pixels."""
        if target_id not in TARGETS or anchor_id not in TARGETS:
            raise UIBlocked("UNKNOWN_TARGET")
        spec = TARGETS[target_id]
        if spec.anchor != anchor_id:
            raise UIBlocked("ANCHOR_NOT_DECLARED")
        target = self.resolve(target_id)
        anchor = self.resolve(anchor_id)
        if not target.rect or not anchor.rect or not _is_child(target, anchor):
            raise UIBlocked("ANCHOR_RELATION_INVALID")
        rx, ry = anchor.rect.relative(target.rect.x + target.rect.w//2, target.rect.y + target.rect.h//2)
        if not (0 <= rx <= 1 and 0 <= ry <= 1):
            raise UIBlocked("TARGET_OUTSIDE_ANCHOR")
        self._offsets[target_id] = (anchor_id, rx, ry)

    def unique_conversation(self, display_name: str) -> Node:
        """Display-name snapshots are weak: refuse duplicates and prefix guesses."""
        if not display_name or display_name.strip() != display_name:
            raise UIBlocked("INVALID_CONVERSATION_NAME")
        snap = self.refresh()
        anchor = self.resolve("conversation_list")
        names = [
            n for n in snap.nodes
            if n.role.casefold() in ("list item", "list-item") and _is_child(n, anchor) and n.visible()
            and _norm(n.name.split("\n", 1)[0]) == _norm(display_name)
        ]
        if len(names) != 1:
            raise UIBlocked("CONVERSATION_NOT_UNIQUE_OR_VISIBLE")
        return names[0]


class Session:
    def __init__(self, backend: Backend, vision: Optional[Vision] = None):
        self.backend = backend
        self.resolver = Resolver(backend, vision)

    def health(self) -> dict[str, bool]:
        snap = self.resolver.refresh()
        has_window = any(n.role in ("frame", "window") and _norm(n.name) in ("wechat", "\u5fae\u4fe1") for n in snap.nodes)
        has_chats = len(self.resolver._candidates(snap, TARGETS["conversation_list"])) == 1
        if not (has_window and has_chats):
            raise UIBlocked("WECHAT_NOT_READY_OR_NOT_AUTHENTICATED")
        return {"window": True, "chats": True, "geometry_dynamic": True}

    def wait_for(self, predicate: Callable[[Snapshot], bool], timeout_seconds: float = 2.5) -> Snapshot:
        end = time.monotonic() + timeout_seconds
        while True:
            snap = self.resolver.refresh()
            if predicate(snap):
                return snap
            remaining = end - time.monotonic()
            if remaining <= 0 or not self.backend.wait_change(remaining):
                raise UIBlocked("POSTCONDITION_TIMEOUT")
            self.resolver.invalidate()

    def open_conversation(self, target: str, *, dry_run: bool = True, allow_mark_read: bool = False) -> dict:
        row = self.resolver.unique_conversation(target)
        if "selected" not in row.states and not allow_mark_read:
            raise UIBlocked("NAVIGATION_MAY_MARK_UNREAD")
        if dry_run:
            return {"state": "NOT_ATTEMPTED", "operation": "open_conversation", "safe": True}
        if "selected" not in row.states and not self.backend.activate(row):
            raise UIBlocked("NAVIGATION_FAILED")
        self.wait_for(lambda s: any(n.path == row.path and "selected" in n.states for n in s.nodes))
        return {"state": "ACKNOWLEDGED", "operation": "open_conversation"}

    def plan_send(self, target: str, text: str) -> Node:
        """Validate preconditions and return the composer Node (Defect K fixed).

        The send button is intentionally NOT resolved here: it may legitimately
        be disabled before text is entered. EffectController resolves it after
        the text-entry postcondition succeeds.
        """
        self.health()
        if not text or not text.strip():
            raise UIBlocked("EMPTY_MESSAGE")
        row = self.resolver.unique_conversation(target)
        if "selected" not in row.states:
            raise UIBlocked("RECIPIENT_NOT_SELECTED")
        composer = self.resolver.resolve("message_input")
        existing = self.backend.editable_text(composer)
        if existing is None:
            raise UIBlocked("COMPOSER_UNREADABLE")
        if existing != "":
            raise UIBlocked("NONEMPTY_EXISTING_DRAFT")
        return composer

    def selected_conversation_name(self) -> Optional[str]:
        """Return the display name of the currently selected conversation row."""
        snap = self.resolver.refresh()
        anchor = self.resolver.resolve("conversation_list")
        rows = [
            n for n in snap.nodes
            if n.role.casefold() in ("list item", "list-item") and _is_child(n, anchor)
            and n.visible() and "selected" in n.states
        ]
        if len(rows) != 1:
            return None
        return rows[0].name.split("\n", 1)[0]


class AtMostOnceJournal:
    """Private local durable effect gate; hashes only, no identities/message body.

    Idempotency key is bound by the caller to (recipient_ref, body, time-bucket)
    via make_key(); see EffectController. Startup reconciliation: call
    pending() to find non-terminal entries that must be reconciled before new
    effects.
    """
    def __init__(self, path: str | Path):
        self.path = Path(path)

    @staticmethod
    def make_key(recipient_ref: str, body: str, time_bucket: str) -> str:
        if not recipient_ref or not body or not time_bucket:
            raise UIBlocked("WEAK_IDEMPOTENCY_KEY")
        raw = "\x1f".join((recipient_ref, body, time_bucket))
        return sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def key_hash(key: str) -> str:
        if not key or len(key) < 12:
            raise UIBlocked("WEAK_IDEMPOTENCY_KEY")
        return sha256(key.encode("utf-8")).hexdigest()

    def _read_all(self, fd: int) -> list[dict]:
        os.lseek(fd, 0, os.SEEK_SET)
        old = os.read(fd, 16*1024*1024).decode("utf-8")
        return [json.loads(x) for x in old.splitlines() if x]

    def record(self, key: str, state: str, *, first: bool = False) -> None:
        if state not in {"PREPARED", "DISPATCH_STARTED", "ACKNOWLEDGED", "IN_DOUBT"}:
            raise UIBlocked("INVALID_JOURNAL_STATE")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_CREAT | os.O_APPEND | os.O_RDWR
        fd = os.open(self.path, flags, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            digest = self.key_hash(key)
            existing = self._read_all(fd)
            found = [r for r in existing if r["key"] == digest]
            if first and found:
                raise UIBlocked("EFFECT_ALREADY_CLAIMED_NO_RETRY")
            if not first and not found:
                raise UIBlocked("MISSING_EFFECT_CLAIM")
            if found and not first:
                prev = found[-1]["state"]
                transitions = {
                    "PREPARED": {"DISPATCH_STARTED", "IN_DOUBT"},
                    "DISPATCH_STARTED": {"ACKNOWLEDGED", "IN_DOUBT"},
                    "ACKNOWLEDGED": set(),
                    "IN_DOUBT": set(),
                }
                if state not in transitions[prev]:
                    raise UIBlocked("JOURNAL_STATE_TRANSITION_DENIED")
            event = json.dumps({"key": digest, "state": state}, separators=(",", ":")) + "\n"
            os.write(fd, event.encode("utf-8"))
            os.fsync(fd)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def pending(self) -> list[str]:
        """Return key digests whose last state is non-terminal (need reconcile)."""
        if not self.path.exists():
            return []
        fd = os.open(self.path, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH)
            rows = self._read_all(fd)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        last: dict[str, str] = {}
        for r in rows:
            last[r["key"]] = r["state"]
        return [k for k, s in last.items() if s in {"PREPARED", "DISPATCH_STARTED"}]


class EffectController:
    """At-most-once guarded UI send. Never returns PROVIDER_CONFIRMED from UI."""
    def __init__(self, session: Session, journal: AtMostOnceJournal):
        self.session = session
        self.journal = journal

    def send_text(self, target: str, text: str, key: str, *,
                  allow_effects: bool = False, expected_recipient: Optional[str] = None) -> dict:
        composer = self.session.plan_send(target, text)
        if not allow_effects:
            return {"state": "NOT_ATTEMPTED", "transport": "UI", "gate": "DRY_RUN"}
        # Engine-side recipient binding: re-confirm the SELECTED conversation
        # matches the intended recipient immediately before dispatch (Defects D, I).
        if expected_recipient is None:
            raise UIBlocked("EXPECTED_RECIPIENT_REQUIRED")
        selected = self.session.selected_conversation_name()
        if selected is None or _norm(selected) != _norm(expected_recipient) or _norm(selected) != _norm(target):
            raise UIBlocked("RECIPIENT_BINDING_MISMATCH")
        self.journal.record(key, "PREPARED", first=True)
        try:
            if not self.session.backend.focus(composer):
                raise UIBlocked("COMPOSER_FOCUS_FAILED")
            if not self.session.backend.replace_text(composer, text):
                raise UIBlocked("TEXT_ENTRY_FAILED")
            self.session.wait_for(lambda s: any(
                n.path == composer.path and "editable" in n.states for n in s.nodes))
            entered = self.session.backend.editable_text(composer)
            if entered != text:
                raise UIBlocked("TEXT_ENTRY_POSTCONDITION_FAILED")
            # Re-check recipient one last time after text entry (close the race).
            selected2 = self.session.selected_conversation_name()
            if selected2 is None or _norm(selected2) != _norm(expected_recipient):
                raise UIBlocked("RECIPIENT_CHANGED_BEFORE_DISPATCH")
            button = self.session.resolver.resolve("send_button")
            if not button.enabled():
                raise UIBlocked("SEND_BUTTON_NOT_ENABLED")
            self.journal.record(key, "DISPATCH_STARTED")
            if not self.session.backend.activate(button):
                raise UIBlocked("SEND_CLICK_UNVERIFIED")
            # This UI observation is NOT independent provider-fresh evidence.
            observed = self.session.backend.visible_sent_message(text)
            status = "ACKNOWLEDGED" if observed else "IN_DOUBT"
            self.journal.record(key, status)
            return {"state": status, "transport": "UI", "provider_confirmed": False}
        except Exception:
            try:
                self.journal.record(key, "IN_DOUBT")
            except UIBlocked:
                pass
            raise
