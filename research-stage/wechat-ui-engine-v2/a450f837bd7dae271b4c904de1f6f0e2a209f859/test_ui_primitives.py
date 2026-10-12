"""Offline R2 tests: no app, no message, no real UI mutation."""
from __future__ import annotations

from dataclasses import replace

from engine import Node, Rect, Snapshot, UIBlocked
from fakes import FakeBackend, build_tree
from ui_primitives import KeyboardAtspiActuator, UiPrimitives

base = frozenset(("visible", "showing", "enabled", "sensitive"))
cases = 0


def check(label, fn):
    global cases
    fn()
    cases += 1
    print("[PASS]", label)


def blocked(code, fn):
    try:
        fn()
    except UIBlocked as exc:
        assert exc.code == code, (code, exc.code)
    else:
        raise AssertionError("expected " + code)


def fixture(selected="FixtureRecipient", *, modal=False, menu=False):
    snap = build_tree(selected=selected)
    extras = [Node((0, 2), "button", "WeChat", base, Rect(5, 10, 30, 30)),
              Node((0, 3), "list", "Messages", base, Rect(320, 80, 760, 580))]
    if modal:
        extras.append(Node((0, 4), "dialog", "PrivateModal", base, Rect(350, 200, 400, 300)))
    if menu:
        extras.extend([
            Node((0, 5), "menu", "", base, Rect(100, 200, 200, 240)),
            Node((0, 5, 0), "menu item", "Copy", base, Rect(110, 210, 180, 35)),
        ])
    snap = replace(snap, nodes=snap.nodes + tuple(extras))
    return FakeBackend(snap)


def t_modal_empty():
    assert UiPrimitives(fixture()).visible_modals() == ()


def t_modal_blocks_navigation():
    blocked("MODAL_BLOCKS_ACTION",
            lambda: UiPrimitives(fixture(modal=True)).keyboard_navigation("nav_chats"))


def t_keyboard_navigation_dry():
    b = fixture()
    result = UiPrimitives(b).keyboard_navigation("nav_chats")
    assert result.state == "NOT_ATTEMPTED" and b.sent is None


def t_unsupported_nav_rejected():
    blocked("KEYBOARD_NAV_TARGET_UNSUPPORTED",
            lambda: UiPrimitives(fixture()).keyboard_navigation("message_input"))


def t_scroll_requires_actuator():
    blocked("SCROLL_ACTUATOR_NOT_CALIBRATED",
            lambda: UiPrimitives(fixture()).scroll_until("messages_container",
                   lambda s: any(n.name == "VIRTUAL_MATCH" for n in s.nodes), "up"))


def t_scroll_predicate_zero_steps():
    r = UiPrimitives(fixture()).scroll_until(
        "messages_container", lambda s: any(n.role == "list" and n.name == "Messages"
                                             for n in s.nodes), "up")
    assert r.steps == 0 and r.state == "ACKNOWLEDGED"


def t_scroll_success_event_driven():
    b = fixture()
    def step(node, direction):
        assert node.role == "list" and direction == "up"
        b.set_snapshot(replace(b._snap, revision="changed",
                               nodes=b._snap.nodes + (Node((0, 3, 0), "label", "FOUND",
                                                  base, Rect(340, 100, 100, 20)),)))
        return True
    r = UiPrimitives(b).scroll_until(
        "messages_container", lambda s: any(n.name == "FOUND" for n in s.nodes),
        "up", max_steps=1, step=step)
    assert r.steps == 1 and r.state == "ACKNOWLEDGED"


def t_scroll_no_progress():
    b = fixture()
    blocked("SCROLL_DID_NOT_PROGRESS",
            lambda: UiPrimitives(b).scroll_until(
                "messages_container", lambda s: False, "down",
                max_steps=2, step=lambda n, d: True))


def t_scroll_limit():
    blocked("SCROLL_STEP_LIMIT_INVALID",
            lambda: UiPrimitives(fixture()).scroll_until(
                "messages_container", lambda s: False, "up",
                max_steps=0, step=lambda n,d: True))



def t_reopen_selected_row_dry_run():
    b = fixture()
    row = next(n for n in b.snapshot().nodes if n.name == "FixtureRecipient")
    result = UiPrimitives(b).open_read_safe_row(row)
    assert result.state == "NOT_ATTEMPTED" and b.sent is None


def t_reopen_unselected_rejected():
    b = fixture(selected="FixtureAlternate")
    row = next(n for n in b.snapshot().nodes if n.name == "FixtureRecipient")
    blocked("OPEN_MAY_MARK_UNREAD",
            lambda: UiPrimitives(b).open_read_safe_row(row))

def t_menu_unselected_denied():
    b = fixture(selected="FixtureAlternate")
    row = next(n for n in b.snapshot().nodes if n.name == "FixtureRecipient")
    blocked("CONTEXT_ROW_MAY_CHANGE_READ_STATE",
            lambda: UiPrimitives(b).context_menu_open(row))


def t_menu_open_dry_run():
    b = fixture()
    row = next(n for n in b.snapshot().nodes if n.name == "FixtureRecipient")
    r = UiPrimitives(b).context_menu_open(row)
    assert r.state == "NOT_ATTEMPTED" and b.sent is None


def t_menu_select_dry_run():
    r = UiPrimitives(fixture(menu=True)).context_menu_select("Copy")
    assert r.state == "NOT_ATTEMPTED"


def t_menu_mutation_requires_confirm():
    blocked("CONTEXT_MUTATION_REQUIRES_CONFIRM",
            lambda: UiPrimitives(fixture(menu=True)).context_menu_select("Copy",dry_run=False))


def t_menu_mutation_unverified():
    blocked("CONTEXT_EFFECT_UNSUPPORTED_UNTIL_LIVE_VERIFICATION",
            lambda: UiPrimitives(fixture(menu=True)).context_menu_select(
                "Copy", dry_run=False, confirm_irreversible=True))



def t_context_keyboard_unselected_rejected():
    b = fixture(selected="FixtureAlternate")
    row = next(n for n in b.snapshot().nodes if n.name == "FixtureRecipient")
    blocked("CONTEXT_KEYBOARD_TARGET_NOT_SELECTED",
            lambda: KeyboardAtspiActuator(b).trigger_context_menu(row))


def t_context_keyboard_nonrow_rejected():
    b = fixture()
    node = next(n for n in b.snapshot().nodes if n.name == "Messages")
    blocked("CONTEXT_KEYBOARD_TARGET_NOT_SELECTED",
            lambda: KeyboardAtspiActuator(b).trigger_context_menu(node))


def t_keyboard_scroll_no_context():
    blocked("SCROLL_CONTROL_NOT_CALIBRATED",
            lambda: KeyboardAtspiActuator(fixture()).scroll_page(
                Node((0, 9), "button", "Dummy", base), "down"))


for key, fn in list(globals().items()):
    if key.startswith("t_") and callable(fn):
        check(key, fn)
print("%d/%d passed" % (cases, cases))
