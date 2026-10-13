"""Owner-scoped popup verification; never types, sends, presses Enter/Space or keys on main X window.

Dedicated 2026-10-13 v4 attempts are separate O_EXCL markers; older markers
remain permanently intact. Both actions use a verified popup scope.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

import benchmark_gate_f_readsafe as f
from atspi_backend import AtspiBackend
from engine import UIBlocked
from gate_click_accuracy import _button
from pointer_mapping import hover_target, click_once
from wechat_ui_ladder_v3 import _safe_state,_markers,_sticker_button
from x11_modal_guard import (assert_no_wechat_modal,new_expected_sticker_popup,
    new_expected_file_chooser,assert_key_only_to_created_popup)

_MODES=("sticker","send-file")
def run(*args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=3,check=False)
    if p.returncode!=0:raise UIBlocked("X11_FOCUS_OR_KEY_COMMAND_FAILED")
    return p.stdout.strip()

def claim_once(mode):
    root=Path.home()/".local/state/wechat-research-ui-v4"
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if root.is_symlink() or root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:
        raise UIBlocked("V4_MARKER_UNSAFE")
    name=hashlib.sha256(("owner-v4-popup:"+mode).encode()).hexdigest()+".once"
    try:fd=os.open(root/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,"O_NOFOLLOW",0),0o600)
    except FileExistsError:raise UIBlocked("V4_ALREADY_ATTEMPTED")
    with os.fdopen(fd,"w") as stream:
        stream.write("OWN_CLICK_ONE_RUN_NO_RETRY\n")
        stream.flush();os.fsync(stream.fileno())

def verify_focus_popup(scope):
    if scope.window_id is None:raise UIBlocked("POPUP_WINDOW_NOT_VERIFIED")
    wid=scope.window_id
    run("xdotool","windowfocus","--sync",hex(wid))
    current=int(run("xdotool","getwindowfocus"),0)
    for depth in range(13):
        if current==wid:
            print("V4_FOCUS popup="+hex(wid)+" verified=True ancestor_depth="+str(depth),flush=True)
            return True
        output=run("xwininfo","-id",str(current),"-tree")
        import re
        m=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",output)
        if not m:break
        nxt=int(m.group(1),16)
        if nxt==current:break
        current=nxt
    raise UIBlocked("POPUP_FOCUS_NOT_VERIFIED")

def wait_closed(scope,deadline=2):
    started=time.monotonic()
    while True:
        p=subprocess.run(("xwininfo","-id",str(scope.window_id)),capture_output=True,text=True,timeout=2)
        hidden=p.returncode!=0 or ("Map State: IsUnMapped" in p.stdout)
        try:plain=assert_no_wechat_modal()
        except UIBlocked:plain=False
        if hidden and plain:
            elapsed=round((time.monotonic()-started)*1000)
            print("V4_POPUP_CLOSED=True elapsed_ms="+str(elapsed)+" popup="+hex(scope.window_id),flush=True)
            return True
        if time.monotonic()-started>=deadline:raise UIBlocked("POPUP_CLOSE_UNVERIFIED")
        time.sleep(.08)

def click_test(mode):
    assert_no_wechat_modal()
    b=AtspiBackend()
    snap=b.snapshot()
    _safe_state(b,snap)
    if any(_markers(snap).values()):raise UIBlocked("CHAT_INFO_OPEN")
    node=_sticker_button(snap) if mode=="sticker" else _button(snap,"Send File")
    if not node.enabled():raise UIBlocked("BUTTON_NOT_ENABLED")
    plan=hover_target(b,node,snap=snap,allow_descendant=(mode=="sticker"),
        label="V4_"+mode.upper().replace("-","_")+"_HOVER")
    scope=new_expected_sticker_popup() if mode=="sticker" else new_expected_file_chooser()
    claim_once(mode)  # old v3 or H locks are NEVER removed/reset
    print("V4_START mode="+mode+" role="+node.role+" name="+repr(node.name)+
          " physical="+str(plan[1:])+" no_send=True",flush=True)
    if mode=="sticker":click_once(plan,expected_sticker_scope=scope)
    else:click_once(plan,expected_file_scope=scope)
    # The click guard has already accepted the new window within 3 seconds.
    if scope.window_id is None:raise UIBlocked("EXPECTED_POPUP_NOT_QUALIFIED")
    print("V4_OPEN mode="+mode+" popup="+hex(scope.window_id)+
          " opened_ms="+str(scope.opened_ms)+" guard=ACCEPTED",flush=True)
    assert_no_wechat_modal(expected_sticker_popup=scope if mode=="sticker" else None,
                            expected_file_chooser=scope if mode=="send-file" else None)
    verify_focus_popup(scope)
    assert_key_only_to_created_popup(popup_proof=scope)
    if mode=="sticker":scope.escape_attempted=True
    else:scope.escape_attempted=True
    # Only the verified separate popup owns focus. No main-window key possible.
    run("xdotool","key","Escape")
    print("V4_ESCAPE_ONCE popup="+hex(scope.window_id)+" no_modifiers=True",flush=True)
    wait_closed(scope)
    _safe_state(b,b.snapshot())
    if any(_markers(b.snapshot()).values()):raise UIBlocked("CHAT_INFO_CHANGED")
    assert_no_wechat_modal()
    print("V4_PASS mode="+mode+" composer_empty=True send_disabled=True visible_messages=8 no_selection=True",flush=True)

def main():
    mode=os.getenv("WX_V4_MODE","")
    expected=hashlib.sha256(f.TARGET.encode()).hexdigest() if f.TARGET else ""
    if (mode not in _MODES or os.getuid()!=1000 or
        os.getenv("WX_V4_AUTH")!="1" or not f.TARGET or
        os.getenv("WX_V4_TARGET_SHA256")!=expected or
        os.getenv("WX_GATE_H_SEND_ONCE") or os.getenv("WX_GATE_H_TEXT")):
        print("V4_BLOCK bad_owner_scope",flush=True);return 2
    try:click_test(mode);return 0
    except UIBlocked as e:
        print("V4_STOP mode="+mode+" code="+e.code+" no_send=True no_retry=True",flush=True);return 3
    except Exception as e:
        print("V4_STOP mode="+mode+" unexpected="+type(e).__name__+" no_send=True no_retry=True",flush=True);return 3

if __name__=="__main__":sys.exit(main())
