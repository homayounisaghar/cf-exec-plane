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


def _transient_parent(props):
    """Xprop prints WM_TRANSIENT_FOR(WINDOW): window id # 0x... on Qt/X11.

    Accept both Xprop's colon and equals form. Do not guess the parent if
    the property is absent: an own-click popup needs a bounded verification.
    """
    m=re.search(
        r'^WM_TRANSIENT_FOR(?:\([^)]*\))?\s*[:=]\s*(?:window id #\s*)?(0x[0-9a-fA-F]+)\b',
        props,re.M)
    return _window_id(m.group(1)) if m else None


def _net_window_name(props):
    m=re.search(r'^_NET_WM_NAME[^\n]*=\s*"([^"]*)"',props,re.M)
    return m.group(1) if m else None


def _parse_x11_geometry(info):
    """Physical screen window x,y,w,h from ordinary xwininfo (not -tree)."""
    def grab(label):
        m=re.search(r"^\s*"+re.escape(label)+r":\s*(-?\d+)\s*$",info,re.M)
        if not m:
            raise UIBlocked("X11_GEOMETRY_UNVERIFIED")
        return int(m.group(1))
    return (grab("Absolute upper-left X"),grab("Absolute upper-left Y"),
            grab("Width"),grab("Height"))


def check_inventory(entries,root_id,expected_pid):
    """Pure validator: zero extra top-level or transient WeChat windows."""
    if not entries:
        raise UIBlocked("X11_WECHAT_MAIN_NOT_UNIQUE")
    # A hidden Qt popup retains its X ID. Ignore only *proved* unmapped
    # windows; a missing/unknown map state never counts as hidden.
    active=[e for e in entries if e.get("viewable",True)]
    roots=[e for e in active if e["parent"]==root_id]
    mains=[e for e in roots if e["name"]=="WeChat"
           and e["class_ok"] and e["pid"]==expected_pid]
    if len(mains)!=1:
        raise UIBlocked("X11_WECHAT_MAIN_NOT_UNIQUE")
    main=mains[0]["id"]
    for e in active:
        if e["transient"]==main:
            raise UIBlocked("X11_WECHAT_TRANSIENT_PRESENT")
        if e["parent"]==root_id and e["id"]!=main:
            raise UIBlocked("X11_WECHAT_EXTRA_TOPLEVEL")
    return main


def check_atspi_roots(app,pid,*,viewable_extras=None):
    """Only a VIEWABLE X11 extra can make a stale Qt popup root dangerous.

    Without an X11 inventory proof (viewable_extras=None), retain historical
    fail-closed behavior for callers and offline fixtures.
    """
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
        if any(v!=mains[0] for v in children) and viewable_extras!=0:
            # Qt may leave a stale filler sibling after hiding an unmapped
            # popup. Only ignore it after X11 proved zero VIEWABLE extras.
            raise UIBlocked("ATSPI_EXTRA_APPLICATION_ROOT")
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("ATSPI_ROOT_INSPECTION_UNAVAILABLE")
    return True


def _inspect_wechat_modal_once(*, expected_file_chooser=None,expected_sticker_popup=None):
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
        seen_at=__import__('time').monotonic()
        entries=[]
        for wid in ids:
            # -tree reports parent but omits Map State. NEVER mistake that
            # omission for an unmapped popup; ask ordinary xwininfo as well.
            tree_info=_run("xwininfo","-id",str(wid),"-tree")
            info=_run("xwininfo","-id",str(wid))
            map_match=re.search(r"Map State:\s*(IsViewable|IsUnMapped|IsUnviewable)",info)
            if not map_match:
                raise UIBlocked("X11_MAP_STATE_UNVERIFIED")
            viewable=(map_match.group(1)=="IsViewable")
            parent_match=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",tree_info)
            if not parent_match:raise UIBlocked("X11_PARENT_UNAVAILABLE")
            props=_run("xprop","-id",str(wid),
                       "WM_CLASS","WM_NAME","_NET_WM_NAME","_NET_WM_PID","WM_TRANSIENT_FOR")
            transient=_transient_parent(props)
            name_match=re.search(r'^WM_NAME[^\n]*=\s*"([^"]*)"',props,re.M)
            pid_match=re.search(r"_NET_WM_PID[^\n]*=\s*(\d+)",props)
            entries.append({
                "id":wid,"parent":_window_id(parent_match.group(1)),
                "transient":transient,
                "name":name_match.group(1) if name_match else None,
                "net_name":_net_window_name(props),
                "class_ok":bool(re.search(r'^WM_CLASS[^\n]*=\s*"wechat",\s*"wechat"',props,re.M)),
                "pid":pid_match.group(1) if pid_match else None,
                "viewable":viewable,
                "geometry":_parse_x11_geometry(info),
                "seen_at":seen_at,
                "class_present":bool(re.search(r'^WM_CLASS(?:\([^)]*\))?\s*[:=]',props,re.M)),
            })
        if expected_file_chooser is not None and expected_sticker_popup is not None:
            raise UIBlocked("TWO_POPUP_SCOPES_FORBIDDEN")
        if expected_file_chooser is not None:
            _check_expected_file_window(entries,root,pid,expected_file_chooser)
        elif expected_sticker_popup is not None:
            _check_expected_sticker_window(entries,root,pid,expected_sticker_popup)
        else:
            check_inventory(entries,root,pid)
        from atspi_backend import Atspi
        desktop=Atspi.get_desktop(0)
        apps=[]
        for i in range(desktop.get_child_count()):
            a=desktop.get_child_at_index(i)
            if a and str(a.get_process_id())==pid:apps.append(a)
        if len(apps)!=1:
            raise UIBlocked("ATSPI_WECHAT_APP_NOT_UNIQUE")
        if expected_file_chooser is not None:
            _check_expected_file_root(apps[0],pid,expected_file_chooser)
        elif expected_sticker_popup is not None:
            _check_expected_sticker_root(apps[0],pid,expected_sticker_popup)
        else:
            main_ids=[e["id"] for e in entries if
                e.get("viewable",True) and e["name"]=="WeChat" and
                e["class_ok"] and e["pid"]==pid and e["parent"]==root]
            visible_extras=sum(e.get("viewable",True) and
                e["id"] not in main_ids for e in entries)
            check_atspi_roots(apps[0],pid,viewable_extras=visible_extras)
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("WECHAT_MODAL_GUARD_UNAVAILABLE")
    return True


def assert_no_wechat_modal(*, expected_file_chooser=None,expected_sticker_popup=None):
    """Default: no extra windows. Scoped file metadata waits are READ-ONLY.

    After an explicitly armed Send File click, the single expected window
    might map before Qt sets WM_TRANSIENT_FOR or its name. Wait at most
    3 seconds from that click, and only for *incomplete* expected metadata;
    known wrong title, PID, class, or extra window always aborts immediately.
    """
    if expected_file_chooser is not None and expected_sticker_popup is not None:
        raise UIBlocked("TWO_POPUP_SCOPES_FORBIDDEN")
    if expected_file_chooser is None and expected_sticker_popup is None:
        return _inspect_wechat_modal_once()
    import time
    sticker=expected_sticker_popup is not None
    scope=expected_sticker_popup if sticker else expected_file_chooser
    if sticker:
        if (type(scope) is not ExpectedStickerPopup or
            scope.key is not _STICKER_SCOPE_KEY or scope.issued_at is None):
            raise UIBlocked("STICKER_SCOPE_NOT_ARMED")
        allowed={"STICKER_POPUP_OWNER_PROPERTY_PENDING",
                 "STICKER_EXPECTED_ATSPI_CONTENT_NOT_READY"}
        deadline_code="STICKER_SCOPE_METADATA_DEADLINE"
    else:
        if (type(scope) is not ExpectedFileChooser or
            scope.key is not _FILE_SCOPE_SECRET or scope.issued_at is None):
            raise UIBlocked("FILE_SCOPE_NOT_ARMED")
        allowed={"FILE_SCOPE_EXPECTED_WINDOW_NOT_READY",
                 "FILE_SCOPE_EXPECTED_ATSPI_NOT_READY"}
        deadline_code="FILE_SCOPE_METADATA_DEADLINE_EXCEEDED"
    deadline=scope.issued_at+3.0
    while True:
        try:
            return _inspect_wechat_modal_once(
                expected_file_chooser=None if sticker else scope,
                expected_sticker_popup=scope if sticker else None)
        except UIBlocked as e:
            if scope.window_id is not None or e.code not in allowed:
                raise
            now=time.monotonic()
            if now>=deadline:
                raise UIBlocked(deadline_code)
            time.sleep(min(.07,deadline-now))


def assert_key_only_to_created_popup(*, popup_proof=None):
    """Reject ALL generic/main-window keys until an own-click popup is proved.

    Ordinary engine code has no popup_proof and must fail closed. A future
    dedicated dialog workflow may submit a proof only after that SAME process
    recorded a preceding click plus unique newly-created separate X window,
    its current WeChat PID/WM_TRANSIENT_FOR, fresh AT-SPI sibling root,
    and verified X input focus on the popup (never main).
    The research engine intentionally does not mint such proofs yet.
    """
    from wechat_live_lock import require_wechat_lock
    require_wechat_lock()
    if popup_proof is None:
        raise UIBlocked("MAIN_WINDOW_KEY_FORBIDDEN")
    if not ((type(popup_proof) is ExpectedFileChooser and
             popup_proof.key is _FILE_SCOPE_SECRET) or
            (type(popup_proof) is ExpectedStickerPopup and
             popup_proof.key is _STICKER_SCOPE_KEY)):
        raise UIBlocked("POPUP_OWN_CLICK_PROVENANCE_UNAVAILABLE")
    if not focused_on_verified_popup(popup_proof):
        raise UIBlocked("POPUP_X_INPUT_FOCUS_UNVERIFIED")
    return True


# Expected file chooser is the ONE exception to the ordinary no-modal guard.
# Its lifetime is confined to the process in which the verified Send File
# control is clicked. It cannot be constructed from an environment flag.
_FILE_SCOPE_SECRET=object()
_FILE_CHOOSER_TITLE="Select File"


class ExpectedFileChooser:
    __slots__=("key","issued_at","window_id","main_id","pid","title","opened_ms",
               "cancel_clicked","escape_attempted","closed","source_point")
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
        self.source_point=None


def new_expected_file_chooser():
    """Only the own-click Send File harness may use this one-shot instance."""
    assert_no_wechat_modal()
    return ExpectedFileChooser(_FILE_SCOPE_SECRET)


def mark_expected_file_click(scope,physical_point=None):
    if type(scope) is not ExpectedFileChooser or scope.key is not _FILE_SCOPE_SECRET \
            or scope.issued_at is not None:
        raise UIBlocked("FILE_SCOPE_ALREADY_USED_OR_INVALID")
    if physical_point is not None:
        if not (isinstance(physical_point,tuple) and len(physical_point)==2 and
                all(type(v) is int for v in physical_point)):
            raise UIBlocked("FILE_SCOPE_POINT_INVALID")
        scope.source_point=physical_point
    scope.issued_at=__import__("time").monotonic()


def _file_title(name):
    """This one admitted test opens exactly 'Select File', not any file-ish UI."""
    return isinstance(name,str) and name.casefold()==_FILE_CHOOSER_TITLE.casefold()


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
    extra=[e for e in entries if e.get("viewable",True) and e["parent"]==root and e["id"]!=wid]
    trans=[e for e in entries if e.get("viewable",True) and e["transient"] is not None and e["id"]!=wid]
    if not extra and not trans:
        if scope.window_id is not None:
            scope.closed=True  # Actual closure is verified separately.
        return None
    if len(extra)!=1 or len(trans)>1 or (trans and trans[0]["id"]!=extra[0]["id"]):
        raise UIBlocked("FILE_SCOPE_UNEXPECTED_WINDOW")
    e=extra[0]
    if scope.window_id is not None and scope.window_id!=e["id"]:
        raise UIBlocked("FILE_SCOPE_WINDOW_CHANGED")
    # A known WRONG identity is never eligible for a readiness wait.
    if e["pid"] is not None and e["pid"]!=pid:
        raise UIBlocked("FILE_SCOPE_NOT_FILE_CHOOSER")
    if e.get("class_present",True) and not e["class_ok"]:
        raise UIBlocked("FILE_SCOPE_NOT_FILE_CHOOSER")
    if e["name"] not in (None,"") and not _file_title(e["name"]):
        raise UIBlocked("FILE_SCOPE_NOT_FILE_CHOOSER")
    if e["transient"] is not None and e["transient"]!=wid:
        raise UIBlocked("FILE_SCOPE_NOT_FILE_CHOOSER")
    # Discovery is timestamped at X11 window enumeration, not only after
    # slow property/AT-SPI probes have completed.
    observed=e.get("seen_at",time.monotonic())
    if scope.window_id is None and not 0<=observed-scope.issued_at<=3.0:
        raise UIBlocked("FILE_SCOPE_OPEN_AFTER_DEADLINE")
    if (e["transient"]!=wid or e["pid"]!=pid or not e["class_ok"] or
        not e.get("viewable") or not _file_title(e["name"])):
        raise UIBlocked("FILE_SCOPE_EXPECTED_WINDOW_NOT_READY")
    if scope.source_point is not None and not _file_geometry(e.get("geometry"),scope.source_point):
        raise UIBlocked("FILE_SCOPE_GEOMETRY_MISMATCH")
    if scope.window_id is None:
        dt=observed-scope.issued_at
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
            if len(extra)!=1:
                raise UIBlocked("FILE_SCOPE_EXTRA_ATSPI_ROOT_INVALID")
            role=(extra[0].get_role_name() or "").casefold()
            name=extra[0].get_name() or ""
            if role=="dialog" and _file_title(name):
                return True
            if not name and __import__("time").monotonic()-scope.issued_at<=3.0:
                raise UIBlocked("FILE_SCOPE_EXPECTED_ATSPI_NOT_READY")
            raise UIBlocked("FILE_SCOPE_EXTRA_ATSPI_ROOT_INVALID")
    except UIBlocked:
        raise
    except Exception:
        raise UIBlocked("FILE_SCOPE_ATSPI_INSPECTION_UNAVAILABLE")
    return True



# Separate Qt sticker utility popup is owned by this app's unmapped, 1x1
# X11 anchor window (historically 0x400009), rather than the mapped main frame.
# It is NOT a general exemption: exact own-click + popup X fingerprint + fully
# verified hidden owner proxy + sticker-only AT-SPI content all required.
_STICKER_SCOPE_KEY=object()


class ExpectedStickerPopup:
    __slots__=("key","issued_at","window_id","main_id","pid","opened_ms",
               "source_point","proxy_id","escape_attempted","toggle_clicked","closed")
    def __init__(self,secret):
        if secret is not _STICKER_SCOPE_KEY:
            raise UIBlocked("STICKER_SCOPE_NOT_AUTHENTIC")
        self.key=secret
        self.issued_at=None
        self.window_id=None
        self.main_id=None
        self.pid=None
        self.opened_ms=None
        self.source_point=None
        self.proxy_id=None
        self.escape_attempted=False
        self.toggle_clicked=False
        self.closed=False


def new_expected_sticker_popup():
    assert_no_wechat_modal()
    return ExpectedStickerPopup(_STICKER_SCOPE_KEY)


def mark_expected_sticker_click(scope,physical_point):
    if (type(scope) is not ExpectedStickerPopup or
        scope.key is not _STICKER_SCOPE_KEY or scope.issued_at is not None or
        not isinstance(physical_point,tuple) or len(physical_point)!=2 or
        not all(type(v) is int for v in physical_point)):
        raise UIBlocked("STICKER_SCOPE_INVALID_OR_REUSED")
    import time
    scope.source_point=physical_point
    scope.issued_at=time.monotonic()


def _qt_hidden_owner_proxy(wid,root,main_id):
    """Verify an X11/Qt *unmapped* 1x1 proxy of the same X client, never guess."""
    if not wid or wid==main_id or (wid>>20)!=(main_id>>20):
        return False
    try:
        state=_run("xwininfo","-id",str(wid))
        tree=_run("xwininfo","-id",str(wid),"-tree")
        props=_run("xprop","-id",str(wid),"WM_NAME","WM_CLASS","_NET_WM_PID")
        parent=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",tree)
        properties=[line.strip() for line in props.splitlines()]
        own_name=any(line.startswith("WM_NAME(") and
                     line.rsplit("=",1)[-1].strip()=='"wechat"'
                     for line in properties)
        owns_pid=any(line.startswith("_NET_WM_PID(") and
                     line.rsplit("=",1)[-1].strip().isdigit()
                     for line in properties)
        own_class=any(line.startswith("WM_CLASS(") and
                      line.rsplit("=",1)[-1].strip().startswith('"')
                      for line in properties)
        return (parent is not None and _window_id(parent.group(1))==root and
                "Map State: IsUnMapped" in state and
                _parse_x11_geometry(state)==(0,0,1,1) and
                own_name and not owns_pid and not own_class)
    except (UIBlocked,Exception):
        return False


def _sticker_geometry(geometry,physical_point):
    if not geometry or physical_point is None:
        return False
    x,y,w,h=geometry
    cx,cy=physical_point
    return (350<=w<=650 and 350<=h<=650 and
            x<=cx<=x+w and 0<=cy-(y+h)<=85)


def _file_geometry(geometry,physical_point):
    """Chooser near the clicked toolbar, while exact title and PID stay primary."""
    if not geometry or physical_point is None:return False
    x,y,w,h=geometry
    cx,cy=physical_point
    return (150<=w<=1600 and 120<=h<=1000 and
            abs(x+w/2-cx)<=700 and abs(y+h/2-cy)<=850)


def _check_expected_sticker_window(entries,root,pid,scope):
    import time
    if (type(scope) is not ExpectedStickerPopup or
        scope.key is not _STICKER_SCOPE_KEY or scope.issued_at is None or scope.closed):
        raise UIBlocked("STICKER_SCOPE_NOT_ARMED")
    active=[e for e in entries if e.get("viewable",True)]
    main=[e for e in active if e["parent"]==root and e["name"]=="WeChat"
          and e["class_ok"] and e["pid"]==pid]
    if len(main)!=1:raise UIBlocked("STICKER_MAIN_WINDOW_CHANGED")
    wid=main[0]["id"]
    if scope.main_id is not None and (scope.main_id!=wid or scope.pid!=pid):
        raise UIBlocked("STICKER_SCOPE_WECHAT_CHANGED")
    scope.main_id=wid
    scope.pid=pid
    extra=[e for e in active if e["id"]!=wid]
    if not extra:
        if scope.window_id is not None:scope.closed=True
        return None
    if len(extra)!=1:
        raise UIBlocked("STICKER_UNKNOWN_EXTRA_WINDOWS")
    e=extra[0]
    if scope.window_id is not None and scope.window_id!=e["id"]:
        raise UIBlocked("STICKER_POPUP_ID_CHANGED")
    if e["parent"]!=root or e["pid"]!=pid or not e["class_ok"]:
        raise UIBlocked("STICKER_POPUP_OWNER_UNVERIFIED")
    if e.get("name") not in (None,"","wechat"):
        raise UIBlocked("STICKER_UNEXPECTED_WINDOW_TITLE")
    if e.get("net_name") not in (None,"","wechat"):
        raise UIBlocked("STICKER_UNEXPECTED_NET_TITLE")
    if not _sticker_geometry(e.get("geometry"),scope.source_point):
        raise UIBlocked("STICKER_POPUP_GEOMETRY_MISMATCH")
    parent=e.get("transient")
    if parent is None:
        raise UIBlocked("STICKER_POPUP_OWNER_PROPERTY_PENDING")
    if parent!=wid and not _qt_hidden_owner_proxy(parent,root,wid):
        raise UIBlocked("STICKER_TRANSIENT_NOT_WECHAT_OWNER")
    observed=e.get("seen_at",time.monotonic())
    if scope.window_id is None and not 0<=observed-scope.issued_at<=3.0:
        raise UIBlocked("STICKER_POPUP_AFTER_3S")
    if scope.window_id is None:
        scope.window_id=e["id"]
        scope.proxy_id=parent if parent!=wid else None
        scope.opened_ms=int(round((observed-scope.issued_at)*1000))
    return e["id"]


def _check_expected_sticker_root(app,pid,scope):
    """Reject any unexpected confirmation, chooser or file-selection UI."""
    from atspi_backend import Atspi
    if str(app.get_process_id())!=str(pid):
        raise UIBlocked("STICKER_ATSPI_PID_CHANGED")
    roots=[app.get_child_at_index(i) for i in range(app.get_child_count())]
    main=[a for a in roots if a is not None and
          a.get_role_name().casefold() in ("frame","window") and
          (a.get_name() or "").casefold() in ("wechat","微信")]
    if len(main)!=1:raise UIBlocked("STICKER_ATSPI_MAIN_NOT_UNIQUE")
    others=[a for a in roots if a is not main[0]]
    if scope.window_id is None:
        if any((a.get_state_set().contains(Atspi.StateType.SHOWING)) for a in others):
            raise UIBlocked("STICKER_UNEXPECTED_ATSPI_ROOT")
        return False
    showing=[a for a in others if
             a.get_state_set().contains(Atspi.StateType.SHOWING)]
    if len(showing)!=1 or showing[0].get_role_name().casefold()!="filler":
        raise UIBlocked("STICKER_UNEXPECTED_ATSPI_ROOT")
    r=showing[0]
    buttons=set()
    expected=set()
    stack=[r]
    count=0
    danger={"ok","cancel","log out","logout","clear chat history","delete",
            "confirm","sign out","clear"}
    while stack and count<1050:
        n=stack.pop()
        if n is None:continue
        count+=1
        st=n.get_state_set()
        shown=st.contains(Atspi.StateType.SHOWING)
        role=(n.get_role_name() or "").casefold()
        name=n.get_name() or ""
        if shown and name.casefold() in danger:
            # In WeChat's native All Stickers grid, one legitimate 44x44
            # emoji tile has the accessible LABEL "OK". It is not a
            # confirmation BUTTON. Do not confuse a sticker's name with an
            # actionable message box. Only this geometrically proved tile
            # is exempt; any OK/Cancel button or other danger remains fatal.
            safe_ok_tile=False
            if (name=="OK" and role=="label" and
                    "All Stickers" in expected and "Smile" in expected):
                comp=n.get_component_iface()
                bounds=comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
                if bounds:
                    safe_ok_tile=(40<=bounds.width<=48 and
                                  40<=bounds.height<=48)
            if not safe_ok_tile:
                raise UIBlocked("STICKER_UNEXPECTED_CONFIRMATION")
        if shown and name in ("All Stickers","Smile"):
            expected.add(name)
        if shown and role=="button" and name:
            buttons.add(name)
        # Never stop checking visible names early. Confirmations or
        # irreversible controls may occur after the first sticker labels.
        for i in range(min(n.get_child_count(),100)-1,-1,-1):
            item=n.get_child_at_index(i)
            if item is not None:stack.append(item)
    if expected!={"All Stickers","Smile"}:
        raise UIBlocked("STICKER_EXPECTED_ATSPI_CONTENT_NOT_READY")
    return True


def focused_on_verified_popup(scope):
    """Read-only X input focus check, including child→parent traversal."""
    is_file=type(scope) is ExpectedFileChooser and scope.key is _FILE_SCOPE_SECRET
    is_sticker=type(scope) is ExpectedStickerPopup and scope.key is _STICKER_SCOPE_KEY
    if not (is_file or is_sticker) or scope.window_id is None or scope.closed:
        raise UIBlocked("POPUP_NOT_OWN_CLICK_VERIFIED")
    if is_file:
        assert_no_wechat_modal(expected_file_chooser=scope)
    else:
        assert_no_wechat_modal(expected_sticker_popup=scope)
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
