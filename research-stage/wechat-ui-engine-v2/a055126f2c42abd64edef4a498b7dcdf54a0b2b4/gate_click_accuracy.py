"""Owner-attended Gate H follow-up: three harmless UI click-accuracy checks.

No message draft, Send, Enter, file selection or emoji selection is permitted.
This runner may ONLY open and close the selected owner's UI panes. No screenshots.
Each effect has a unique semantic target, shared X11 mapped hover preflight,
one click, event-driven 3s opening proof, and bounded closure proof.
"""
import hashlib
import os
import subprocess
import sys
import time

import benchmark_gate_f_readsafe as f
from atspi_backend import AtspiBackend
from engine import TARGETS, UIBlocked
from pointer_mapping import hover_target, click_once
from ui_primitives import UiPrimitives

_ALLOWED=("chat_info","sticker","file_chooser")
_SURFACE_ROLES=frozenset(("frame","window","dialog","menu","panel","list",
                          "list item","list-item","button","push button",
                          "filler","table","page tab","scroll pane"))
_UNEXPECTED_ROLES=frozenset(("alert","error","notification"))
_STICKER_HINTS=("sticker","emoji","emoticon","表情","贴纸")

def _in(node,parent):
    return len(node.path)>len(parent.path) and node.path[:len(parent.path)]==parent.path

def _ui(snap, backend):
    state=f._ui_state(snap)
    if not all(state[k] is True for k in ("selected_expected","main_frame_unique",
              "chat_pane_open","message_input_visible","composer_toolbar_visible",
              "send_button_visible")) or state["send_button_enabled"] is not False:
        raise UIBlocked("RECIPIENT_CHAT_OR_SEND_PRECONDITION_FAILED")
    editors=[n for n in snap.nodes if n.role.casefold()=="text" and n.visible()
             and "editable" in n.states
             and f._norm_label(n.name) not in {f._norm_label(x) for x in TARGETS["search_box"].labels}]
    if len(editors)!=1:
        raise UIBlocked("COMPOSER_NOT_UNIQUE")
    try:
        iface=backend._find(editors[0]).get_text_iface()
        count=iface.get_character_count() if iface else None
    except Exception:
        raise UIBlocked("COMPOSER_COUNT_UNAVAILABLE")
    if count!=0:
        raise UIBlocked("COMPOSER_NOT_EMPTY")
    rows=[n for n in snap.nodes if n.visible() and n.role.casefold() in ("list item","list-item")
          and "selected" in n.states]
    # Snapshot is already scoped to selected recipient by _ui_state; only hash row
    # metadata in memory, never show private names/preview.
    selected=[n for n in rows if f._norm_label(n.name.split("\n",1)[0])==f._norm_label(f.TARGET)]
    if len(selected)!=1:
        raise UIBlocked("RECIPIENT_ROW_NOT_UNIQUE")
    return hashlib.sha256(selected[0].name.encode("utf8")).digest()

def _button(snap,label):
    found=[n for n in snap.nodes if n.role.casefold() in ("button","push button")
           and n.visible() and n.enabled() and n.name==label
           and n.rect and n.rect.w>0 and n.rect.h>0]
    if len(found)!=1:
        raise UIBlocked("CLICK_CONTROL_NOT_UNIQUE")
    return found[0]

def _sticker(snap):
    """Discover unlabeled emoji/sticker by known composer-toolbar relationship;
    tooltip must independently confirm Sticker/Emoji after mapped hover.
    """
    file=_button(snap,"Send File")
    toolbars=[n for n in snap.nodes if n.visible() and n.role.casefold() in ("toolbar","tool bar")
              and _in(file,n)]
    if len(toolbars)!=1:
        raise UIBlocked("STICKER_TOOLBAR_NOT_UNIQUE")
    buttons=[n for n in snap.nodes if n.visible() and n.enabled()
             and n.role.casefold()=="button" and not n.name and n.rect
             and _in(n,toolbars[0]) and n.rect.y==file.rect.y
             and n.rect.w==file.rect.w and n.rect.h==file.rect.h
             and n.rect.x<file.rect.x]
    # The FIRST 28x28 button shows a "Sticker" tooltip in the fresh live
    # AT-SPI hover-only census; the other button is not presumed to be emoji.
    if not buttons:
        raise UIBlocked("STICKER_SEMANTIC_ANCHOR_MISSING")
    left=min(n.rect.x for n in buttons)
    selected=[n for n in buttons if n.rect.x==left]
    if len(selected)!=1:
        raise UIBlocked("STICKER_CONTROL_NOT_UNIQUE")
    return selected[0]

def _hint_visible(snap):
    return any(n.visible() and n.role.casefold() in ("label","tool tip","tooltip")
               and any(tok in n.name.casefold() for tok in _STICKER_HINTS)
               for n in snap.nodes)

def _scene(snap):
    # Avoid volatile text and hover tooltips; preserve only UI structure/geometry.
    return frozenset((n.path,n.role,
             (n.rect.x,n.rect.y,n.rect.w,n.rect.h) if n.rect else None)
             for n in snap.nodes if n.visible()
             and n.role.casefold() in _SURFACE_ROLES)

def _changed(before,after):
    a,b=_scene(before),_scene(after)
    added=b-a
    removed=a-b
    # An actual pane/popup changes multiple structural descendants; a
    # tooltip-only label or hover color cannot meet this condition.
    return len(added)>=3 or (len(added)>=1 and len(removed)>=2)

def _no_unexpected_dialog(snap, before):
    baseline={n.path for n in before.nodes if n.visible() and n.role.casefold() in _UNEXPECTED_ROLES}
    return not any(n.visible() and n.role.casefold() in _UNEXPECTED_ROLES
                   and n.path not in baseline for n in snap.nodes)

def _await(backend,predicate,seconds=3.0):
    deadline=time.monotonic()+min(3.0,max(0,seconds))
    snap=backend.snapshot()
    while True:
        if predicate(snap):
            return True,snap
        left=deadline-time.monotonic()
        if left<=0: return False,snap
        backend.wait_change(min(left,0.8))
        snap=backend.snapshot()

def _escape():
    # A separate X11 transient or a second AT-SPI application root is never
    # dismissed by generic popup tests; ordinary key actions must fail closed.
    from x11_modal_guard import assert_no_wechat_modal, assert_key_only_to_created_popup
    assert_no_wechat_modal()
    assert_key_only_to_created_popup()  # main window Escape is permanently forbidden
    try:
        p=subprocess.run(("xdotool","key","--clearmodifiers","Escape"),
                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                         timeout=2,check=False)
        if p.returncode!=0:
            raise UIBlocked("ESCAPE_FAILED")
    except (OSError,subprocess.TimeoutExpired):
        raise UIBlocked("ESCAPE_FAILED")
    finally:
        assert_no_wechat_modal()

def _closed(backend,baseline,row_digest):
    ok,s=_await(backend,lambda ss: _scene(ss)==_scene(baseline),seconds=3.0)
    if not ok:
        return False
    try:
        return _ui(s,backend)==row_digest
    except UIBlocked:
        return False

def _target(snap,kind):
    if kind=="chat_info":
        return _button(snap,"Chat Info")
    if kind=="sticker":
        return _sticker(snap)
    if kind=="file_chooser":
        return _button(snap,"Send File")
    raise UIBlocked("CLICK_KIND_NOT_ALLOWED")

def _run_one(backend,kind,row_digest):
    snap=backend.snapshot()
    _ui(snap,backend)
    UiPrimitives(backend).require_no_modal()
    node=_target(snap,kind)
    if not node.rect:
        raise UIBlocked("CLICK_TARGET_RECT_MISSING")
    logical=(node.rect.w,node.rect.h)
    # no click until semantic logical hit, remeasured physical scale and hover
    plan=hover_target(backend,node,snap=snap,allow_descendant=True,
                      label="GATE_CLICK_POINTER_MAPPING")
    if kind=="sticker":
        changed=backend.wait_change(1.2)
        if not _hint_visible(backend.snapshot()):
            raise UIBlocked("STICKER_TOOLTIP_NOT_VERIFIED")
        print("GATE_CLICK_STICKER_TOOLTIP verified=True event="+str(changed),flush=True)
    before=backend.snapshot() # includes any hover tooltip, no artificial change
    started=time.monotonic()
    clicked=False
    appeared=False
    closed=False
    try:
        clicked=True  # pessimistic: a subprocess error can still have clicked
        click_once(plan)
        appeared,after=_await(backend,lambda ss: _changed(before,ss),seconds=3.0)
        if appeared and not _no_unexpected_dialog(after,before):
            raise UIBlocked("UNEXPECTED_ALERT_AFTER_CLICK")
    finally:
        print("GATE_CLICK_RESULT target="+kind+
              " logical_w="+str(logical[0])+" logical_h="+str(logical[1])+
              " physical_x="+str(plan[1])+" physical_y="+str(plan[2])+
              " appeared="+str(appeared)+" latency_ms="+
              str(round((time.monotonic()-started)*1000))+
              " clicked="+str(clicked),flush=True)
        if clicked:
            # Escape ONLY. If chat-info pane ignores Escape, the owner-approved
            # same toggle is permitted once after a fresh hover+hit verification.
            _escape()
            closed=_closed(backend,before,row_digest)
            if not closed and kind=="chat_info":
                fresh=backend.snapshot()
                toggle=_button(fresh,"Chat Info")
                toggle_plan=hover_target(backend,toggle,snap=fresh,
                                  allow_descendant=True,label="GATE_CLICK_CLOSE_MAPPING")
                click_once(toggle_plan)
                closed=_closed(backend,before,row_digest)
            print("GATE_CLICK_CLOSURE target="+kind+" closed="+str(closed)+
                  " composer_empty="+str(closed)+" recipient_selected="+str(closed)+
                  " row_unchanged="+str(closed),flush=True)
            if not closed:
                raise UIBlocked("UI_NOT_CLOSED_STOP")
    if not appeared:
        raise UIBlocked("EXPECTED_UI_NOT_OBSERVED_STOP")
    if not closed:
        raise UIBlocked("UI_NOT_CLOSED_STOP")
    return True

def main():
    if os.getuid()!=1000 or os.environ.get("WX_GATE_CLICK_ACCURACY")!="1" \
            or os.environ.get("WX_GATE_CLICK_UNREAD_ZERO_VERIFIED")!="1" \
            or not f.TARGET or f.TARGET.strip()!=f.TARGET:
        print("GATE_CLICK_BLOCKED owner_flag_or_unread_zero_missing=True",flush=True)
        return 2
    b=AtspiBackend()
    try:
        base=b.snapshot()
        row_digest=_ui(base,b)
        UiPrimitives(b).require_no_modal()
        print("GATE_CLICK_PREFLIGHT recipient_selected=True composer_count=0 send_disabled=True unread_zero_externally_verified=True",flush=True)
        for kind in _ALLOWED:  # Chat Info, Sticker, Send File: exactly in owner order
            _run_one(b,kind,row_digest)
        end=b.snapshot()
        if _ui(end,b)!=row_digest:
            raise UIBlocked("FINAL_RECIPIENT_OR_ROW_CHANGED")
        print("GATE_CLICK_ACCURACY_PASS all_3=True no_send=True no_file_or_emoji_selected=True",flush=True)
        return 0
    except UIBlocked as e:
        print("GATE_CLICK_STOP code="+str(e.code)+" no_send=True check_UI_before_resuming=True",flush=True)
        return 3

if __name__=="__main__":
    sys.exit(main())
