"""One-owner, no-send WeChat UI click accuracy, one target per invocation.

Run only from an immutable runtime-only snapshot under with_wechat_env.sh.
All clicks go through the shared remeasured Qt-logical→X11-physical hover
primitive and the X11/AT-SPI pre/post modal guard. NO KEYBOARD path exists here.
A newly opened separate popup causes the guard to STOP, without dismissing it.
"""
import hashlib
import os
from pathlib import Path
import sys
import time

from atspi_backend import AtspiBackend
import benchmark_gate_f_readsafe as f
from engine import TARGETS, UIBlocked
from gate_click_accuracy import _button, _changed
from pointer_mapping import hover_target, click_once
from popup_closure import baseline_from_snapshots, verify_popup_closed
from x11_modal_guard import assert_no_wechat_modal

_MODES=frozenset(("chat-info","sticker","send-file"))
_INFO=("Search Chat History","Mute Notifications","Pin to Top",
       "Clear Chat History")
_STICKER_HINTS=("sticker","emoji","emoticon","表情","贴纸")


def _active(n):
    return "visible" in n.states and "showing" in n.states


def _markers(s):
    return {label:sum(n.name==label and _active(n) for n in s.nodes)
            for label in _INFO}


def _anchors(s):
    norm=f._norm_label
    roots=[n for n in s.nodes if n.role.casefold()=="list"
           and _active(n) and norm(n.name) in
           {norm(x) for x in TARGETS["messages_container"].labels}]
    editors=[n for n in s.nodes if n.role.casefold()=="text"
             and _active(n) and "editable" in n.states
             and norm(n.name) not in
             {norm(x) for x in TARGETS["search_box"].labels}]
    if len(roots)!=1 or len(editors)!=1 or not roots[0].rect or not editors[0].rect:
        raise UIBlocked("UI_ANCHORS_NOT_UNIQUE")
    return roots[0].rect,editors[0].rect


def _message_count(s):
    roots=[n for n in s.nodes if n.role.casefold()=="list" and n.visible()
           and f._norm_label(n.name) in
           {f._norm_label(x) for x in TARGETS["messages_container"].labels}]
    if len(roots)!=1:
        raise UIBlocked("MESSAGES_ROOT_NOT_UNIQUE")
    root=roots[0]
    return sum(n.role.casefold() in ("list item","list-item") and n.visible()
               and len(n.path)==len(root.path)+1 and
               n.path[:len(root.path)]==root.path for n in s.nodes)


def _safe_state(b,s):
    state=f._ui_state(s)
    required=("main_frame_unique","selected_expected","chat_pane_open",
              "message_input_visible","composer_toolbar_visible",
              "send_button_visible")
    if not all(state.get(x) is True for x in required) or state["send_button_enabled"] is not False:
        raise UIBlocked("MOE_EMPTY_STATE_UNVERIFIED")
    roots,editor=_anchors(s)
    editors=[n for n in s.nodes if n.role.casefold()=="text" and n.visible()
             and "editable" in n.states and n.rect==editor]
    if len(editors)!=1:
        raise UIBlocked("COMPOSER_NOT_UNIQUE")
    try:
        iface=b._find(editors[0]).get_text_iface()
        length=iface.get_character_count() if iface else None
    except Exception:
        length=None
    if length!=0:
        raise UIBlocked("COMPOSER_NOT_EMPTY")
    count=_message_count(s)
    if count!=8:
        raise UIBlocked("MESSAGE_COUNT_CHANGED")
    return roots,editor


def _wait_for(b,predicate,seconds=3):
    started=time.monotonic()
    deadline=started+min(3,max(0,seconds))
    s=b.snapshot()
    while True:
        if predicate(s):
            return True,s,int(round((time.monotonic()-started)*1000))
        remaining=deadline-time.monotonic()
        if remaining<=0:
            return False,s,int(round((time.monotonic()-started)*1000))
        b.wait_change(min(0.5,remaining))
        s=b.snapshot()


def _claim_once(mode):
    """Irreversible per-owner one-attempt marker BEFORE any pointer click."""
    if mode not in _MODES:
        raise UIBlocked("MODE_NOT_ADMITTED")
    root=Path.home()/".local/state/wechat-research-ui-v3"
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    st=root.lstat()
    if root.is_symlink() or st.st_uid!=os.getuid() or st.st_mode & 0o077:
        raise UIBlocked("CLICK_MARKER_ROOT_UNSAFE")
    key=hashlib.sha256(("v3-no-key-ui-ladder:"+mode).encode()).hexdigest()
    marker=root/(key+".once")
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0)
    try:
        fd=os.open(marker,flags,0o600)
    except FileExistsError:
        raise UIBlocked("CLICK_ALREADY_ATTEMPTED")
    except OSError:
        raise UIBlocked("CLICK_MARKER_CLAIM_FAILED")
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(b"CLAIMED_ONE_ATTEMPT_NO_RETRY\n")
            stream.flush()
            os.fsync(stream.fileno())
        dfd=os.open(root,os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        # Keep any uncertain marker; never repeat a potentially executed click.
        raise UIBlocked("CLICK_MARKER_DURABILITY_UNVERIFIED")


def _toggle_chat_info(b):
    before=b.snapshot()
    original_anchors=_safe_state(b,before)
    labels=_markers(before)
    if not all(labels[k]>=1 for k in _INFO):
        raise UIBlocked("CHAT_INFO_NOT_OPEN")
    button=_button(before,"Chat Info")
    plan=hover_target(b,button,snap=before,allow_descendant=True,
                      label="V3_CHAT_INFO_HOVER")
    _claim_once("chat-info")
    started=time.monotonic()
    click_once(plan)  # checks extra X windows and AT-SPI sibling roots AFTER click
    ok,after,latency=_wait_for(b,lambda ss: all(v==0 for v in _markers(ss).values()),
                              seconds=3)
    closed=bool(ok and _anchors(after)==original_anchors)
    print("V3_CHAT_INFO_TOGGLE opened_before=True clicked_once=True"+
          " physical_x="+str(plan[1])+" physical_y="+str(plan[2])+
          " closed="+str(closed)+" elapsed_ms="+str(latency)+
          " markers_after="+str(_markers(after))+
          " no_keys=True no_send=True",flush=True)
    if not closed:
        raise UIBlocked("CHAT_INFO_CLOSE_NOT_VERIFIED")
    _safe_state(b,after)
    assert_no_wechat_modal()
    return True


def _sticker_button(snap):
    """Only the owner-qualified named Sticker button at the known toolbar slot."""
    nodes=[n for n in snap.nodes if n.role.casefold() in ("button","push button")
           and n.name=="Send Sticker(Alt+E)" and n.visible() and n.enabled()
           and n.rect is not None and
           (n.rect.x,n.rect.y,n.rect.w,n.rect.h)==(568,755,28,28)]
    if len(nodes)!=1:
        raise UIBlocked("STICKER_NAMED_BUTTON_NOT_UNIQUE")
    return nodes[0]


def _toolbar_popup(b,mode):
    if mode not in ("sticker","send-file"):
        raise UIBlocked("MODE_NOT_ADMITTED")
    before=b.snapshot()
    previous_anchors=_safe_state(b,before)
    if any(_markers(before).values()):
        raise UIBlocked("CHAT_INFO_PANEL_STILL_OPEN")
    node=_sticker_button(before) if mode=="sticker" else _button(before,"Send File")
    plan=hover_target(b,node,snap=before,allow_descendant=True,
                      label="V3_"+mode.upper().replace("-","_")+"_HOVER")
    # Exact named AT-SPI button + fresh hit-test + owner-approved one-off crop
    # replace the older unreliable search for an unnamed toolbar sibling.
    before=b.snapshot()  # hover/tooltips cannot count as click-opened nodes
    _safe_state(b,before)
    _claim_once(mode)
    started=time.monotonic()
    click_once(plan)  # separate X dialog blocks immediately, NO Escape
    found,opened,open_ms=_wait_for(b,lambda ss: _changed(before,ss),seconds=3)
    if not found:
        print("V3_POPUP target="+mode+" opened=False elapsed_ms="+str(open_ms),flush=True)
        raise UIBlocked("POPUP_NOT_OBSERVED")
    record=baseline_from_snapshots(b,before,opened)
    if _anchors(opened)!=previous_anchors:
        raise UIBlocked("POPUP_SHIFTED_COMPOSER_OR_MESSAGES")
    print("V3_POPUP target="+mode+" opened=True new_showing_nodes="+
          str(sum(record.added.values()))+" open_ms="+str(open_ms)+
          " separate_window=False no_selection=True",flush=True)
    fresh=b.snapshot()
    target=_sticker_button(fresh) if mode=="sticker" else _button(fresh,"Send File")
    closeplan=hover_target(b,target,snap=fresh,allow_descendant=True,
                          label="V3_"+mode.upper().replace("-","_")+"_CLOSE_HOVER")
    click_once(closeplan)  # same toggle only, exactly once; NO keyboard
    evidence=verify_popup_closed(record,timeout=2.0,poll=0.1)
    print("V3_POPUP_CLOSE target="+mode+" closed="+str(evidence.closed)+
          " remaining_added="+str(evidence.remaining_added)+
          " extents_match="+str(evidence.extents_match)+
          " elapsed_ms="+str(evidence.elapsed_ms)+
          " no_keys=True no_send=True",flush=True)
    if not evidence.closed:
        raise UIBlocked("POPUP_CLOSE_NOT_VERIFIED")
    _safe_state(b,b.snapshot())
    assert_no_wechat_modal()
    return True


def main():
    mode=os.environ.get("WX_UI_LADDER_MODE","")
    if (mode not in _MODES or os.getuid()!=1000 or
        os.environ.get("WX_UI_LADDER_RUN")!="1" or
        os.environ.get("WX_UI_LADDER_UNREAD_ZERO")!="1" or
        not f.TARGET or hashlib.sha256(f.TARGET.encode("utf8")).hexdigest()!=os.environ.get("WX_UI_LADDER_TARGET_SHA256","") or
        os.environ.get("WX_GATE_H_SEND_ONCE") or
        os.environ.get("WX_GATE_H_TEXT")):
        print("V3_BLOCKED bad_mode_or_owner_scope",flush=True)
        return 2
    try:
        assert_no_wechat_modal()
        b=AtspiBackend()
        if mode=="chat-info":
            _toggle_chat_info(b)
        else:
            _toolbar_popup(b,mode)
        print("V3_PASS mode="+mode+" no_send=True no_keys=True",flush=True)
        return 0
    except UIBlocked as err:
        print("V3_STOP mode="+mode+" code="+err.code+
              " no_retry=True no_send=True no_keys=True",flush=True)
        return 3
    except Exception as err:
        print("V3_STOP mode="+mode+" unexpected="+type(err).__name__+
              " no_retry=True no_send=True no_keys=True",flush=True)
        return 3


if __name__=="__main__":
    sys.exit(main())
