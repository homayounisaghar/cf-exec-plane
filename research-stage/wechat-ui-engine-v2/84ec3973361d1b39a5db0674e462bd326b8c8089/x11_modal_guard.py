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


def assert_no_wechat_modal(*, expected_file_chooser=None):
    """Fail closed by default; one tightly scoped own-click chooser exception."""
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
                "viewable":"Map State: IsViewable" in info,
            })
        if expected_file_chooser is None:
            check_inventory(entries,root,pid)
        else:
            _check_expected_file_window(entries,root,pid,expected_file_chooser)
        from atspi_backend import Atspi
        desktop=Atspi.get_desktop(0)
        apps=[]
        for i in range(desktop.get_child_count()):
            a=desktop.get_child_at_index(i)
            if a and str(a.get_process_id())==pid:apps.append(a)
        if len(apps)!=1:
            raise UIBlocked("ATSPI_WECHAT_APP_NOT_UNIQUE")
        if expected_file_chooser is None:
            check_atspi_roots(apps[0],pid)
        else:
            _check_expected_file_root(apps[0],pid,expected_file_chooser)
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
    if type(popup_proof) is not ExpectedFileChooser or \
            popup_proof.key is not _FILE_SCOPE_SECRET:
        raise UIBlocked("POPUP_OWN_CLICK_PROVENANCE_UNAVAILABLE")
    if not focused_on_verified_popup(popup_proof):
        raise UIBlocked("POPUP_X_INPUT_FOCUS_UNVERIFIED")
    return True


# Expected file chooser is the ONE exception to the ordinary no-modal guard.
# Its lifetime is confined to the process in which the verified Send File
# control is clicked. It cannot be constructed from an environment flag.
_FILE_SCOPE_SECRET=object()
_FILE_WORDS=("open","file","choose","select","upload","打开","选择","文件","上传")
_BAD_WORDS=("log out","logout","clear chat","delete","quit","sign out")


class ExpectedFileChooser:
    __slots__=("key","issued_at","window_id","main_id","pid","title","opened_ms",
               "cancel_clicked","escape_attempted","closed")
    def __init__(self,secret):
        if secret is not _FILE_SCOPE_SECRET:
            raise UIBlocked("FILE_SCOPE_NOT_AUTHENTIC")
        self.key=secret
        self.issued_at=None
        self.window_id=None
        self.main_id=None
        self.pid=None
        self.title=None
        self.opened_ms=None
        self.cancel_clicked=False
        self.escape_attempted=False
        self.closed=False


def new_expected_file_chooser():
    """Only the own-click Send File harness may use this one-shot instance."""
    assert_no_wechat_modal()
    return ExpectedFileChooser(_FILE_SCOPE_SECRET)


def mark_expected_file_click(scope):
    if type(scope) is not ExpectedFileChooser or scope.key is not _FILE_SCOPE_SECRET \
            or scope.issued_at is not None:
        raise UIBlocked("FILE_SCOPE_ALREADY_USED_OR_INVALID")
    scope.issued_at=__import__("time").monotonic()


def _file_title(name):
    name=(name or "").casefold()
    return (bool(name) and any(k in name for k in _FILE_WORDS)
            and not any(k in name for k in _BAD_WORDS))


def _check_expected_file_window(entries,root,pid,scope):
    import time
    if type(scope) is not ExpectedFileChooser or scope.key is not _FILE_SCOPE_SECRET \
            or scope.issued_at is None or scope.closed:
        raise UIBlocked("FILE_SCOPE_NOT_ARMED")
    main=[e for e in entries if e["parent"]==root and e["name"]=="WeChat"
          and e["class_ok"] and e["pid"]==pid]
    if len(main)!=1:
        raise UIBlocked("FILE_SCOPE_MAIN_MISMATCH")
    wid=main[0]["id"]
    if scope.main_id is not None and (scope.main_id!=wid or scope.pid!=pid):
        raise UIBlocked("FILE_SCOPE_PID_OR_MAIN_CHANGED")
    scope.main_id=wid; scope.pid=pid
    extra=[e for e in entries if e["parent"]==root and e["id"]!=wid]
    trans=[e for e in entries if e["transient"] is not None and e["id"]!=wid]
    if not extra and not trans:
        if scope.window_id is not None:
            scope.closed=True  # Actual closure is verified separately.
        return None
    if len(extra)!=1 or len(trans)!=1 or trans[0]["id"]!=extra[0]["id"]:
        raise UIBlocked("FILE_SCOPE_UNEXPECTED_WINDOW")
    e=extra[0]
    if e["transient"]!=wid or e["pid"]!=pid or not e["class_ok"] or \
       not e.get("viewable") or not _file_title(e["name"]):
        raise UIBlocked("FILE_SCOPE_NOT_FILE_CHOOSER")
    if scope.window_id is None:
        dt=time.monotonic()-scope.issued_at
        if not 0<=dt<=3.0:
            raise UIBlocked("FILE_SCOPE_OPEN_AFTER_DEADLINE")
        scope.window_id=e["id"]
        scope.title=e["name"]
        scope.opened_ms=int(round(dt*1000))
    elif scope.window_id!=e["id"]:
        raise UIBlocked("FILE_SCOPE_WINDOW_CHANGED")
    return scope.window_id


def _check_expected_file_root(app,pid,scope):
    if type(scope) is not ExpectedFileChooser or scope.key is not _FILE_SCOPE_SECRET:
        raise UIBlocked("FILE_SCOPE_NOT_AUTHENTIC")
    try:
        if str(app.get_process_id())!=pid:
            raise UIBlocked("FILE_SCOPE_APP_PID_CHANGED")
        children=[app.get_child_at_index(i) for i in range(app.get_child_count())]
        if any(x is None for x in children):
            raise UIBlocked("FILE_SCOPE_ATSPI_ROOT_MISSING")
        main=[v for v in children if v.get_role_name().casefold() in ("frame","window")
              and (v.get_name() or "").casefold() in ("wechat","微信")]
        if len(main)!=1:
            raise UIBlocked("FILE_SCOPE_MAIN_ATSPI_MISMATCH")
        extra=[v for v in children if v!=main[0]]
        if scope.window_id is None:
            if extra:
                raise UIBlocked("FILE_SCOPE_UNEXPECTED_ATSPI_ROOT")
        else:
            # X11 may map a Qt dialog just before AT-SPI publishes its root.
            # A brief empty sibling set is allowed only inside the SAME 3s
            # owner-click window; never accept an unknown extra root.
            if not extra and __import__("time").monotonic()-scope.issued_at<=3.0:
                return False
            if len(extra)!=1 or extra[0].get_role_name().casefold() not in \
                 ("filler","frame","dialog","file chooser","window"):
                raise UIBlocked("FILE_SCOPE_EXTRA_ATSPI_ROOT_INVALID")
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("FILE_SCOPE_ATSPI_INSPECTION_UNAVAILABLE")
    return True


def focused_on_verified_popup(scope):
    """Read-only X input focus check, including child→parent traversal."""
    if type(scope) is not ExpectedFileChooser or scope.key is not _FILE_SCOPE_SECRET \
            or scope.window_id is None or scope.closed:
        raise UIBlocked("POPUP_NOT_OWN_CLICK_VERIFIED")
    assert_no_wechat_modal(expected_file_chooser=scope)
    focus=_window_id(_run("xdotool","getwindowfocus").strip())
    for _ in range(15):
        if focus==scope.window_id:
            return True
        if focus==scope.main_id:
            return False
        info=_run("xwininfo","-id",str(focus),"-tree")
        parent=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",info)
        if not parent:
            return False
        next_wid=_window_id(parent.group(1))
        if next_wid==focus:
            return False
        focus=next_wid
    return False
