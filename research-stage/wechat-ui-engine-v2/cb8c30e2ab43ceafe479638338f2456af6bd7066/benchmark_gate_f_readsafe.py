"""Gate F read-safe research: ONE selected/zero-unread unsent local draft, NEVER SEND.
No Return, no send-button activation, no recipient switching. Run only manually
in authorized cfop WeChat environment after checking live unread=0 externally.
"""
import os
import secrets
import subprocess
import sys
import time
import hashlib
import ctypes
import select
from engine import Session, UIBlocked, TARGETS
from atspi_backend import AtspiBackend
from ui_primitives import UiPrimitives

TARGET = os.environ.get("WX_GATE_F_TARGET", "").strip()

def command(*args, input=None):
    p = subprocess.run(args, input=input, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, timeout=5, check=False)
    if p.returncode:
        raise UIBlocked("LOCAL_CLIPBOARD_OR_KEY_COMMAND_FAILED")
    return p.stdout

def clipboard_get():
    """Exact UTF8 clipboard read; do not confuse empty selection with success."""
    if not shutil_which("xclip"):
        raise UIBlocked("XCLIP_UNAVAILABLE")
    return command("xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING")


def clipboard_set(data):
    """Arm XFixes BEFORE xclip; return only after a NEW owner is proven live.

    xclip -i intentionally remains alive as X11 selection owner; NEVER wait()
    for its process to exit, kill it, or capture its stdout/stderr. XFixes
    selection changes are event-driven and bounded; no fixed sleeps.
    """
    if not shutil_which("xclip"):
        raise UIBlocked("XCLIP_UNAVAILABLE")
    if not isinstance(data, bytes):
        raise UIBlocked("CLIPBOARD_BYTES_REQUIRED")
    watcher=ClipboardOwnerWatch(allow_empty_owner=True)
    try:
        try:
            owner=subprocess.Popen(
                ("xclip", "-selection", "clipboard", "-i"),
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            if owner.stdin is None:
                raise UIBlocked("CLIPBOARD_INPUT_UNAVAILABLE")
            try:
                owner.stdin.write(data)
            finally:
                owner.stdin.close()
        except (OSError, BrokenPipeError, ValueError):
            raise UIBlocked("CLIPBOARD_OWNER_START_FAILED")
        if not watcher.changed_to_new_owner(timeout_seconds=3.0):
            raise UIBlocked("CLIPBOARD_OWNER_NOT_ACQUIRED")
    finally:
        watcher.close()


def clipboard_clear():
    """Prove NEW marker ownership, then NEW EMPTY ownership and zero bytes.

    An already empty (or unowned) clipboard is NOT sufficient evidence.
    Even if the marker stage fails, attempt the owner-approved empty clear
    once; do not claim success without BOTH independent owner proofs.
    """
    marker=("wx-cf-clear-"+secrets.token_hex(12)).encode("ascii")
    marker_proven=False
    empty_proven=False
    try:
        clipboard_set(marker)
        marker_proven=exact_utf8_sha_match(clipboard_get(),marker)
    except Exception:
        marker_proven=False
    try:
        clipboard_set(b"")
        empty_proven=(len(clipboard_get())==0)
    except Exception:
        empty_proven=False
    return marker_proven and empty_proven


def clipboard_preflight():
    """Bounded local clipboard-only probe; no WeChat input or private bytes."""
    if not clipboard_clear():
        print("XCLIP_PREFLIGHT matched=False cleared=False",flush=True)
        return 4
    marker=("wx-cf-probe-"+secrets.token_hex(8)).encode("ascii")
    matched=False
    cleared=False
    try:
        clipboard_set(marker)
        response=clipboard_get()
        matched=(len(response)==len(marker) and
                 hashlib.sha256(response).digest()==hashlib.sha256(marker).digest())
    except Exception:
        matched=False
    finally:
        cleared=clipboard_clear()
    print("XCLIP_PREFLIGHT matched="+str(matched)+
          " cleared="+str(cleared),flush=True)
    return 0 if matched and cleared else 4


class ClipboardOwnerWatch:
    """XFixes selection-owner events; capture BEFORE Ctrl+C to avoid races.

    Fail closed if XFixes is unavailable; no polling of populated Qt Text.
    """
    def __init__(self, *, allow_empty_owner=False):
        try:
            self.x=ctypes.CDLL("libX11.so.6")
            self.fix=ctypes.CDLL("libXfixes.so.3")
            self.x.XOpenDisplay.argtypes=[ctypes.c_char_p]
            self.x.XOpenDisplay.restype=ctypes.c_void_p
            self.x.XCloseDisplay.argtypes=[ctypes.c_void_p]
            self.x.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int]
            self.x.XInternAtom.restype=ctypes.c_ulong
            self.x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]
            self.x.XDefaultRootWindow.restype=ctypes.c_ulong
            self.x.XGetSelectionOwner.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
            self.x.XGetSelectionOwner.restype=ctypes.c_ulong
            self.x.XConnectionNumber.argtypes=[ctypes.c_void_p]
            self.x.XConnectionNumber.restype=ctypes.c_int
            self.x.XPending.argtypes=[ctypes.c_void_p]
            self.x.XPending.restype=ctypes.c_int
            self.x.XNextEvent.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
            self.x.XFlush.argtypes=[ctypes.c_void_p]
            self.fix.XFixesQueryExtension.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
            self.fix.XFixesQueryExtension.restype=ctypes.c_int
            self.fix.XFixesSelectSelectionInput.argtypes=[
                ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
        except Exception:
            raise UIBlocked("XFIXES_LIB_UNAVAILABLE")
        self.display=self.x.XOpenDisplay(None)
        if not self.display:
            raise UIBlocked("X11_DISPLAY_UNAVAILABLE")
        try:
            self.atom=self.x.XInternAtom(self.display,b"CLIPBOARD",0)
            self.root=self.x.XDefaultRootWindow(self.display)
            ev=ctypes.c_int()
            err=ctypes.c_int()
            if not self.fix.XFixesQueryExtension(
                    self.display,ctypes.byref(ev),ctypes.byref(err)):
                raise UIBlocked("XFIXES_EXTENSION_UNAVAILABLE")
            self.before=self.x.XGetSelectionOwner(self.display,self.atom)
            if not self.before and not allow_empty_owner:
                raise UIBlocked("XCLIP_SELECTION_OWNER_MISSING")
            self.fix.XFixesSelectSelectionInput(self.display,self.root,self.atom,7)
            self.x.XFlush(self.display)
            self.fd=self.x.XConnectionNumber(self.display)
        except Exception:
            self.close()
            raise

    def changed_to_new_owner(self,timeout_seconds=3.0):
        end=time.monotonic()+timeout_seconds
        while True:
            owner=self.x.XGetSelectionOwner(self.display,self.atom)
            if owner and owner!=self.before:
                return True
            remaining=end-time.monotonic()
            if remaining<=0:
                return False
            if self.x.XPending(self.display):
                # XEvent is a union; overallocate aligned storage, never log.
                event=(ctypes.c_long*32)()
                self.x.XNextEvent(self.display,ctypes.byref(event))
                continue
            ready,_,_=select.select([self.fd],[],[],remaining)
            if not ready:
                return False

    def close(self):
        display=getattr(self,"display",None)
        if display:
            try:
                if hasattr(self,"root") and hasattr(self,"atom"):
                    self.fix.XFixesSelectSelectionInput(display,self.root,self.atom,0)
                self.x.XCloseDisplay(display)
            finally:
                self.display=None


def clipboard_targets_utf8():
    """Explicit TARGETS negotiation; never print TARGETS or returned bytes."""
    raw=command("xclip","-selection","clipboard","-o","-t","TARGETS")
    return b"UTF8_STRING" in raw.split()


def exact_utf8_sha_match(actual,expected):
    """Only length and sha256 comparison. Caller never prints clipboard bytes."""
    return (len(actual)==len(expected) and
            hashlib.sha256(actual).digest()==hashlib.sha256(expected).digest())


def verify_copy_after_owner_event(draft,copy_action):
    """Subscribes before copy; waits event-driven bounded owner change."""
    watcher=ClipboardOwnerWatch()
    try:
        copy_action()
        changed=watcher.changed_to_new_owner(timeout_seconds=3.0)
    finally:
        watcher.close()
    if not changed:
        raise UIBlocked("X11_CLIPBOARD_OWNER_UNCHANGED")
    if not clipboard_targets_utf8():
        raise UIBlocked("CLIPBOARD_UTF8_TARGET_UNAVAILABLE")
    copied=clipboard_get()
    if not exact_utf8_sha_match(copied,draft):
        raise UIBlocked("EXACT_CLIPBOARD_READBACK_MISMATCH")
    return True


def verify_benchmark_preflight(selected,row_selected,zero_unread):
    """Pure offline preflight, never authorizes an unsafe selection."""
    if selected not in (None,TARGET):
        raise UIBlocked("BENCH_OTHER_CONVERSATION_SELECTED")
    if row_selected != (selected==TARGET):
        raise UIBlocked("BENCH_SELECTION_STATE_INCONSISTENT")
    if not row_selected and not zero_unread:
        raise UIBlocked("BENCH_UNSELECTED_TARGET_NEEDS_UNREAD_ZERO_PROOF")


def keyboard(key):
    command("xdotool", "key", "--clearmodifiers", key)

def _child(n, parent):
    return len(n.path) > len(parent.path) and n.path[:len(parent.path)] == parent.path


def _norm_label(label):
    return " ".join(str(label).casefold().split())


def _ui_state(snap):
    """Privacy-safe state: inspect known structural roles, never emit UI names/text.

    Include disabled Send when determining its state: Resolver.resolve() rejects
    disabled controls, which is correct for actions but wrong for empty checks.
    """
    role = lambda n: n.role.casefold()
    named = lambda n, spec: _norm_label(n.name) in {
        _norm_label(x) for x in spec.labels
    }
    visible = lambda n: n.visible() and n.rect is not None and n.rect.w > 0 and n.rect.h > 0
    roots = [n for n in snap.nodes if role(n) in ("frame", "window")
             and named(n, TARGETS["main_frame"]) and visible(n)]
    root = roots[0] if len(roots) == 1 else None
    descendants = lambda n: bool(root is not None and _child(n, root))
    chats = [n for n in snap.nodes if descendants(n) and role(n) == "list"
             and named(n, TARGETS["conversation_list"]) and visible(n)]
    chat = chats[0] if len(chats) == 1 else None
    selected = [n for n in snap.nodes if chat is not None and _child(n, chat)
                and role(n) in ("list item", "list-item") and visible(n)
                and "selected" in n.states]
    panes = [n for n in snap.nodes if descendants(n) and role(n) == "list"
             and named(n, TARGETS["messages_container"]) and visible(n)]
    inputs = [n for n in snap.nodes if descendants(n) and role(n) == "text"
              and "editable" in n.states and visible(n)
              and not named(n, TARGETS["search_box"])]
    buttons = [n for n in snap.nodes if descendants(n)
               and role(n) in ("button", "push button")
               and named(n, TARGETS["send_button"]) and visible(n)]
    toolbars = [n for n in snap.nodes if descendants(n)
                and role(n) in ("tool bar", "toolbar") and visible(n)
                and any(_child(button, n) for button in buttons)]
    toolbar = toolbars[0] if len(toolbars) == 1 else None
    send = [n for n in buttons if toolbar is not None and _child(n, toolbar)]
    send_node = send[0] if len(send) == 1 else None
    expected = (len(selected) == 1 and
                _norm_label(selected[0].name.split("\n", 1)[0]) == _norm_label(TARGET))
    return {
        "main_frame_unique": root is not None,
        "selected_conversation_present": len(selected) == 1,
        "selected_expected": expected,
        "chat_pane_open": len(panes) == 1,
        "message_input_visible": len(inputs) == 1,
        "composer_toolbar_visible": toolbar is not None,
        "send_button_visible": send_node is not None,
        "send_button_enabled": send_node.enabled() if send_node else None,
    }


def report_missing_target(target_id, backend):
    safe_id = target_id if target_id in TARGETS else "UNKNOWN_TARGET_ID"
    fields = ("main_frame_unique", "selected_conversation_present",
              "selected_expected", "chat_pane_open", "message_input_visible",
              "composer_toolbar_visible", "send_button_visible", "send_button_enabled")
    try:
        state = _ui_state(backend.snapshot())
    except Exception:
        state = {key: None for key in fields}
    # Only controlled field names, known target IDs and booleans; NEVER UI strings.
    print("BENCH_TARGET_NOT_FOUND target_id=" + safe_id + " " +
          " ".join(key + "=" + str(state.get(key)) for key in fields), flush=True)


def instrument_target_failures(session, backend):
    """Trace every Resolver TARGET_NOT_FOUND, including nested session calls."""
    original = session.resolver.resolve

    def traced(target_id, *args, **kwargs):
        try:
            return original(target_id, *args, **kwargs)
        except UIBlocked as exc:
            if exc.code == "TARGET_NOT_FOUND":
                report_missing_target(target_id, backend)
            raise

    session.resolver.resolve = traced


def ensure_selected_once(session, backend, ui, *, zero_unread_verified):
    """Never click selected intended recipient. Unselected -> ONE hit-tested zero-unread click."""
    selected = session.selected_conversation_name()
    row = session.resolver.unique_conversation(TARGET)
    row_selected = "selected" in row.states
    if selected not in (None, TARGET):
        raise UIBlocked("OTHER_CONVERSATION_SELECTED")
    if row_selected != (selected == TARGET):
        raise UIBlocked("BENCH_SELECTION_INCONSISTENT")
    if row_selected:
        return "already_selected", 0
    if not zero_unread_verified:
        raise UIBlocked("BENCH_UNSELECTED_TARGET_NEEDS_UNREAD_ZERO_PROOF")
    response = ui.open_read_safe_row(row, zero_unread_verified=True, dry_run=False)
    if response.state != "ACKNOWLEDGED" or response.steps != 1:
        raise UIBlocked("BENCH_ONE_CLICK_OPEN_UNVERIFIED")
    session.resolver.invalidate()
    if session.selected_conversation_name() != TARGET:
        raise UIBlocked("BENCH_RECIPIENT_UNVERIFIED_AFTER_OPEN")
    return "opened_once", 1


def editor_focus(b, s):
    if s.selected_conversation_name() != TARGET:
        raise UIBlocked("RECIPIENT_CHANGED")
    s.resolver.invalidate()
    n = s.resolver.resolve("message_input")
    if not b.focus(n):
        raise UIBlocked("COMPOSER_FOCUS_FAILED")
    if "focused" not in b._states(b._find(n)):
        raise UIBlocked("COMPOSER_FOCUS_UNVERIFIED")
    if s.selected_conversation_name() != TARGET:
        raise UIBlocked("RECIPIENT_CHANGED")
    return n

def send_enabled(s):
    # Read-only lookup admits a VISIBLE but DISABLED Send; never activate it.
    s.resolver.invalidate()
    state = _ui_state(s.resolver.refresh())
    if not state["composer_toolbar_visible"] or not state["send_button_visible"]:
        raise UIBlocked("SEND_CONTROL_NOT_UNIQUE_OR_VISIBLE")
    return state["send_button_enabled"]

def empty_proven(b,s):
    n = editor_focus(b,s)
    acc = b._find(n)
    txt = acc.get_text_iface()
    if txt is None or txt.get_character_count() != 0:
        return False
    return not send_enabled(s)

def cleanup_once(b,s):
    # At most ONE focus-verified Ctrl+A BackSpace, then TWO independent conditions.
    try:
        editor_focus(b,s)
        keyboard("ctrl+a")
        keyboard("BackSpace")
        return empty_proven(b,s)
    except Exception:
        return False

def preflight(b,s):
    if s.selected_conversation_name() != TARGET:
        raise UIBlocked("MOE_NOT_ALREADY_SELECTED")
    row=s.resolver.unique_conversation(TARGET)
    if "selected" not in row.states:
        raise UIBlocked("MOE_ROW_NOT_SELECTED")
    if "--unread-zero-verified" not in sys.argv:
        raise UIBlocked("EXTERNAL_UNREAD_ZERO_REQUIRED")
    if not empty_proven(b,s):
        raise UIBlocked("COMPOSER_EMPTY_UNVERIFIED")

def inspect_targets_readonly():
    """Read-only grounded diagnosis: no focus, click, clipboard, keyboard or draft."""
    if not TARGET:
        print("BENCH_BLOCKED TARGET_ENV_REQUIRED")
        return 2
    backend=AtspiBackend()
    session=Session(backend)
    instrument_target_failures(session, backend)
    state=_ui_state(backend.snapshot())
    for key in ("conversation_list", "messages_container", "composer_toolbar",
                "message_input", "send_button"):
        try:
            session.resolver.resolve(key)
            found=True
        except UIBlocked:
            found=False
        print("BENCH_READONLY_TARGET target_id="+key+" resolvable="+str(found),
              flush=True)
    fields = ("main_frame_unique", "selected_conversation_present",
              "selected_expected", "chat_pane_open", "message_input_visible",
              "composer_toolbar_visible", "send_button_visible", "send_button_enabled")
    print("BENCH_READONLY_STATE " +
          " ".join(key+"="+str(state.get(key)) for key in fields), flush=True)
    ready=all(state.get(key) is True for key in
              ("main_frame_unique", "selected_expected", "chat_pane_open",
               "message_input_visible", "composer_toolbar_visible",
               "send_button_visible")) and state.get("send_button_enabled") is False
    print("BENCH_READONLY_READY="+str(ready)+" no_send=True", flush=True)
    return 0 if ready else 2


_TIMING_PHASES = ("clear", "focus", "set_clipboard", "paste_wait",
                  "poison", "select", "copy_owner_wait", "verify",
                  "cleanup_ui", "cleanup_clipboard")


class PhaseDurations:
    """Monotonic, duration-only UI performance telemetry, including failures."""
    def __init__(self, clock=None):
        self.clock = clock if clock is not None else time.perf_counter
        self.t0 = self.clock()
        self.current = None
        self.started = None
        self.durations = {}

    def begin(self, name):
        self.end()
        if name not in _TIMING_PHASES:
            raise ValueError("UNKNOWN_TIMING_PHASE")
        self.current = name
        self.started = self.clock()

    def end(self):
        if self.current is not None:
            duration = max(0.0, (self.clock() - self.started) * 1000)
            self.durations[self.current] = (
                self.durations.get(self.current, 0.0) + duration)
            self.current = None
            self.started = None

    def summary(self, phase):
        self.end()
        elapsed = max(0.0, (self.clock()-self.t0)*1000)
        fields = []
        for key in _TIMING_PHASES:
            val = self.durations.get(key)
            fields.append(key+"_ms="+(str(round(val, 1)) if val is not None else "NA"))
        cleanup = (self.durations.get("cleanup_ui",0.0)+
                   self.durations.get("cleanup_clipboard",0.0))
        fields.append("cleanup_ms="+str(round(cleanup,1)))
        fields.append("total_ms="+str(round(elapsed,1)))
        fields.append("unattributed_ms="+str(round(max(0.0, elapsed-sum(self.durations.values())),1)))
        return "BENCH_TIMINGS phase="+phase+" "+" ".join(fields)


def _draft_once(backend,session,draft,kind):
    """Exactly one unsent draft; one two-condition cleanup; clear clipboard."""
    attempted=False
    verified=False
    phase="initial_clipboard_clear"
    clean=False
    cleared=False
    start=time.perf_counter()
    timing=PhaseDurations()
    try:
        timing.begin("clear")
        if not clipboard_clear():
            raise UIBlocked("CLIPBOARD_NOT_CLEARED")
        phase="focus_composer"
        timing.begin("focus")
        editor_focus(backend,session)
        phase="set_draft_clipboard"
        timing.begin("set_clipboard")
        clipboard_set(draft)
        phase="verify_draft_clipboard"
        if not exact_utf8_sha_match(clipboard_get(),draft):
            raise UIBlocked("DRAFT_CLIPBOARD_STAGING_FAILED")
        phase="paste_local_unsent_draft"
        timing.begin("paste_wait")
        attempted=True
        keyboard("ctrl+v")
        phase="await_paste_event"
        backend.wait_change(1.5)
        phase="recipient_after_paste"
        if session.selected_conversation_name()!=TARGET:
            raise UIBlocked("RECIPIENT_CHANGED_AFTER_PASTE")
        phase="send_enabled_after_paste"
        if not send_enabled(session):
            raise UIBlocked("SEND_BUTTON_NOT_ENABLED")
        timing.begin("poison")
        poison=("wx-cf-poison-"+secrets.token_hex(10)).encode("ascii")
        phase="set_poison_clipboard"
        clipboard_set(poison)
        phase="verify_poison_clipboard"
        if not exact_utf8_sha_match(clipboard_get(),poison):
            raise UIBlocked("POISON_CLIPBOARD_STAGING_FAILED")
        phase="focus_before_copy"
        timing.begin("select")
        editor_focus(backend,session)
        phase="select_local_draft"
        keyboard("ctrl+a")
        phase="copy_and_await_owner_change"
        timing.begin("copy_owner_wait")
        verify_copy_after_owner_event(
            draft, lambda:keyboard("ctrl+c"))
        phase="verify_send_enabled_after_copy"
        timing.begin("verify")
        if not send_enabled(session):
            raise UIBlocked("SEND_BUTTON_NOT_ENABLED")
        verified=True
        print("BENCH_READBACK_VERIFIED phase="+kind+
              " length_match=True sha256_match=True owner_changed=True"+
              " utf8_target=True latency_ms="+
              str(round((time.perf_counter()-start)*1000)),flush=True)
    except UIBlocked as exc:
        safe_codes={
            "CLIPBOARD_NOT_CLEARED","CLIPBOARD_OWNER_NOT_ACQUIRED",
            "DRAFT_CLIPBOARD_STAGING_FAILED",
            "POISON_CLIPBOARD_STAGING_FAILED","X11_CLIPBOARD_OWNER_UNCHANGED",
            "CLIPBOARD_UTF8_TARGET_UNAVAILABLE","EXACT_CLIPBOARD_READBACK_MISMATCH",
            "SEND_BUTTON_NOT_ENABLED","RECIPIENT_CHANGED_AFTER_PASTE",
            "COMPOSER_FOCUS_FAILED","COMPOSER_FOCUS_UNVERIFIED",
            "RECIPIENT_CHANGED","TARGET_NOT_FOUND",
            "LOCAL_CLIPBOARD_OR_KEY_COMMAND_FAILED",
            "XCLIP_SELECTION_OWNER_MISSING","X11_DISPLAY_UNAVAILABLE",
            "XFIXES_EXTENSION_UNAVAILABLE","XFIXES_LIB_UNAVAILABLE",
            "SEND_CONTROL_NOT_UNIQUE_OR_VISIBLE",
        }
        code=exc.code if exc.code in safe_codes else "OTHER_UI_BLOCKED"
        print("BENCH_DRAFT_UNSUPPORTED phase="+kind+" stage="+phase+
              " code="+code+" exact_readback=False",flush=True)
    except Exception:
        print("BENCH_DRAFT_UNSUPPORTED phase="+kind+" stage="+phase+
              " code=UNEXPECTED_ERROR exact_readback=False",flush=True)
    finally:
        # No retry. Exactly one focus-verified Ctrl+A+BackSpace.
        # Even after a failed paste, never assume composer stayed empty.
        timing.begin("cleanup_ui")
        clean=cleanup_once(backend,session)
        timing.begin("cleanup_clipboard")
        cleared=clipboard_clear()
        timing.end()
        print("BENCH_CLEANUP phase="+kind+" empty_two_conditions="+
              str(clean)+" clipboard_cleared="+str(cleared)+
              " no_send=True",flush=True)
        print(timing.summary(kind),flush=True)
    if not clean or not cleared:
        print("BENCH_IN_DOUBT phase="+kind,flush=True)
        return 3
    if not verified:
        print("BENCH_UNSUPPORTED phase="+kind,flush=True)
        return 4
    return 0


def main():
    if "--unread-zero-verified" not in sys.argv:
        print("BENCH_BLOCKED EXTERNAL_UNREAD_ZERO_REQUIRED")
        return 2
    if not TARGET:
        print("BENCH_BLOCKED TARGET_ENV_REQUIRED")
        return 2
    if not os.environ.get("DISPLAY"):
        print("BENCH_BLOCKED DISPLAY_REQUIRED")
        return 2
    if not shutil_which("xclip") or not shutil_which("xdotool"):
        print("BENCH_UNSUPPORTED CLIPBOARD_OR_KEY_TOOL_ABSENT")
        return 4
    backend=AtspiBackend()
    session=Session(backend)
    instrument_target_failures(session,backend)
    session.health()
    ui=UiPrimitives(backend)
    ui.require_no_modal()
    open_mode,open_steps=ensure_selected_once(
        session,backend,ui,zero_unread_verified=True)
    preflight(backend,session)
    # Pure ASCII must qualify BEFORE any Persian/emoji attempt.
    ascii_draft=("wx-cf-ascii-"+secrets.token_hex(12)).encode("ascii")
    rc=_draft_once(backend,session,ascii_draft,"ASCII")
    if rc!=0:
        return rc
    preflight(backend,session)
    unicode_draft=("wx-cf-\u0633\u0644\u0627\u0645-\U0001f642-"+
                   secrets.token_hex(12)).encode("utf-8")
    rc=_draft_once(backend,session,unicode_draft,"PERSIAN_EMOJI")
    if rc!=0:
        return rc
    print("BENCH_F_DRAFT_ONLY_DONE ACKNOWLEDGED"+
          " open_mode="+open_mode+" open_steps="+str(open_steps)+
          " no_send=True",flush=True)
    return 0


def shutil_which(name):
    from shutil import which
    return which(name)

if __name__=="__main__":
    try:
        if "--clipboard-preflight" in sys.argv:
            sys.exit(clipboard_preflight())
        if "--targets-readonly" in sys.argv:
            sys.exit(inspect_targets_readonly())
        sys.exit(main())
    except UIBlocked as e:
        print("BENCH_BLOCKED", e.code)
        sys.exit(2)
    except Exception:
        print("BENCH_BLOCKED UNEXPECTED_ERROR")
        sys.exit(3)
