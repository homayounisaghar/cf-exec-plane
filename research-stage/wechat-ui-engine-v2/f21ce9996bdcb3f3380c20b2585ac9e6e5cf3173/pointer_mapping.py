"""Uniform Qt logical -> X11 physical targeting, passive hover verification.

The official Linux WeChat AT-SPI tree yields logical SCREEN coordinates.
The X11 window owned by the same WeChat PID yields physical coordinates.
Resolve exactly one matching window and scale at every action. No screenshots,
no DPI changes, no implicit GUI action or Return fallback.
"""
import os
import subprocess
import time
from engine import UIBlocked, TARGETS
from x11_modal_guard import assert_no_wechat_modal

def main_frame_rect(snap):
    labels={" ".join(str(x).casefold().split()) for x in TARGETS["main_frame"].labels}
    roots=[n for n in snap.nodes if n.role.casefold() in ("frame","window")
           and " ".join(str(n.name).casefold().split()) in labels
           and n.visible() and n.rect is not None and n.rect.w>0 and n.rect.h>0]
    if len(roots)!=1:
        raise UIBlocked("MAIN_FRAME_NOT_UNIQUE")
    return roots[0].rect

def logical_hit_plan(backend,node,*,allow_descendant=False):
    """No side effects; require exact semantic hit at this node's center."""
    if not node or not node.rect or not node.visible() or not node.enabled() \
            or node.rect.w<=0 or node.rect.h<=0:
        raise UIBlocked("POINTER_TARGET_NOT_INTERACTABLE")
    rect=node.rect
    x,y=rect.x+rect.w//2,rect.y+rect.h//2
    try:
        hit=backend.hit_test(x,y)
        same=(hit is not None and hit.path==node.path and hit.role==node.role
              and hit.name==node.name and hit.rect==rect)
        child=(allow_descendant and hit is not None
               and len(hit.path)>len(node.path)
               and hit.path[:len(node.path)]==node.path)
    except Exception:
        same=child=False
    if not (same or child):
        raise UIBlocked("POINTER_TARGET_HIT_TEST_FAILED")
    return ("HIT_TEST_CLICK",x,y)

def _xdotool_shell(*args):
    out=subprocess.run(("xdotool",)+tuple(args),stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL,timeout=5,check=False)
    if out.returncode!=0:
        raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
    vals={}
    for line in out.stdout.decode("ascii","replace").splitlines():
        if "=" in line:
            k,v=line.split("=",1)
            vals[k.strip()]=v.strip()
    return vals


def _verify_pointer_mapping(plan, frame_rect, tolerance=2, *, label="GATE_H_POINTER_MAPPING"):
    """HOVER ONLY (no click). AT-SPI reports Qt LOGICAL coords; X11 uses PHYSICAL.

    Find the X11 window of THIS WeChat whose geometry is the AT-SPI main frame
    scaled by one uniform factor s (w and h ratios agree; origin agrees), map the
    planned logical point to physical, hover there, and require X to report the
    pointer exactly there over that same window. Returns the PHYSICAL click plan.
    Any mismatch blocks BEFORE the one-shot claim.
    """
    if len(plan)!=3 or plan[0]!="HIT_TEST_CLICK" or frame_rect is None \
            or frame_rect.w<=0 or frame_rect.h<=0:
        raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
    ok=False; scale=None; px=py=None
    try:
        pids=subprocess.run(("pgrep","-u",str(os.getuid()),"-x","wechat"),
                            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                            timeout=5,check=False).stdout.decode("ascii","replace").split()
        if len(pids)!=1:
            raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
        found=subprocess.run(("xdotool","search","--onlyvisible","--pid",pids[0]),
                             stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                             timeout=5,check=False).stdout.decode("ascii","replace").split()
        matches=[]
        for win in found[:20]:
            if not win.isdigit():
                continue
            geo=_xdotool_shell("getwindowgeometry","--shell",win)
            gx,gy=int(geo.get("X","-99999")),int(geo.get("Y","-99999"))
            gw,gh=int(geo.get("WIDTH","-1")),int(geo.get("HEIGHT","-1"))
            sx,sy=gw/frame_rect.w,gh/frame_rect.h
            if not (0.5<=sx<=3.0) or abs(sx-sy)>0.005:
                continue
            s=(sx+sy)/2
            if abs(gx-frame_rect.x*s)<=tolerance+1 and abs(gy-frame_rect.y*s)<=tolerance+1:
                matches.append((win,s))
        if len(matches)!=1:
            raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
        win,scale=matches[0]
        px,py=int(round(plan[1]*scale)),int(round(plan[2]*scale))
        moved=subprocess.run(("xdotool","mousemove",str(px),str(py)),
                             stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                             timeout=5,check=False)
        if moved.returncode!=0:
            raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
        loc=_xdotool_shell("getmouselocation","--shell")
        ok=(int(loc.get("X","-1"))==px and int(loc.get("Y","-1"))==py
            and loc.get("WINDOW","")==win)
    except UIBlocked:
        ok=False
    except Exception:
        ok=False
    print(label+" hover_only=True x11_matches_atspi="+str(ok)+
          " scale="+("%.4f"%scale if scale else "NA")+
          " physical_x="+str(px)+" physical_y="+str(py),flush=True)
    if not ok:
        raise UIBlocked("POINTER_MAPPING_UNVERIFIED")
    return ("HIT_TEST_CLICK",px,py)



def hover_target(backend,node,*,snap=None,allow_descendant=False,label="WECHAT_POINTER_MAPPING"):
    """Semantic hit then owner-window physical-coordinate hover verification."""
    base=backend.snapshot() if snap is None else snap
    plan=logical_hit_plan(backend,node,allow_descendant=allow_descendant)
    return _verify_pointer_mapping(plan,main_frame_rect(base),label=label)

def click_once(plan, *, expected_file_scope=None, file_cancel=False,
               expected_sticker_scope=None, sticker_toggle=False):
    """One pre/post-guarded pointer click. Unrelated windows always block.

    Only the SAME click's unforgeable in-process scope can whitelist a
    properly fingerprinted separate native file/sticker popup. Neither type
    authorizes a file/sticker selection or an arbitrary message send.
    """
    if (not isinstance(plan,tuple) or len(plan)!=3 or plan[0]!="HIT_TEST_CLICK"
            or not all(isinstance(v,int) for v in plan[1:])):
        raise UIBlocked("POINTER_CLICK_PLAN_INVALID")
    if expected_file_scope is not None and expected_sticker_scope is not None:
        raise UIBlocked("TWO_POPUP_SCOPES_FORBIDDEN")
    if expected_sticker_scope is not None:
        from x11_modal_guard import (ExpectedStickerPopup,mark_expected_sticker_click)
        scope=expected_sticker_scope
        if type(scope) is not ExpectedStickerPopup:
            raise UIBlocked("STICKER_SCOPE_NOT_AUTHENTIC")
        if sticker_toggle:
            if scope.window_id is None or scope.toggle_clicked or scope.closed:
                raise UIBlocked("STICKER_TOGGLE_NOT_VERIFIED_OR_REUSED")
            assert_no_wechat_modal(expected_sticker_popup=scope)
            scope.toggle_clicked=True
        else:
            assert_no_wechat_modal()
            mark_expected_sticker_click(scope,(plan[1],plan[2]))
    elif expected_file_scope is not None:
        from x11_modal_guard import (ExpectedFileChooser,mark_expected_file_click)
        scope=expected_file_scope
        if type(scope) is not ExpectedFileChooser:
            raise UIBlocked("FILE_SCOPE_NOT_AUTHENTIC")
        if file_cancel:
            if scope.window_id is None or scope.cancel_clicked:
                raise UIBlocked("FILE_CANCEL_ALREADY_USED_OR_UNVERIFIED")
            assert_no_wechat_modal(expected_file_chooser=scope)
            scope.cancel_clicked=True
        else:
            assert_no_wechat_modal()
            mark_expected_file_click(scope,(plan[1],plan[2]))
    else:
        if file_cancel or sticker_toggle:
            raise UIBlocked("POPUP_CONTROL_SCOPE_REQUIRED")
        assert_no_wechat_modal()
    started=time.monotonic()
    try:
        p=subprocess.run(("xdotool","mousemove",str(plan[1]),str(plan[2]),"click","1"),
                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                         timeout=5,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise UIBlocked("POINTER_CLICK_IN_DOUBT")
    finally:
        print("WECHAT_POINTER_CLICK elapsed_ms="+str(round((time.monotonic()-started)*1000))+
              " physical_x="+str(plan[1])+" physical_y="+str(plan[2])+
              " click_attempts=1",flush=True)
        if expected_sticker_scope is not None:
            if sticker_toggle:
                assert_no_wechat_modal()
            else:
                assert_no_wechat_modal(expected_sticker_popup=expected_sticker_scope)
        else:
            assert_no_wechat_modal(expected_file_chooser=expected_file_scope)
    if p.returncode!=0:
        raise UIBlocked("POINTER_CLICK_IN_DOUBT")
    return True
