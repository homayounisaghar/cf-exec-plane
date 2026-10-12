"""Gate H: owner-authorized ONE real text Send. UI transport, NOT native.
Imports the UNCHANGED Gate F clipboard/focus/readback helpers pinned in MANIFEST.
No Return. No retry. No text, contact, or clipboard values in stdout.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

import benchmark_gate_f_readsafe as f
from engine import Session, UIBlocked, TARGETS
from atspi_backend import AtspiBackend
from ui_primitives import UiPrimitives

_ACTIONS=frozenset(("click","press","activate","push","default"))
_OUTGOING=frozenset(("direction:outgoing","direction:outbound",
                     "message-direction:outgoing","outgoing:true"))


def _child(n, parent):
    return len(n.path)>len(parent.path) and n.path[:len(parent.path)]==parent.path


def _messages_snapshot(snap):
    labels={f._norm_label(s) for s in TARGETS["messages_container"].labels}
    lists=[n for n in snap.nodes if n.role.casefold()=="list" and n.visible()
           and f._norm_label(n.name) in labels]
    if len(lists)!=1:
        raise UIBlocked("MESSAGES_CONTAINER_NOT_UNIQUE")
    root=lists[0]
    items=[n for n in snap.nodes if len(n.path)==len(root.path)+1 and _child(n,root)
           and n.visible() and n.rect is not None]
    last=max(items,key=lambda n:(n.rect.y+n.rect.h,n.path),default=None)
    # Identity is ephemeral/in-memory; never emit the bubble name or hash.
    identity=(last.path,last.role,
              hashlib.sha256(last.name.encode("utf8")).digest()) if last else None
    return (len(items),identity,last)


def _new_last(before, after):
    return bool(after[2] is not None and after[1]!=before[1] and
                after[0]>=before[0])


def _send_button(snap):
    state=f._ui_state(snap)
    if not all(state[k] is True for k in (
            "main_frame_unique","selected_expected","chat_pane_open",
            "message_input_visible","composer_toolbar_visible",
            "send_button_visible","send_button_enabled")):
        raise UIBlocked("SEND_BUTTON_PRECONDITION")
    send_labels={f._norm_label(x) for x in TARGETS["send_button"].labels}
    candidates=[n for n in snap.nodes if n.role.casefold() in ("button","push button")
                and n.visible() and n.enabled() and
                f._norm_label(n.name) in send_labels]
    toolbar=[n for n in snap.nodes if n.role.casefold() in ("tool bar","toolbar")
             and n.visible() and any(_child(c,n) for c in candidates)]
    buttons=[c for c in candidates if len(toolbar)==1 and _child(c,toolbar[0])]
    if len(buttons)!=1 or buttons[0].rect is None:
        raise UIBlocked("SEND_BUTTON_NOT_UNIQUE")
    return buttons[0]


def _plan_activation(backend, button):
    """Plan one method before effects. Never call backend.activate (Return fallback)."""
    acc=backend._find(button)
    try:
        action=acc.get_action_iface()
        count=int(action.get_n_actions()) if action else 0
        matches=[i for i in range(count)
                 if str(action.get_localized_name(i) or "").casefold() in _ACTIONS]
    except Exception:
        action=None
        matches=[]
    if len(matches)>1:
        raise UIBlocked("SEND_ACTION_AMBIGUOUS")
    if len(matches)==1:
        return ("AT_SPI_ACTION",action,matches[0])
    # No action candidate: authorize EXACTLY ONE hit-tested primary click.
    rect=button.rect
    if not rect or rect.w<=0 or rect.h<=0:
        raise UIBlocked("SEND_RECT_UNAVAILABLE")
    x,y=rect.x+rect.w//2,rect.y+rect.h//2
    hit=backend.hit_test(x,y)
    if hit is None or not (hit.path==button.path or _child(hit,button)):
        raise UIBlocked("SEND_HIT_TEST_FAILED")
    return ("HIT_TEST_CLICK",x,y)


def _activate_once(plan):
    """Exactly one AT-SPI do_action OR xdotool click. False is ambiguous, no fallback."""
    if plan[0]=="AT_SPI_ACTION":
        return bool(plan[1].do_action(plan[2]))
    if plan[0]=="HIT_TEST_CLICK":
        result=subprocess.run(
            ("xdotool","mousemove",str(plan[1]),str(plan[2]),"click","1"),
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
            timeout=5,check=False)
        return result.returncode==0
    raise UIBlocked("SEND_ACTIVATION_METHOD_UNAVAILABLE")


def _journal_path(target, body, root=None):
    key=hashlib.sha256(("GATE_H_ONCE\x1f"+target+"\x1f"+body).encode("utf8")).hexdigest()
    base=Path(root) if root is not None else Path.home()/".local/state/wechat-gate-h"
    return base/(key+".attempt")


def _claim_once(target, body, root=None):
    """Irreversible local attempt marker is fsynced BEFORE a possible click."""
    path=_journal_path(target,body,root)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    st=path.parent.lstat()
    if not path.parent.is_dir() or path.parent.is_symlink() or st.st_uid!=os.getuid():
        raise UIBlocked("JOURNAL_DIRECTORY_UNSAFE")
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,"O_NOFOLLOW",0)
    try:
        fd=os.open(str(path),flags,0o600)
    except FileExistsError:
        raise UIBlocked("SEND_ALREADY_ATTEMPTED_NO_RETRY")
    except OSError:
        raise UIBlocked("JOURNAL_CLAIM_FAILED")
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(b"ATTEMPTED_NO_RETRY\n")
            stream.flush()
            os.fsync(stream.fileno())
        dfd=os.open(str(path.parent),os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        # The marker may exist. Never delete it or send after journal uncertainty.
        raise UIBlocked("JOURNAL_DURABILITY_UNVERIFIED")
    return True


def _message_evidence(backend, last, body):
    outgoing=False
    readable=False
    body_match=False
    if last is None:
        return outgoing,readable,body_match
    try:
        acc=backend._find(last)
        attrs=acc.get_attributes_as_array() or ()
        outgoing=any(str(a).casefold().replace(" ","") in _OUTGOING for a in attrs)
    except Exception:
        pass
    # Accept message text only if the exact single visible bubble label is legible.
    # All content stays memory-only, never stdout.
    try:
        if last.name:
            readable=True
            body_match=f.exact_utf8_sha_match(last.name.encode("utf8"),body)
    except Exception:
        readable=False
    return outgoing,readable,body_match


def _post_state(backend, snap, before, body):
    st=f._ui_state(snap)
    selected=st["selected_expected"] is True
    send_disabled=st["send_button_enabled"] is False
    composer_empty=False
    try:
        labels={f._norm_label(v) for v in TARGETS["search_box"].labels}
        editors=[n for n in snap.nodes if n.role.casefold()=="text" and n.visible()
                 and "editable" in n.states and f._norm_label(n.name) not in labels]
        if len(editors)==1:
            txt=backend._find(editors[0]).get_text_iface()
            composer_empty=(txt is not None and txt.get_character_count()==0)
    except Exception:
        pass
    new_last=False
    outgoing=False
    readable=False
    body_match=False
    try:
        after=_messages_snapshot(snap)
        new_last=_new_last(before,after)
        if new_last:
            outgoing,readable,body_match=_message_evidence(backend,after[2],body)
    except Exception:
        pass
    return dict(selected=selected,composer_empty=composer_empty,
                send_disabled=send_disabled,new_last=new_last,
                outgoing=outgoing,readable=readable,body_match=body_match)


def _verify_after_one_send(backend,before,body,seconds=10.0):
    """Bounded event wait. No post-send GUI cleanup and no second activation."""
    end=time.monotonic()+min(10.0,max(0.0,seconds))
    last=None
    while time.monotonic()<end:
        snap=backend.snapshot()
        last=_post_state(backend,snap,before,body)
        if all(last[k] for k in ("selected","composer_empty","send_disabled","new_last")):
            if not last["outgoing"]:
                return "SENT_UNVERIFIED","OUTGOING_DIRECTION_NOT_EXPOSED",last
            if last["readable"] and not last["body_match"]:
                return "SENT_UNVERIFIED","BUBBLE_CONTENT_HASH_MISMATCH",last
            return "SENT_VERIFIED","UI_OUTGOING_BUBBLE_VERIFIED",last
        remaining=end-time.monotonic()
        if remaining>0:
            backend.wait_change(min(1.2,remaining))
    missing=next((key for key in ("selected","composer_empty","send_disabled",
                                 "new_last") if not (last or {}).get(key)), "UNKNOWN")
    return "IN_DOUBT","POSTCONDITION_"+missing.upper()+"_UNVERIFIED",last or {}


def _preflight(backend,session,body):
    # Body is ALREADY UTF-8 bytes. Do not call .encode() on bytes.
    if not isinstance(body,bytes) or not body or body!=body.strip() or len(body)>1024:
        raise UIBlocked("MESSAGE_ARGUMENT_INVALID")
    # Owner's locally supplied digest pins EXACT authorized content, including
    # Persian punctuation/spacing; never log message bytes or expected digest.
    expected=os.environ.get("WX_GATE_H_EXPECTED_SHA256","")
    if len(expected)!=64 or any(c not in "0123456789abcdef" for c in expected):
        raise UIBlocked("MESSAGE_HASH_GUARD_MISSING")
    if hashlib.sha256(body).hexdigest()!=expected:
        raise UIBlocked("MESSAGE_EXACT_HASH_MISMATCH")
    if os.environ.get("WX_GATE_H_UNREAD_ZERO_VERIFIED")!="1":
        raise UIBlocked("EXTERNAL_UNREAD_ZERO_REQUIRED")
    if "--unread-zero-verified" not in sys.argv:
        raise UIBlocked("EXTERNAL_UNREAD_ZERO_REQUIRED")
    if session.selected_conversation_name()!=f.TARGET:
        raise UIBlocked("RECIPIENT_NOT_ALREADY_SELECTED")
    row=session.resolver.unique_conversation(f.TARGET)
    if "selected" not in row.states:
        raise UIBlocked("RECIPIENT_ROW_UNSELECTED")
    UiPrimitives(backend).require_no_modal()
    f.preflight(backend,session)  # focus-verified EMPTY and Send DISABLED
    snap=backend.snapshot()
    state=f._ui_state(snap)
    if not all(state[k] is True for k in (
            "selected_expected","chat_pane_open","message_input_visible",
            "composer_toolbar_visible","send_button_visible")) or \
       state["send_button_enabled"] is not False:
        raise UIBlocked("PRE_SEND_EMPTY_STATE_UNVERIFIED")
    return _messages_snapshot(snap)


def _draft_exact(backend,session,body):
    """UNCHANGED Gate F clipboard/focus/Ctrl+V/Ctrl+A/Ctrl+C/readback path."""
    attempted=False
    try:
        f.editor_focus(backend,session)
        f.clipboard_set(body)
        if not f.exact_utf8_sha_match(f.clipboard_get(),body):
            raise UIBlocked("DRAFT_CLIPBOARD_STAGING_FAILED")
        attempted=True
        f.keyboard("ctrl+v")
        backend.wait_change(1.5)
        if session.selected_conversation_name()!=f.TARGET or not f.send_enabled(session):
            raise UIBlocked("DRAFT_RECIPIENT_OR_SEND_UNVERIFIED")
        poison=("wx-gate-h-poison-"+os.urandom(12).hex()).encode("ascii")
        f.clipboard_set(poison)
        if not f.exact_utf8_sha_match(f.clipboard_get(),poison):
            raise UIBlocked("POISON_CLIPBOARD_STAGING_FAILED")
        f.editor_focus(backend,session)
        f.keyboard("ctrl+a")
        f.verify_copy_after_owner_event(body,lambda:f.keyboard("ctrl+c"))
        if session.selected_conversation_name()!=f.TARGET or not f.send_enabled(session):
            raise UIBlocked("DRAFT_POST_COPY_STATE_UNVERIFIED")
        return True
    except Exception:
        # Caller owns one-time cleanup ONLY BEFORE any Send activation.
        raise


def _emit(status,code,attempted,checks,start,clipboard_cleared):
    allowed=("selected","composer_empty","send_disabled","new_last",
             "outgoing","readable","body_match")
    fields=" ".join(k+"="+str(checks.get(k,"NA")) for k in allowed)
    print("GATE_H_RESULT status="+status+" code="+code+
          " send_attempts="+str(int(attempted))+
          " clipboard_cleared="+str(clipboard_cleared)+" "+fields+
          " elapsed_ms="+str(round((time.monotonic()-start)*1000)),flush=True)


def main():
    start=time.monotonic()
    status="SEND_NOT_ATTEMPTED"
    code="PRECONDITION_UNVERIFIED"
    attempted=False
    draft_started=False
    checks={}
    cleared=False
    backend=None
    session=None
    target=f.TARGET
    text=os.environ.get("WX_GATE_H_TEXT","")
    body=text.encode("utf8")
    try:
        if os.environ.get("WX_GATE_H_SEND_ONCE")!="1":
            raise UIBlocked("EXPLICIT_SEND_FLAG_REQUIRED")
        if not target or not text:
            raise UIBlocked("TARGET_OR_MESSAGE_MISSING")
        if _journal_path(target,text).exists():
            raise UIBlocked("SEND_ALREADY_ATTEMPTED_NO_RETRY")
        if not f.shutil_which("xclip") or not f.shutil_which("xdotool"):
            raise UIBlocked("CLIPBOARD_OR_KEY_TOOL_MISSING")
        backend=AtspiBackend()
        session=Session(backend)
        f.instrument_target_failures(session,backend)
        session.health()
        before=_preflight(backend,session,body)
        draft_started=True
        _draft_exact(backend,session,body)
        # Separate fresh message-list baseline and unique Send after exact readback.
        snap=backend.snapshot()
        if _messages_snapshot(snap)[:2]!=before[:2]:
            raise UIBlocked("MESSAGE_LIST_CHANGED_BEFORE_SEND")
        if session.selected_conversation_name()!=target:
            raise UIBlocked("RECIPIENT_CHANGED_BEFORE_SEND")
        UiPrimitives(backend).require_no_modal()
        button=_send_button(backend.snapshot())
        plan=_plan_activation(backend,button)
        # Last irreversible choice: durable journal BEFORE action.
        _claim_once(target,text)
        attempted=True
        try:
            acted=_activate_once(plan)
        except Exception:
            acted=False
        if not acted:
            status,code="IN_DOUBT","SINGLE_SEND_ACTION_RESULT_AMBIGUOUS"
        else:
            status,code,checks=_verify_after_one_send(backend,before,body,10.0)
    except UIBlocked as exc:
        # Codes are internal allowlisted IDs only, never raw user text.
        safe={
            "EXPLICIT_SEND_FLAG_REQUIRED","TARGET_OR_MESSAGE_MISSING",
            "SEND_ALREADY_ATTEMPTED_NO_RETRY","CLIPBOARD_OR_KEY_TOOL_MISSING",
            "EXTERNAL_UNREAD_ZERO_REQUIRED","RECIPIENT_NOT_ALREADY_SELECTED",
            "RECIPIENT_ROW_UNSELECTED","PRE_SEND_EMPTY_STATE_UNVERIFIED",
            "MESSAGE_ARGUMENT_INVALID","MESSAGE_HASH_GUARD_MISSING",
            "MESSAGE_EXACT_HASH_MISMATCH","MESSAGES_CONTAINER_NOT_UNIQUE",
            "DRAFT_CLIPBOARD_STAGING_FAILED","DRAFT_RECIPIENT_OR_SEND_UNVERIFIED",
            "POISON_CLIPBOARD_STAGING_FAILED","DRAFT_POST_COPY_STATE_UNVERIFIED",
            "MESSAGE_LIST_CHANGED_BEFORE_SEND","RECIPIENT_CHANGED_BEFORE_SEND",
            "SEND_BUTTON_PRECONDITION","SEND_BUTTON_NOT_UNIQUE",
            "SEND_ACTION_AMBIGUOUS","SEND_RECT_UNAVAILABLE",
            "SEND_HIT_TEST_FAILED","SEND_ACTIVATION_METHOD_UNAVAILABLE",
            "JOURNAL_DIRECTORY_UNSAFE","JOURNAL_CLAIM_FAILED",
            "JOURNAL_DURABILITY_UNVERIFIED","COMPOSER_EMPTY_UNVERIFIED",
        }
        code=exc.code if exc.code in safe else "PRECONDITION_OTHER_BLOCKED"
        status="IN_DOUBT" if attempted else "SEND_NOT_ATTEMPTED"
    except Exception:
        status="IN_DOUBT" if attempted else "SEND_NOT_ATTEMPTED"
        code="UNEXPECTED_ERROR"
    finally:
        if draft_started and not attempted:
            clean=False
            try:
                clean=f.cleanup_once(backend,session)
            except Exception:
                pass
            if not clean:
                status,code="IN_DOUBT","UNSENT_DRAFT_CLEANUP_UNVERIFIED"
        try:
            cleared=f.clipboard_clear()
        except Exception:
            cleared=False
        if not cleared:
            status,code="IN_DOUBT","CLIPBOARD_CLEAR_UNVERIFIED"
        _emit(status,code,attempted,checks,start,cleared)
    return 0 if status=="SENT_VERIFIED" else (2 if status=="SEND_NOT_ATTEMPTED" else 3)


if __name__=="__main__":
    sys.exit(main())
