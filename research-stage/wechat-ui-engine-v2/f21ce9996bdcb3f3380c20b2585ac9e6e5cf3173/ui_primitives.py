"""Internal, typed WeChat UI primitives. Research only; not a generic GUI MCP API.

All targeting is the engine's semantic Resolver. No absolute pointer positions,
fixed sleeps, account identifiers, chat-text logging, or implicit effect retries.
Operations fail closed if the current official Qt/AT-SPI build does not expose
unique controls and a verifiable state transition.

These primitives are not themselves shipped WeChat capabilities: any real
capability needs its own build-specific live qualification and verification.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Literal, Optional

from engine import Backend, Node, Resolver, Snapshot, UIBlocked, _is_child, _norm

ScrollDirection = Literal["up", "down"]
_MODAL_ROLES = frozenset(("dialog", "alert", "alert dialog", "file chooser",
                         "font chooser", "color chooser"))
_MENU_ROLES = frozenset(("menu", "popup menu"))
_MENU_ITEM_ROLES = frozenset(("menu item", "check menu item", "radio menu item"))
_SCROLL_ROOTS = frozenset(("messages_container", "conversation_list"))
_KEYBOARD_NAV_TARGETS = frozenset((
    "nav_chats", "nav_contacts", "nav_moments", "nav_favorites",
))


@dataclass(frozen=True)
class OperationResult:
    state: str
    control: str
    steps: int = 0


class UiPrimitives:
    def __init__(self, backend: Backend):
        self.backend = backend
        self.resolver = Resolver(backend)

    def visible_modals(self, snap: Optional[Snapshot] = None) -> tuple[Node, ...]:
        snap = self.backend.snapshot() if snap is None else snap
        return tuple(n for n in snap.nodes
                     if n.role.casefold() in _MODAL_ROLES and n.visible()
                     and n.rect is not None and n.rect.w > 0 and n.rect.h > 0)

    def require_no_modal(self) -> None:
        if self.visible_modals():
            raise UIBlocked("MODAL_BLOCKS_ACTION")

    def preflight_keyboard_navigation(self, target_id: str) -> Node:
        if target_id not in _KEYBOARD_NAV_TARGETS:
            raise UIBlocked("KEYBOARD_NAV_TARGET_UNSUPPORTED")
        self.require_no_modal()
        node = self.resolver.resolve(target_id)
        if not node.enabled() or not node.visible():
            raise UIBlocked("KEYBOARD_NAV_TARGET_NOT_INTERACTABLE")
        return node

    def keyboard_navigation(self, target_id: str, *, dry_run: bool = True) -> OperationResult:
        """Focus a verified nav control then activate its semantic AT-SPI action.

        This may move between tabs: do not use while verifying the currently
        selected chat's read state unless caller explicitly qualifies that tab.
        """
        node = self.preflight_keyboard_navigation(target_id)
        if dry_run:
            return OperationResult("NOT_ATTEMPTED", target_id)
        from x11_modal_guard import assert_no_wechat_modal
        assert_no_wechat_modal()
        try:
            if not self.backend.focus(node) or not self.backend.activate(node):
                raise UIBlocked("KEYBOARD_NAV_ACTION_FAILED")
        finally:
            assert_no_wechat_modal()
        # Only status ACK; provider- or message-level evidence is not claimed.
        if not self.backend.wait_change(2.0):
            raise UIBlocked("KEYBOARD_NAV_EVENT_UNVERIFIED")
        self.resolver.invalidate()
        return OperationResult("ACKNOWLEDGED", target_id, 1)

    def open_read_safe_row(self, row: Node, *, zero_unread_verified: bool = False,
                           dry_run: bool = True) -> OperationResult:
        """Open only a semantically hit-verified chat row.

        If the row is already selected, NEVER click it again: this Qt build
        can deselect it. Otherwise require external authoritative unread=0
        evidence, and perform at most one targeted click.
        """
        self.require_no_modal()
        if (row.role.casefold() not in ("list item", "list-item")
                or not row.visible() or not row.enabled() or not row.name
                or not row.rect or row.rect.w <= 0 or row.rect.h <= 0):
            raise UIBlocked("OPEN_ROW_NOT_INTERACTABLE")
        is_selected = "selected" in row.states
        if not is_selected and not zero_unread_verified:
            raise UIBlocked("OPEN_MAY_MARK_UNREAD")
        # Logical AT-SPI hit and X11 physical mapping are SEPARATE spaces.
        # All effectful row clicks must use the same fresh hover-verified mapping
        # as the successfully owner-qualified Gate H send button.
        from pointer_mapping import logical_hit_plan, hover_target, click_once
        try:
            logical_hit_plan(self.backend,row,allow_descendant=True)
        except UIBlocked:
            raise UIBlocked("OPEN_ROW_HIT_TEST_FAILED")
        if dry_run:
            return OperationResult("NOT_ATTEMPTED", "conversation_row")
        if not is_selected:
            try:
                physical=hover_target(self.backend,row,allow_descendant=True,
                                      label="OPEN_ROW_POINTER_MAPPING")
            except UIBlocked:
                raise UIBlocked("OPEN_ROW_POINTER_MAPPING_UNVERIFIED")
            # One pointer click only; no synthetic keyboard or action fallback.
            try:
                click_once(physical)
            except UIBlocked:
                raise UIBlocked("OPEN_ROW_CLICK_IN_DOUBT")
        self.resolver.invalidate()
        fresh = self.backend.snapshot()
        matches = [n for n in fresh.nodes
                   if n.role.casefold() in ("list item", "list-item")
                   and n.visible() and "selected" in n.states and n.name == row.name]
        if len(matches) != 1 and not is_selected:
            if self.backend.wait_change(2.5):
                fresh = self.backend.snapshot()
                matches = [n for n in fresh.nodes
                           if n.role.casefold() in ("list item", "list-item")
                           and n.visible() and "selected" in n.states and n.name == row.name]
        if len(matches) != 1:
            raise UIBlocked("OPEN_ROW_POSTCONDITION_FAILED")
        return OperationResult("ACKNOWLEDGED", "conversation_row", 0 if is_selected else 1)

    def scroll_until(self, container: str,
                     predicate: Callable[[Snapshot], bool],
                     direction: ScrollDirection,
                     *, max_steps: int = 8, step: Optional[Callable[[Node, ScrollDirection], bool]] = None
                     ) -> OperationResult:
        """Event-waited bounded scroll; no guessed target or unbounded loop.

        Caller must provide a target-specific keyboard-first AT-SPI scroll
        implementation. Without one, the feature is UNSUPPORTED. A navigation
        scan must independently prove no unread state was affected.
        """
        if container not in _SCROLL_ROOTS or direction not in ("up", "down"):
            raise UIBlocked("SCROLL_TARGET_OR_DIRECTION_UNSUPPORTED")
        if not 1 <= max_steps <= 32:
            raise UIBlocked("SCROLL_STEP_LIMIT_INVALID")
        self.require_no_modal()
        snap = self.resolver.refresh()
        if predicate(snap):
            return OperationResult("ACKNOWLEDGED", container, 0)
        if step is None:
            raise UIBlocked("SCROLL_ACTUATOR_NOT_CALIBRATED")
        last_revision = snap.revision
        for count in range(1, max_steps + 1):
            target = self.resolver.resolve(container)
            if not target.visible() or not target.enabled():
                raise UIBlocked("SCROLL_TARGET_NOT_INTERACTABLE")
            if not step(target, direction):
                raise UIBlocked("SCROLL_ACTION_FAILED")
            # No timer-based fixed sleeps, no blind polling; require a real
            # event-driven semantic change before another action.
            if not self.backend.wait_change(2.5):
                raise UIBlocked("SCROLL_CHANGE_UNVERIFIED")
            self.resolver.invalidate()
            snap = self.resolver.refresh()
            if predicate(snap):
                return OperationResult("ACKNOWLEDGED", container, count)
            if snap.revision == last_revision:
                raise UIBlocked("SCROLL_DID_NOT_PROGRESS")
            last_revision = snap.revision
            self.require_no_modal()
        raise UIBlocked("SCROLL_PREDICATE_NOT_FOUND")

    def preflight_context_menu(self, row: Node) -> None:
        self.require_no_modal()
        if (row.role.casefold() not in ("list item", "list-item")
                or not row.visible() or not row.enabled()):
            raise UIBlocked("CONTEXT_ROW_NOT_INTERACTABLE")
        if not row.path:
            raise UIBlocked("CONTEXT_ROW_PATH_MISSING")
        # A selected row is the only safe subject for a context-menu
        # investigation without potentially switching an unread conversation.
        if "selected" not in row.states:
            raise UIBlocked("CONTEXT_ROW_MAY_CHANGE_READ_STATE")

    def context_menu_open(self, row: Node, *,
                          trigger: Optional[Callable[[Node], bool]] = None,
                          dry_run: bool = True) -> OperationResult:
        self.preflight_context_menu(row)
        if dry_run:
            return OperationResult("NOT_ATTEMPTED", "context_menu")
        if trigger is None:
            raise UIBlocked("CONTEXT_TRIGGER_NOT_CALIBRATED")
        if not trigger(row) or not self.backend.wait_change(2.5):
            raise UIBlocked("CONTEXT_MENU_OPEN_UNVERIFIED")
        snap = self.resolver.refresh()
        menus = [n for n in snap.nodes if n.role.casefold() in _MENU_ROLES and n.visible()]
        if len(menus) != 1:
            raise UIBlocked("CONTEXT_MENU_NOT_UNIQUE")
        return OperationResult("ACKNOWLEDGED", "context_menu", 1)

    def context_menu_select(self, label: str, *, dry_run: bool = True,
                            confirm_irreversible: bool = False) -> OperationResult:
        """Selection only for unique, visible menu item; mutations explicitly gated.

        No effects are enabled for this build until exact item semantics and
        result verification have been empirically calibrated. This method
        intentionally refuses live activation.
        """
        if not label or not label.strip():
            raise UIBlocked("CONTEXT_ITEM_LABEL_REQUIRED")
        snap = self.resolver.refresh()
        menus = [n for n in snap.nodes
                 if n.role.casefold() in _MENU_ROLES and n.visible()]
        if len(menus) != 1:
            raise UIBlocked("CONTEXT_MENU_NOT_UNIQUE")
        found = [n for n in snap.nodes
                 if n.role.casefold() in _MENU_ITEM_ROLES
                 and n.visible() and n.enabled() and _is_child(n, menus[0])
                 and _norm(n.name) == _norm(label)]
        if len(found) != 1:
            raise UIBlocked("CONTEXT_ITEM_NOT_UNIQUE")
        if dry_run:
            return OperationResult("NOT_ATTEMPTED", "context_item")
        if not confirm_irreversible:
            raise UIBlocked("CONTEXT_MUTATION_REQUIRES_CONFIRM")
        raise UIBlocked("CONTEXT_EFFECT_UNSUPPORTED_UNTIL_LIVE_VERIFICATION")


class KeyboardAtspiActuator:
    """Private event synth for a *resolved* and focused scrollable list.

    No pixel coordinates or arbitrary key sequences are accepted by callers.
    The fixed keysyms only mean PageUp or PageDown.
    """
    PAGE_UP = 0xFF55
    PAGE_DOWN = 0xFF56

    def __init__(self, backend):
        self.backend = backend

    def scroll_page(self, node: Node, direction: ScrollDirection) -> bool:
        if direction not in ("up", "down"):
            raise UIBlocked("SCROLL_DIRECTION_UNSUPPORTED")
        if node.role.casefold() != "list" or not node.visible() or not node.enabled():
            raise UIBlocked("SCROLL_CONTROL_NOT_CALIBRATED")
        if not self.backend.focus(node):
            raise UIBlocked("SCROLL_CONTROL_NOT_FOCUSABLE")
        try:
            from atspi_backend import Atspi
            if Atspi is None or not hasattr(self.backend, "_key"):
                return False
            key = self.PAGE_UP if direction == "up" else self.PAGE_DOWN
            return bool(self.backend._key(key, Atspi.KeySynthType.SYM))
        except Exception:
            return False

    def trigger_context_menu(self, row: Node) -> bool:
        """Keyboard-first Shift+F10 for an ALREADY selected semantic row.

        Never guesses context-menu entries or runs arbitrary keys. Caller
        independently verifies exactly one actual visible popup menu.
        """
        if (row.role.casefold() not in ("list item", "list-item")
                or not row.visible() or not row.enabled()
                or "selected" not in row.states):
            raise UIBlocked("CONTEXT_KEYBOARD_TARGET_NOT_SELECTED")
        if not self.backend.focus(row):
            return False
        try:
            from atspi_backend import Atspi
            if Atspi is None or "focused" not in self.backend._states(self.backend._find(row)):
                return False
            shift = 0xFFE1
            f10 = 0xFFC7
            if not self.backend._key(shift, Atspi.KeySynthType.PRESS):
                return False
            try:
                return bool(self.backend._key(f10, Atspi.KeySynthType.SYM))
            finally:
                self.backend._key(shift, Atspi.KeySynthType.RELEASE)
        except Exception:
            return False
