"""One-owner WeChat X11 + AT-SPI modal guard. NO GUI effects in this module.

Fail closed before and after ordinary UI actions if an unexpected
WeChat-owned transient/top-level window or a second AT-SPI application root
appears, regardless of whether Qt reports role=dialog.
Explicitly owner-authorized modal recovery is separate from ordinary actions.
"""
import os
import re
import subprocess
from engine import UIBlocked


def _run(*command):
    try:
        p=subprocess.run(command,stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL,text=True,timeout=3,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise UIBlocked("X11_MODAL_INSPECTION_UNAVAILABLE")
    if p.returncode!=0:
        raise UIBlocked("X11_MODAL_INSPECTION_UNAVAILABLE")
    return p.stdout


def _window_id(raw):
    try:
        return int(str(raw).strip(),0)
    except (ValueError,TypeError):
        raise UIBlocked("X11_WINDOW_ID_INVALID")


def check_inventory(entries,root_id,expected_pid):
    """Pure validator: zero extra top-level or transient WeChat windows."""
    if not entries:
        raise UIBlocked("X11_WECHAT_MAIN_NOT_UNIQUE")
    roots=[e for e in entries if e["parent"]==root_id]
    mains=[e for e in roots if e["name"]=="WeChat"
           and e["class_ok"] and e["pid"]==expected_pid]
    if len(mains)!=1:
        raise UIBlocked("X11_WECHAT_MAIN_NOT_UNIQUE")
    main=mains[0]["id"]
    for e in entries:
        if e["transient"]==main:
            raise UIBlocked("X11_WECHAT_TRANSIENT_PRESENT")
        if e["parent"]==root_id and e["id"]!=main:
            raise UIBlocked("X11_WECHAT_EXTRA_TOPLEVEL")
    return main


def check_atspi_roots(app,pid):
    """Never confuse a sibling role=filler with main-window content."""
    if app is None or str(app.get_process_id())!=str(pid):
        raise UIBlocked("ATSPI_WECHAT_APP_UNVERIFIED")
    try:
        children=[app.get_child_at_index(i) for i in range(app.get_child_count())]
        if any(v is None for v in children):
            raise UIBlocked("ATSPI_ROOT_UNAVAILABLE")
        mains=[v for v in children
               if v.get_role_name().casefold() in ("frame","window")
               and (v.get_name() or "").casefold() in ("wechat","微信")]
        if len(mains)!=1:
            raise UIBlocked("ATSPI_MAIN_ROOT_NOT_UNIQUE")
        if any(v!=mains[0] for v in children):
            # A second root may be a Qt modal role=filler, frame, or another
            # unclassified role. Reject it regardless of role/SHOWING.
            raise UIBlocked("ATSPI_EXTRA_APPLICATION_ROOT")
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("ATSPI_ROOT_INSPECTION_UNAVAILABLE")
    return True


def assert_no_wechat_modal():
    """Bounded, read-only pre/post-check around every effectful UI operation."""
    try:
        ps=_run("pgrep","-u",str(os.getuid()),"-x","wechat").split()
        if len(ps)!=1:
            raise UIBlocked("X11_WECHAT_PID_NOT_UNIQUE")
        pid=ps[0]
        root_text=_run("xwininfo","-root")
        match=re.search(r"Window id:\s*(0x[0-9a-fA-F]+)",root_text)
        if not match:raise UIBlocked("X11_ROOT_UNAVAILABLE")
        root=_window_id(match.group(1))
        raw=_run("xdotool","search","--pid",pid).split()
        if not raw or len(raw)>64:
            raise UIBlocked("X11_WECHAT_WINDOW_INVENTORY_INVALID")
        ids=list(dict.fromkeys(_window_id(w) for w in raw))
        entries=[]
        for wid in ids:
            info=_run("xwininfo","-id",str(wid),"-tree")
            parent_match=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",info)
            if not parent_match:raise UIBlocked("X11_PARENT_UNAVAILABLE")
            props=_run("xprop","-id",str(wid),
                       "WM_CLASS","WM_NAME","_NET_WM_PID","WM_TRANSIENT_FOR")
            trans_match=re.search(
                r"WM_TRANSIENT_FOR[^\n]*=\s*window id #\s*(0x[0-9a-fA-F]+)",props)
            name_match=re.search(r'^WM_NAME[^\n]*=\s*"([^"]*)"',props,re.M)
            pid_match=re.search(r"_NET_WM_PID[^\n]*=\s*(\d+)",props)
            entries.append({
                "id":wid,"parent":_window_id(parent_match.group(1)),
                "transient":_window_id(trans_match.group(1)) if trans_match else None,
                "name":name_match.group(1) if name_match else None,
                "class_ok":bool(re.search(r'^WM_CLASS[^\n]*=\s*"wechat",\s*"wechat"',props,re.M)),
                "pid":pid_match.group(1) if pid_match else None,
            })
        check_inventory(entries,root,pid)
        from atspi_backend import Atspi
        desktop=Atspi.get_desktop(0)
        apps=[]
        for i in range(desktop.get_child_count()):
            a=desktop.get_child_at_index(i)
            if a and str(a.get_process_id())==pid:apps.append(a)
        if len(apps)!=1:
            raise UIBlocked("ATSPI_WECHAT_APP_NOT_UNIQUE")
        check_atspi_roots(apps[0],pid)
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("WECHAT_MODAL_GUARD_UNAVAILABLE")
    return True


def assert_key_only_to_created_popup(*, popup_proof=None):
    """Reject ALL generic/main-window keys until an own-click popup is proved.

    Ordinary engine code has no popup_proof and must fail closed. A future
    dedicated dialog workflow may submit a proof only after that SAME process
    recorded a preceding click plus unique newly-created separate X window,
    its current WeChat PID/WM_TRANSIENT_FOR, fresh AT-SPI sibling root,
    and verified X input focus on the popup (never main).
    The research engine intentionally does not mint such proofs yet.
    """
    if popup_proof is None:
        raise UIBlocked("MAIN_WINDOW_KEY_FORBIDDEN")
    # No currently admitted producer for the proof. Do not make a string,
    # boolean, or caller-constructed token an authorization bypass.
    raise UIBlocked("POPUP_OWN_CLICK_PROVENANCE_UNAVAILABLE")
