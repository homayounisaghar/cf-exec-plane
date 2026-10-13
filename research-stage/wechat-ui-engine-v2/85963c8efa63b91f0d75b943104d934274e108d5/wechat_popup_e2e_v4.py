"""One-owner two-control WeChat popup confirmation. NO send/type/file/sticker selection.

Mode=sticker or file, per-control attempts 1..2 only (all O_EXCL markers
retained). Separate popup verified by own-click fingerprint; only verified X
input focus may receive plain Escape. Main-window keys are IMPOSSIBLE.
"""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from atspi_backend import AtspiBackend
from engine import UIBlocked
from gate_click_accuracy import _button
from gate_file_chooser_once import _verify_popup_semantics,_fallback_cancel
from pointer_mapping import hover_target,click_once
from wechat_ui_ladder_v3 import _safe_state,_markers,_sticker_button
import benchmark_gate_f_readsafe as f
from x11_modal_guard import (assert_no_wechat_modal,
    assert_key_only_to_created_popup,
    new_expected_file_chooser,new_expected_sticker_popup)

def _run(*args,timeout=4):
    try:
        return subprocess.run(args,capture_output=True,text=True,timeout=timeout,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise UIBlocked("V4_X11_COMMAND_AMBIGUOUS")

def _claim_once(mode,attempt):
    if mode not in ("sticker","file") or attempt not in (1,2):
        raise UIBlocked("V4_ATTEMPT_SCOPE_INVALID")
    folder=Path.home()/".local/state/wechat-research-ui-v4"
    folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    if folder.is_symlink() or folder.stat().st_uid!=os.getuid() or folder.stat().st_mode&0o077:
        raise UIBlocked("V4_LOCK_DIR_UNSAFE")
    a=hashlib.sha256(("v4_popup_"+mode+"_attempt_"+str(attempt)).encode()).hexdigest()
    marker=folder/(a+".once")
    if attempt==2:
        previous=hashlib.sha256(("v4_popup_"+mode+"_attempt_1").encode()).hexdigest()
        if not (folder/(previous+".once")).exists():
            raise UIBlocked("V4_ATTEMPT2_WITHOUT_ATTEMPT1")
    fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
    try:
        with os.fdopen(fd,"wb") as out:
            out.write(b"CLAIMED_NONRETRYABLE_POPUP_ATTEMPT\n")
            out.flush()
            os.fsync(out.fileno())
        dfd=os.open(folder,os.O_RDONLY)
        try:os.fsync(dfd)
        finally:os.close(dfd)
    except Exception:
        # On uncertainty, marker is NEVER removed or reset.
        raise UIBlocked("V4_LOCK_DURABILITY_UNVERIFIED")

def _window_state(wid):
    status=_run("xwininfo","-id",hex(wid),timeout=3)
    if status.returncode!=0:
        return "gone"
    if "Map State: IsViewable" in status.stdout:
        return "viewable"
    if "Map State: IsUnMapped" in status.stdout or "Map State: IsUnviewable" in status.stdout:
        return "hidden"
    raise UIBlocked("V4_POPUP_X_MAP_UNKNOWN")

def _focus_own_popup(scope):
    if scope.window_id is None or scope.main_id is None:
        raise UIBlocked("V4_POPUP_NOT_PROVEN")
    if _window_state(scope.window_id)!="viewable":
        raise UIBlocked("V4_POPUP_NOT_VIEWABLE")
    x=_run("xdotool","windowfocus","--sync",hex(scope.window_id),timeout=5)
    if x.returncode!=0:
        return False
    focus=_run("xdotool","getwindowfocus")
    if focus.returncode!=0:return False
    try:wid=int(focus.stdout.strip(),0)
    except ValueError:return False
    for _ in range(12):
        if wid==scope.window_id:return True
        if wid==scope.main_id:return False
        tree=_run("xwininfo","-id",str(wid),"-tree")
        m=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",tree.stdout)
        if tree.returncode!=0 or not m:return False
        nxt=int(m.group(1),16)
        if nxt==wid:return False
        wid=nxt
    return False

def _wait_closed(scope,limit=2):
    start=time.monotonic()
    end=start+limit
    while True:
        state=_window_state(scope.window_id)
        if state in ("hidden","gone"):
            assert_no_wechat_modal()
            scope.closed=True
            return True,int(round((time.monotonic()-start)*1000)),state
        if time.monotonic()>=end:
            return False,int(round((time.monotonic()-start)*1000)),state
        time.sleep(min(.08,end-time.monotonic()))

def _wait_open(scope,mode,limit=3):
    start=time.monotonic()
    deadline=scope.issued_at+limit
    while True:
        if mode=="sticker":
            assert_no_wechat_modal(expected_sticker_popup=scope)
        else:
            assert_no_wechat_modal(expected_file_chooser=scope)
        if scope.window_id is not None and _window_state(scope.window_id)=="viewable":
            return int(round((time.monotonic()-start)*1000))
        if time.monotonic()>=deadline:
            raise UIBlocked("V4_POPUP_NOT_OPEN_3S")
        time.sleep(min(.06,deadline-time.monotonic()))

def _close_popup(scope,mode,b,button,plan):
    focus=_focus_own_popup(scope)
    print("V4_FOCUS target="+mode+" popup="+hex(scope.window_id)+
          " verified="+str(focus)+" main_key_forbidden=True",flush=True)
    attempted_key=False
    if focus:
        assert_key_only_to_created_popup(popup_proof=scope)
        attempted_key=True
        scope.escape_attempted=True
        started=time.monotonic()
        q=_run("xdotool","key","Escape",timeout=3)
        print("V4_ESCAPE target="+mode+" exactly_once=True command_ok="+str(q.returncode==0),flush=True)
        if q.returncode==0:
            closed,duration,status=_wait_closed(scope)
            if closed:
                print("V4_CLOSE target="+mode+" method=focused_popup_escape"+
                      " close_ms="+str(round((time.monotonic()-started)*1000))+
                      " state="+status,flush=True)
                return True
    if _window_state(scope.window_id)!="viewable":
        closed,duration,status=_wait_closed(scope)
        if closed:
            print("V4_CLOSE target="+mode+" method=spontaneous_hide"+
                  " close_ms="+str(duration),flush=True)
            return True
    if mode=="sticker":
        if scope.toggle_clicked:
            raise UIBlocked("V4_STICKER_TOGGLE_ALREADY_USED")
        # Sticker popup lies ABOVE toolbar; the original button remains
        # outside the popup. Only the same named button may be clicked.
        s=b.snapshot()
        current=_sticker_button(s)
        plan2=hover_target(b,current,snap=s,allow_descendant=True,
                           label="V4_STICKER_TOGGLE_HOVER")
        if plan2[1:]!=plan[1:]:
            raise UIBlocked("V4_STICKER_BUTTON_MOVED")
        click_once(plan2,expected_sticker_scope=scope,sticker_toggle=True)
        closed,duration,status=_wait_closed(scope)
        print("V4_CLOSE target=sticker method=same_verified_toggle closed="+str(closed)+
              " close_ms="+str(duration)+" state="+status,flush=True)
        return closed
    # File chooser fallback is strictly its own accessible Cancel button
    # (never Open/OK), mapped and hover verified inside the chooser X window.
    from gate_file_chooser_once import _popup_tree
    root,buttons=_popup_tree(scope)
    if not _fallback_cancel(scope,root,buttons):
        return False
    closed,duration,status=_wait_closed(scope)
    print("V4_CLOSE target=file method=verified_file_cancel closed="+str(closed)+
          " close_ms="+str(duration)+" state="+status,flush=True)
    return closed

def _safe_post_state(b):
    assert_no_wechat_modal()
    s=b.snapshot()
    _safe_state(b,s)
    if any(_markers(s).values()):
        raise UIBlocked("V4_CHAT_INFO_CHANGED")
    print("V4_FINAL_NATIVE logged_in=True selected_target=True unread_external_required=True"+
          " composer_empty=True send_disabled=True visible_messages=8 chat_info_closed=True",flush=True)

def main():
    mode=os.environ.get("WX_V4_MODE","")
    attempt_raw=os.environ.get("WX_V4_ATTEMPT","")
    try:attempt=int(attempt_raw)
    except ValueError:attempt=-1
    if (mode not in ("sticker","file") or attempt not in (1,2) or
        os.getuid()!=1000 or
        os.environ.get("WX_V4_OWNER_APPROVED")!="1" or
        os.environ.get("WX_V4_UNREAD_ZERO")!="1" or
        not f.TARGET or hashlib.sha256(f.TARGET.encode("utf8")).hexdigest()!=
            os.environ.get("WX_V4_TARGET_SHA256","") or
        os.environ.get("WX_GATE_H_TEXT") or os.environ.get("WX_GATE_H_SEND_ONCE")):
        print("V4_STOP code=OWNER_SCOPE_INVALID no_ui_input=True",flush=True)
        return 2
    scope=None
    try:
        assert_no_wechat_modal()
        b=AtspiBackend()
        before=b.snapshot()
        _safe_state(b,before)
        if any(_markers(before).values()):
            raise UIBlocked("V4_CHAT_INFO_OPEN")
        node=_sticker_button(before) if mode=="sticker" else _button(before,"Send File")
        if node.rect is None or not node.enabled():
            raise UIBlocked("V4_UNIQUE_CONTROL_INVALID")
        plan=hover_target(b,node,snap=before,allow_descendant=True,
                          label="V4_"+mode.upper()+"_OPEN_HOVER")
        scope=(new_expected_sticker_popup() if mode=="sticker"
               else new_expected_file_chooser())
        _claim_once(mode,attempt)
        if mode=="sticker":
            click_once(plan,expected_sticker_scope=scope)
        else:
            click_once(plan,expected_file_scope=scope)
        if scope.window_id is None:
            _wait_open(scope,mode)
        if mode=="file":
            _verify_popup_semantics(scope)
        print("V4_OPEN target="+mode+" popup="+hex(scope.window_id)+
              " title="+repr("All Stickers (untitled)" if mode=="sticker" else scope.title)+
              " open_ms="+str(scope.opened_ms)+
              " same_wechat_pid=True no_selection=True",flush=True)
        if not _close_popup(scope,mode,b,node,plan):
            raise UIBlocked("V4_POPUP_CLOSE_UNVERIFIED")
        _safe_post_state(b)
        print("V4_PASS target="+mode+" attempt="+str(attempt)+
              " close_verified=True main_keys=0 typed=0 sent=0 selected=0",flush=True)
        return 0
    except FileExistsError:
        print("V4_STOP target="+mode+" code=PERMANENT_ATTEMPT_ALREADY_CONSUMED",flush=True)
        return 3
    except UIBlocked as err:
        print("V4_STOP target="+mode+" code="+err.code+
              " click_claimed="+str(scope is not None and scope.issued_at is not None)+
              " main_keys=0 typed=0 sent=0",flush=True)
        return 3
    except Exception as err:
        print("V4_STOP target="+mode+" error_type="+type(err).__name__+
              " click_claimed="+str(scope is not None and scope.issued_at is not None)+
              " main_keys=0 typed=0 sent=0",flush=True)
        return 3

if __name__=="__main__":
    sys.exit(main())
