"""Owner-qualified one-time Send File chooser test. NO FILE SELECTION.

Opens only the uniquely hit-tested Send File button; admits only one
matching separate WeChat X11 file chooser within 3 seconds. Escape only
with chooser X input focus verified, else exact Cancel button via shared
mapped pointer primitive. Never sends, types, presses Enter, or retries.
"""
import hashlib
import os
import subprocess
import sys
import time

from atspi_backend import AtspiBackend, Atspi
import benchmark_gate_f_readsafe as f
from engine import UIBlocked
from gate_click_accuracy import _button
from pointer_mapping import (hover_target,click_once,_verify_pointer_mapping,
                             _xdotool_shell)
from wechat_ui_ladder_v3 import _safe_state,_markers,_claim_once
from x11_modal_guard import (assert_no_wechat_modal,
                             assert_key_only_to_created_popup,
                             new_expected_file_chooser,ExpectedFileChooser)

_FILE_SIGNS=("file","folder","open","files","choose","select","文件","选择","打开")
_FILE_BUTTONS=("Open","Cancel","Choose","Select","打开","取消","选择")


def _subprocess(*args,timeout=3):
    try:
        return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                              timeout=timeout,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise UIBlocked("FILE_CHOOSER_X_ACTION_AMBIGUOUS")


def _active(acc):
    states=acc.get_state_set()
    return bool(states.contains(Atspi.StateType.VISIBLE) and
                states.contains(Atspi.StateType.SHOWING))


def _popup_tree(scope):
    """Fresh AT-SPI root, never the main-window cached accessible."""
    desktop=Atspi.get_desktop(0)
    apps=[desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
    apps=[a for a in apps if a and str(a.get_process_id())==str(scope.pid)]
    if len(apps)!=1:
        raise UIBlocked("FILE_CHOOSER_ATSPI_APP_NOT_UNIQUE")
    app=apps[0]
    roots=[app.get_child_at_index(i) for i in range(app.get_child_count())]
    nonmain=[a for a in roots if a and not (a.get_role_name().casefold() in ("frame","window") and
              (a.get_name() or "").casefold() in ("wechat","微信"))]
    if len(nonmain)!=1:
        raise UIBlocked("FILE_CHOOSER_ATSPI_ROOT_NOT_UNIQUE")
    root=nonmain[0]
    controls=[]
    stack=[(root,0)]
    while stack and len(controls)<200:
        acc,depth=stack.pop()
        if acc is None or depth>24:continue
        role=(acc.get_role_name() or "").casefold()
        name=acc.get_name() or ""
        if role in ("button","push button") and _active(acc):
            iface=acc.get_component_iface()
            ext=iface.get_extents(Atspi.CoordType.SCREEN) if iface else None
            if ext:
                controls.append((name,(ext.x,ext.y,ext.width,ext.height),acc))
        for i in range(min(acc.get_child_count(),100)-1,-1,-1):
            child=acc.get_child_at_index(i)
            if child is not None:stack.append((child,depth+1))
    return root,controls


def _verify_popup_semantics(scope):
    root,buttons=_popup_tree(scope)
    names=[n for n,_,_ in buttons]
    if names.count("Cancel")!=1 or not any(
       any(k in n.casefold() for k in ("open","choose","select","打开","选择"))
       for n in names):
        raise UIBlocked("FILE_CHOOSER_CONTROLS_NOT_VERIFIED")
    print("FILE_CHOOSER_OPEN title="+repr(scope.title)+
          " buttons="+repr(names)+" open_ms="+str(scope.opened_ms)+
          " new_window_id="+hex(scope.window_id)+" no_selection=True",flush=True)
    return root,buttons


def _wait_open(scope):
    deadline=scope.issued_at+3.0
    while True:
        assert_no_wechat_modal(expected_file_chooser=scope)
        if scope.window_id is not None:
            try:
                root,buttons=_verify_popup_semantics(scope)
                return root,buttons
            except UIBlocked as err:
                # Both the root and controls may arrive just after X11 maps.
                # Only these two bounded *readiness* misses may be polled.
                if (err.code not in ("FILE_CHOOSER_ATSPI_ROOT_NOT_UNIQUE",
                                     "FILE_CHOOSER_CONTROLS_NOT_VERIFIED")
                        or time.monotonic()>=deadline):
                    raise
        time_left=deadline-time.monotonic()
        if time_left<=0:
            raise UIBlocked("FILE_CHOOSER_NOT_OPEN_WITHIN_3S")
        time.sleep(min(0.1,time_left))


def _window_gone(scope):
    p=_subprocess("xwininfo","-id",hex(scope.window_id),timeout=2)
    if (p.returncode==0 and "Map State: IsViewable" in p.stdout.decode("utf8","replace")):
        return False
    if (p.returncode==0 and not any(
        word in p.stdout.decode("utf8","replace")
        for word in ("Map State: IsUnMapped","Map State: IsUnviewable"))):
        raise UIBlocked("FILE_CHOOSER_MAP_STATE_UNKNOWN")
    # Qt may hide a popup without destroying its X ID. Either destroyed or
    # definitively unmapped counts closed only after the default no-extra
    # X11 and AT-SPI guard passes.
    assert_no_wechat_modal()
    scope.closed=True
    return True


def _wait_closed(scope,limit=2.0):
    deadline=time.monotonic()+limit
    while True:
        if _window_gone(scope):
            return True
        if time.monotonic()>=deadline:
            return False
        time.sleep(min(.1,max(0,deadline-time.monotonic())))


def _fallback_cancel(scope,root,buttons):
    """One validated Cancel click on the separate file chooser; no key."""
    candidates=[x for x in buttons if x[0]=="Cancel"]
    if len(candidates)!=1 or scope.cancel_clicked:
        raise UIBlocked("FILE_CHOOSER_CANCEL_NOT_UNIQUE")
    name,rect,acc=candidates[0]
    x,y,w,h=rect
    if w<12 or h<12:raise UIBlocked("FILE_CHOOSER_CANCEL_RECT_INVALID")
    cx,cy=x+w//2,y+h//2
    # Hit-test INSIDE the separate modal root rather than main-window AT-SPI.
    comp=root.get_component_iface()
    hit=comp.get_accessible_at_point(cx,cy,Atspi.CoordType.SCREEN) if comp else None
    if not hit:
        raise UIBlocked("FILE_CANCEL_POPUP_HIT_TEST_FAILED")
    hit_name=hit.get_name() or ""
    hit_role=(hit.get_role_name() or "").casefold()
    if not (hit_name=="Cancel" or
            (hit_role=="label" and hit_name=="Cancel")):
        raise UIBlocked("FILE_CANCEL_POPUP_HIT_TEST_FAILED")
    panel=comp.get_extents(Atspi.CoordType.SCREEN)
    if panel is None:
        raise UIBlocked("FILE_POPUP_RECT_MISSING")
    from engine import Rect
    plan=_verify_pointer_mapping(("HIT_TEST_CLICK",cx,cy),
          Rect(panel.x,panel.y,panel.width,panel.height),
          label="FILE_CHOOSER_CANCEL_HOVER")
    loc=_xdotool_shell("getmouselocation","--shell")
    if int(loc.get("WINDOW","-1"))!=scope.window_id:
        raise UIBlocked("FILE_CANCEL_WRONG_X_WINDOW")
    # Ensure far from any OK/Open/Choose button; operate only on Cancel.
    from math import floor
    scale_x=(plan[1]/cx) if cx else 0
    if not (.5<scale_x<3.):
        raise UIBlocked("FILE_CANCEL_SCALE_INVALID")
    for other_name,other_rect,_ in buttons:
        if other_name.casefold() in ("ok","open","choose","select","打开","选择"):
            ox,oy,ow,oh=other_rect
            # Cancel may be LEFT or RIGHT of Open. Require >=20 physical
            # pixels from either edge of every irreversible action button.
            left=round(ox*scale_x)
            right=round((ox+ow)*scale_x)
            if left-20 <= plan[1] <= right+20:
                raise UIBlocked("FILE_CANCEL_TOO_CLOSE_TO_OPEN")
    print("FILE_CHOOSER_CANCEL_PLAN match=True window="+hex(scope.window_id)+
          " physical_x="+str(plan[1])+" physical_y="+str(plan[2]),flush=True)
    click_once(plan,expected_file_scope=scope,file_cancel=True)
    return _wait_closed(scope)


def _try_escape(scope,root,buttons):
    """Only a proven own-click separate popup may receive Escape."""
    try:
        assert_key_only_to_created_popup(popup_proof=scope)
    except UIBlocked as err:
        if err.code=="POPUP_X_INPUT_FOCUS_UNVERIFIED":
            print("FILE_CHOOSER_ESCAPE_SKIPPED focus_wrong=True",flush=True)
            return _fallback_cancel(scope,root,buttons)
        raise
    if scope.escape_attempted:
        raise UIBlocked("FILE_CHOOSER_ESCAPE_ALREADY_ATTEMPTED")
    scope.escape_attempted=True
    resp=_subprocess("xdotool","key","Escape",timeout=3)
    print("FILE_CHOOSER_ESCAPE_ONE no_clearmodifiers=True command_ok="+
          str(resp.returncode==0),flush=True)
    if resp.returncode==0 and _wait_closed(scope):
        return True
    # An unverified/no-op Escape is not retried. Only one scoped Cancel.
    if _window_gone(scope):
        return True
    assert_no_wechat_modal(expected_file_chooser=scope)
    return _fallback_cancel(scope,root,buttons)


def main():
    if (os.getuid()!=1000 or
        os.environ.get("WX_FILE_CHOOSER_ONCE")!="1" or
        os.environ.get("WX_FILE_CHOOSER_UNREAD_ZERO")!="1" or
        not f.TARGET or
        hashlib.sha256(f.TARGET.encode("utf8")).hexdigest()!=
            os.environ.get("WX_FILE_CHOOSER_TARGET_SHA256","") or
        os.environ.get("WX_GATE_H_SEND_ONCE") or os.environ.get("WX_GATE_H_TEXT")):
        print("FILE_CHOOSER_STOP bad_scope=True no_click=True",flush=True)
        return 2
    scope=None
    try:
        assert_no_wechat_modal()
        b=AtspiBackend()
        before=b.snapshot()
        _safe_state(b,before)
        if any(_markers(before).values()):
            raise UIBlocked("CHAT_INFO_STILL_OPEN")
        node=_button(before,"Send File")
        r=node.rect
        if r is None or not node.enabled():
            raise UIBlocked("FILE_CONTROL_NOT_INTERACTABLE")
        print("FILE_CONTROL_VERIFIED role="+node.role+" name="+repr(node.name)+
              " logical_rect="+repr((r.x,r.y,r.w,r.h))+
              " unique=True",flush=True)
        plan=hover_target(b,node,snap=before,allow_descendant=False,
                          label="FILE_CHOOSER_TARGET_HOVER")
        scope=new_expected_file_chooser()
        _claim_once("send-file")
        click_once(plan,expected_file_scope=scope)
        root,buttons=_wait_open(scope)
        if not _try_escape(scope,root,buttons):
            raise UIBlocked("FILE_CHOOSER_CLOSE_UNVERIFIED")
        assert_no_wechat_modal()
        after=b.snapshot()
        _safe_state(b,after)
        if any(_markers(after).values()):
            raise UIBlocked("CHAT_INFO_CHANGED")
        print("FILE_CHOOSER_PASS closed=True still_logged_in=True"+
              " composer_empty=True send_disabled=True visible_messages=8"+
              " no_selection=True no_send=True",flush=True)
        return 0
    except UIBlocked as err:
        print("FILE_CHOOSER_STOP code="+err.code+
              " clicked="+str(scope is not None and scope.issued_at is not None)+
              " no_retry=True no_send=True",flush=True)
        return 3
    except Exception as err:
        print("FILE_CHOOSER_STOP unexpected="+type(err).__name__+
              " clicked="+str(scope is not None and scope.issued_at is not None)+
              " no_retry=True no_send=True",flush=True)
        return 3


if __name__=="__main__":
    sys.exit(main())
