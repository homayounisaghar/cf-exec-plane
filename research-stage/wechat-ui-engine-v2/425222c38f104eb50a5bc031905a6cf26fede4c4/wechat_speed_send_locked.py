"""Owner-scoped EXACT three-message send, exclusive flock, no main-window keys.

No clipboard, keyboard, fallback typing, Enter/Space, or file/sticker selection.
EditableText.set_text_contents called AT MOST ONCE per authorized draft.
The single Send button uses the shared hover-verified X11 pointer primitive.
One irreversible sha256(text) marker is fsynced BEFORE each send click.
All content is private to the owner's runtime input, never shipped in public.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import sys
import time

from engine import TARGETS,UIBlocked
from atspi_backend import AtspiBackend
import benchmark_gate_f_readsafe as f
from gate_h_send_once import _messages_snapshot,_send_button
from pointer_mapping import hover_target,click_once
from wechat_live_lock import WeChatLiveLock,require_wechat_lock
from x11_modal_guard import assert_no_wechat_modal

EXPECTED_TARGET_SHA="fb68dd9d1dbf7e7b38b2c7b0c345478864addc10cb9c32e7050e4930b0772b6c"
EXPECTED_TEXT_HASHES=(
    "4c39630925bcb6c760990d7d105b201ee13792133d8fc34be6ef5fa6a2404aca",
    "cbb21d950d661211f47ad2ebbe426c41f217182b705d95524f28db083388006b",
    "0e7edf6fb00bab42c64a6fcf49e8335edc7b2490984151d0cc0d8042a9324f3f",
)
PERMANENT_DIR=Path.home()/".local/state/wechat-speed-send"
WAIT_BETWEEN_SENDS=5.1
MIN_VISIBLE_ITEMS=8
TAIL_K=5

def _exact_bytes(left,right):
    return (type(left) is bytes and type(right) is bytes and
            len(left)==len(right) and
            hmac.compare_digest(hashlib.sha256(left).digest(),
                                hashlib.sha256(right).digest()))

def _load_three():
    if (os.getuid()!=1000 or os.getenv("WX_SPEED_SEND_AUTH")!="1" or
            os.getenv("WX_GATE_H_SEND_ONCE") or os.getenv("WX_GATE_H_TEXT") or
            not f.TARGET or
            hashlib.sha256(f.TARGET.encode("utf8")).hexdigest()!=EXPECTED_TARGET_SHA or
            os.getenv("WX_SPEED_TARGET_SHA256")!=EXPECTED_TARGET_SHA):
        raise UIBlocked("SPEED_OWNER_OR_RECIPIENT_GUARD")
    raw=os.environ.get("WX_SPEED_TEXTS_B64","")
    if not raw or len(raw)>4096:
        raise UIBlocked("SPEED_TEXTS_MISSING_OR_OVERSIZE")
    try:
        data=base64.b64decode(raw,validate=True)
        msgs=json.loads(data.decode("utf8"))
    except Exception:
        raise UIBlocked("SPEED_TEXT_DECODING_FAILED")
    if not isinstance(msgs,list) or len(msgs)!=3 or any(type(m) is not str for m in msgs):
        raise UIBlocked("SPEED_TEXT_COUNT_INVALID")
    if len(set(msgs))!=3:
        raise UIBlocked("SPEED_TEXT_DUPLICATE")
    for i,msg in enumerate(msgs):
        encoded=msg.encode("utf8")
        if (not encoded or len(encoded)>1024 or msg!=msg.strip() or
                hashlib.sha256(encoded).hexdigest()!=EXPECTED_TEXT_HASHES[i]):
            raise UIBlocked("SPEED_TEXT_"+str(i+1)+"_NOT_AUTHORIZED")
    return msgs

def _mark_path(body,*,root=PERMANENT_DIR):
    return root/(hashlib.sha256(body).hexdigest()+".attempt")

def _marker_already_exists(body,*,root=PERMANENT_DIR):
    path=_mark_path(body,root=root)
    return path.exists() or path.is_symlink()

def _claim_send(body,*,root=PERMANENT_DIR):
    """Irreversible owner-only O_EXCL marker before the ONLY Send click."""
    require_wechat_lock()
    if hashlib.sha256(body).hexdigest() not in EXPECTED_TEXT_HASHES:
        raise UIBlocked("SEND_TEXT_DIGEST_UNAUTHORIZED")
    root=Path(root)
    try:
        root.mkdir(mode=0o700,parents=True,exist_ok=True)
        r=root.lstat()
    except OSError:
        raise UIBlocked("SEND_MARKER_DIRECTORY_UNAVAILABLE")
    if (not stat.S_ISDIR(r.st_mode) or r.st_uid!=os.getuid() or
            r.st_mode & 0o077):
        raise UIBlocked("SEND_MARKER_DIRECTORY_UNSAFE")
    target=_mark_path(body,root=root)
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0)
    try:
        fd=os.open(target,flags,0o600)
    except FileExistsError:
        raise UIBlocked("SEND_TEXT_ALREADY_ATTEMPTED_NO_RETRY")
    except OSError:
        raise UIBlocked("SEND_MARKER_CREATION_FAILED")
    try:
        with os.fdopen(fd,"wb") as dest:
            dest.write(b"ATTEMPTED_NO_RETRY\n")
            dest.flush()
            os.fsync(dest.fileno())
        dfd=os.open(root,os.O_RDONLY)
        try:os.fsync(dfd)
        finally:os.close(dfd)
    except Exception:
        # Never remove a possibly committed marker, even on fsync failure.
        raise UIBlocked("SEND_MARKER_DURABILITY_UNKNOWN")
    return True

def _header_selected(snap, target):
    """Prove the header LABEL in message pane, not merely selected sidebar row."""
    headers=[n for n in snap.nodes if n.role.casefold()=="label"
             and n.visible() and n.rect and n.name==target and
             n.rect.x>552 and 160<n.rect.y<241]
    # Qt mirrors a label as container+inner label with identical geometry;
    # accept that pair only if their paths nest.
    if not headers or len(headers)>2:
        raise UIBlocked("CHAT_HEADER_NOT_EXACT_TARGET")
    rects={(n.rect.x,n.rect.y,n.rect.w,n.rect.h) for n in headers}
    if len(rects)!=1 or any(
          not (len(a.path)<=len(b.path) and b.path[:len(a.path)]==a.path or
               len(b.path)<=len(a.path) and a.path[:len(b.path)]==b.path)
          for a in headers for b in headers):
        raise UIBlocked("CHAT_HEADER_AMBIGUOUS")
    selected=[n for n in snap.nodes if n.role.casefold() in ("list item","list-item")
              and n.visible() and "selected" in n.states and
              n.name.split("\n",1)[0]==target]
    if len(selected)!=1:
        raise UIBlocked("RECIPIENT_ROW_NOT_SELECTED")
    return True

def _editor_node(snap):
    search={f._norm_label(x) for x in TARGETS["search_box"].labels}
    editors=[n for n in snap.nodes if n.role.casefold()=="text"
             and "editable" in n.states and n.visible() and
             f._norm_label(n.name) not in search]
    if len(editors)!=1:
        raise UIBlocked("EXACT_COMPOSER_NOT_UNIQUE")
    return editors[0]

def _read_editor(backend,editor):
    acc=backend._find(editor)
    txt=acc.get_text_iface()
    if txt is None:
        raise UIBlocked("COMPOSER_TEXT_INTERFACE_MISSING")
    n=txt.get_character_count()
    if n<0 or n>3000:
        raise UIBlocked("COMPOSER_TEXT_LENGTH_INVALID")
    if not n:
        return b""
    # GI Accessible.get_text(self) shadows Text.get_text(start,end) in
    # this Qt build. Call the declared Atspi.Text interface explicitly.
    from atspi_backend import Atspi
    value=Atspi.Text.get_text(txt,0,n)
    if not isinstance(value,str):
        raise UIBlocked("EDITOR_TEXT_RANGE_NOT_STRING")
    return value.encode("utf8")

def _tail_sequence(snap, k=TAIL_K):
    """Copy last K VISIBLE chronological Qt rows, not total chat history.

    Bodies are kept in memory only. Absolute paths, row counts and Qt
    accessibility identity are not stable across viewport virtualization.
    """
    if not isinstance(k,int) or k<2 or k>20:
        raise UIBlocked("TAIL_K_INVALID")
    labels={f._norm_label(x) for x in TARGETS["messages_container"].labels}
    roots=[n for n in snap.nodes if n.role.casefold()=="list" and n.visible()
           and f._norm_label(n.name) in labels]
    if len(roots)!=1:
        raise UIBlocked("TAIL_MESSAGE_LIST_NOT_UNIQUE")
    root=roots[0]
    rows=[n for n in snap.nodes if n.role.casefold() in ("list item","list-item")
          and n.visible() and n.rect and n.rect.w>0 and n.rect.h>0
          and len(n.path)==len(root.path)+1
          and n.path[:len(root.path)]==root.path]
    rows.sort(key=lambda n:(n.rect.y+n.rect.h,n.path))
    if len(rows)<k or any(not n.name for n in rows[-k:]):
        raise UIBlocked("TAIL_NOT_ENOUGH_READABLE_ROWS")
    return tuple(n.name.encode("utf8") for n in rows[-k:])


def _tail_shift_matches(before,after,body):
    """New visible tail equals old tail shifted by one and exact sent body."""
    return (type(before) is tuple and type(after) is tuple
            and len(before)>=2 and len(before)==len(after)
            and type(body) is bytes and bool(body)
            and all(type(v) is bytes and bool(v) for v in before+after)
            and after==before[1:]+(body,))


def _evidence_ok(latest):
    return all(latest.get(k) is True for k in (
        "empty","disabled","selected","header","tail_shift_match","last_exact"))


def _pre_state(backend,snap,target,before_count=None,*,resume_body=None):
    require_wechat_lock()
    assert_no_wechat_modal()
    state=f._ui_state(snap)
    if not all(state.get(k) is True for k in (
            "main_frame_unique","selected_expected","chat_pane_open",
            "message_input_visible","send_button_visible","composer_toolbar_visible")):
        raise UIBlocked("MOE_UI_STRUCTURE_CHANGED")
    _header_selected(snap,target)
    editor=_editor_node(snap)
    existing=_read_editor(backend,editor)
    resumed=False
    if existing==b"" and state["send_button_enabled"] is False:
        pass
    elif (resume_body is not None and _exact_bytes(existing,resume_body)
          and state["send_button_enabled"] is True):
        # Never write an already EXACT unsent first draft a second time.
        resumed=True
    else:
        raise UIBlocked("PREVIOUS_DRAFT_OR_SEND_STILL_ENABLED")
    count,identity,last=_messages_snapshot(snap)
    if count<MIN_VISIBLE_ITEMS or last is None:
        raise UIBlocked("MESSAGE_BASELINE_INVALID")
    tail=_tail_sequence(snap)
    # Earlier count is informational: Qt may recycle visible rows 9 -> 8.
    return editor,count,identity,resumed,tail

def _insert_once(backend,editor,body):
    """Only one EditableText mutation; no keyboard fallback."""
    require_wechat_lock()
    acc=backend._find(editor)
    edit=acc.get_editable_text_iface()
    if edit is None:
        raise UIBlocked("EDITABLE_TEXT_NOT_AVAILABLE")
    # Qt can report False after mutating. Never replay; read back exactly.
    try:
        edit.set_text_contents(body.decode("utf8"))
    except Exception:
        pass
    return True

def _draft_verified(backend,editor,body,target):
    require_wechat_lock()
    assert_no_wechat_modal()
    # Targeted fresh node checks: no full-tree read on the hot path.
    actual=_read_editor(backend,editor)
    if not _exact_bytes(actual,body):
        raise UIBlocked("DRAFT_BYTE_EXACT_NOT_VERIFIED")
    acc=backend._find(editor)
    if acc.get_text_iface().get_character_count()!=len(body.decode("utf8")):
        raise UIBlocked("DRAFT_CHARACTER_COUNT_CHANGED")
    # Recipient identity is independently re-proved from the cached header
    # via fresh root snapshot immediately BEFORE click below.
    return True

def _wait_post_send(backend,target,before_count,before_tail,body,timeout=5.0):
    started=time.monotonic()
    deadline=started+timeout
    latest={}
    while True:
        assert_no_wechat_modal()
        snap=backend.snapshot()
        state=f._ui_state(snap)
        count,identity,last=_messages_snapshot(snap)
        editor=_editor_node(snap)
        empty=_read_editor(backend,editor)==b""
        disabled=state["send_button_enabled"] is False
        selected=state["selected_expected"] is True
        header=False
        try:header=_header_selected(snap,target)
        except UIBlocked:pass
        last_exact=bool(last and _exact_bytes(last.name.encode("utf8"),body))
        try:
            post_tail=_tail_sequence(snap,k=len(before_tail))
            tail_shift_match=_tail_shift_matches(before_tail,post_tail,body)
        except UIBlocked:
            tail_shift_match=False
        latest={"count":count,"count_delta":count-before_count,
                "empty":empty,"disabled":disabled,"selected":selected,
                "header":header,"tail_shift_match":tail_shift_match,
                "new_last":tail_shift_match,"last_exact":last_exact}
        if _evidence_ok(latest):
            return latest,round((time.monotonic()-started)*1000)
        if time.monotonic()>=deadline:
            return latest,round((time.monotonic()-started)*1000)
        backend.wait_change(min(.12,max(0.0,deadline-time.monotonic())))

def _run_one(backend,target,body,index,before_count):
    """One irreversible independent message sub-run, under SAME process lock."""
    require_wechat_lock()
    phase={"focus_ms":None,"type_ms":None,"verify_draft_ms":None,
           "draft_total_ms":None,"click_ms":None,"verify_sent_ms":None}
    begin=time.monotonic()
    snap=backend.snapshot()
    allow_resume=(index==1 and os.getenv("WX_SPEED_RESUME_UNSENT_FIRST")=="1")
    editor,count,identity,resumed,tail=_pre_state(
        backend,snap,target,before_count,
        resume_body=body if allow_resume else None)
    print("SPEED_SUBRUN index="+str(index)+" baseline_messages="+str(count)+
          " lock_held=True eligible=True resumed_exact_draft="+
          str(resumed),flush=True)
    if _marker_already_exists(body):
        if resumed:
            # A present lockout plus nonempty draft is ambiguous; do not
            # silently skip and proceed to another text.
            raise UIBlocked("ALREADY_ATTEMPTED_WITH_NONEMPTY_DRAFT")
        print("SPEED_SUBRUN_SKIPPED index="+str(index)+
              " reason=PERMANENT_TEXT_MARKER_EXISTS no_send=True",flush=True)
        return count,"SKIPPED_LOCKOUT",None

    if not resumed:
        t=time.monotonic()
        # Direct AT-SPI focus, never any main-window key.
        if not backend.focus(editor):
            raise UIBlocked("EDIT_FOCUS_FAILED")
        fresh=backend._find(editor)
        if "focused" not in backend._states(fresh):
            raise UIBlocked("EDIT_FOCUS_UNVERIFIED")
        phase["focus_ms"]=round((time.monotonic()-t)*1000)

        t=time.monotonic()
        _insert_once(backend,editor,body)  # at most ONE text mutation
        phase["type_ms"]=round((time.monotonic()-t)*1000)
    else:
        # No focus/type mutation to this already exact verified first draft.
        phase["focus_ms"]=0
        phase["type_ms"]=0
    t=time.monotonic()
    _draft_verified(backend,editor,body,target)
    phase["verify_draft_ms"]=round((time.monotonic()-t)*1000)
    phase["draft_total_ms"]=round((time.monotonic()-begin)*1000)
    print("SPEED_DRAFT index="+str(index)+" focus_ms="+str(phase["focus_ms"])+
          " type_ms="+str(phase["type_ms"])+" verify_draft_ms="+
          str(phase["verify_draft_ms"])+" draft_total_ms="+
          str(phase["draft_total_ms"])+" resumed="+str(resumed)+
          " target_met="+
          str(phase["draft_total_ms"]<=3000),flush=True)

    # Separate fresh snapshot before Send: exact recipient header and exact
    # UTF-8 composer body MUST hold, count must be unchanged, no extra window.
    snap=backend.snapshot()
    assert_no_wechat_modal()
    _header_selected(snap,target)
    send=_send_button(snap)    # enabled, uniquely inside composer toolbar
    latest_editor=_editor_node(snap)
    if not _exact_bytes(_read_editor(backend,latest_editor),body):
        raise UIBlocked("SEND_PREFLIGHT_BYTE_EXACT_MISMATCH")
    fresh_count,fresh_identity,_=_messages_snapshot(snap)
    if _tail_sequence(snap)!=tail:
        raise UIBlocked("SEND_PREFLIGHT_TAIL_CHANGED")
    require_wechat_lock()
    point=hover_target(backend,send,snap=snap,allow_descendant=False,
                       label="SPEED_SEND_VERIFIED_POINTER")
    # Hover could create a popup and disable Send. Re-prove no modal, target
    # and exact draft immediately after hover; never click if uncertain.
    assert_no_wechat_modal()
    if not _exact_bytes(_read_editor(backend,latest_editor),body):
        raise UIBlocked("SEND_DRAFT_CHANGED_AFTER_HOVER")
    _header_selected(backend.snapshot(),target)
    require_wechat_lock()
    _claim_send(body)          # durable permanent marker BEFORE ONE click
    print("SPEED_SEND_ATTEMPT index="+str(index)+" marker_written=True"+
          " physical_x="+str(point[1])+" physical_y="+str(point[2]),flush=True)
    t=time.monotonic()
    try:
        click_once(point)
    except Exception:
        print("SPEED_SEND_IN_DOUBT index="+str(index)+
              " click_may_have_occurred=True no_retry=True",flush=True)
        raise
    phase["click_ms"]=round((time.monotonic()-t)*1000)
    latest,verify_ms=_wait_post_send(backend,target,count,tail,body)
    phase["verify_sent_ms"]=verify_ms
    print("SPEED_SENT_EVIDENCE index="+str(index)+" status="+
          ("SENT_UNVERIFIED" if _evidence_ok(latest) else "IN_DOUBT")+
          " before="+str(count)+" after="+str(latest["count"])+
          " exact_body="+str(latest["last_exact"])+
          " tail_shift_match="+str(latest["tail_shift_match"])+
          " editor_empty="+str(latest["empty"])+
          " send_disabled="+str(latest["disabled"])+
          " click_ms="+str(phase["click_ms"])+
          " verify_sent_ms="+str(phase["verify_sent_ms"]),flush=True)
    if not _evidence_ok(latest):
        raise UIBlocked("SEND_EVIDENCE_IN_DOUBT_NO_RETRY")
    return latest["count"],"SENT_UNVERIFIED",phase

def main():
    # Fail closed for any unexpected mode rather than acting on UI.
    try:
        texts=_load_three()
        with WeChatLiveLock() as lock:
            print("SPEED_LOCK status=HELD pid="+str(lock.info["pid"])+
                  " run_id="+lock.info["run_id"]+
                  " start_utc="+lock.info["started_at"]+
                  " reclaimed_stale="+str(lock.takeover_stale),flush=True)
            assert_no_wechat_modal()
            backend=AtspiBackend()
            base=None
            previous_sent=None
            for idx,text in enumerate(texts,1):
                if previous_sent is not None:
                    elapsed=time.monotonic()-previous_sent
                    delay=max(0.0,WAIT_BETWEEN_SENDS-elapsed)
                    if delay:
                        time.sleep(delay)
                before=time.monotonic()
                base,status,phase=_run_one(backend,f.TARGET,
                                            text.encode("utf8"),idx,base)
                if status=="SENT_UNVERIFIED":
                    previous_sent=time.monotonic()
                if status=="SKIPPED_LOCKOUT":
                    continue
            print("SPEED_FINAL status=COMPLETE messages="+str(base)+
                  " lock_held="+str(require_wechat_lock())+
                  " no_main_keys=True all_lockouts_preserved=True",flush=True)
        return 0
    except UIBlocked as err:
        print("SPEED_HARD_STOP code="+err.code+
              " no_retry=True no_send_fallback=True",flush=True)
        return 3
    except Exception as err:
        print("SPEED_HARD_STOP code=UNEXPECTED_"+type(err).__name__+
              " no_retry=True no_send_fallback=True",flush=True)
        return 3

if __name__=="__main__":
    sys.exit(main())
