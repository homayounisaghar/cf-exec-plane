"""One-shot WeChat file dispatch through the proven X11 chooser path.

This returns UI_OUTBOUND_OBSERVED, never provider-confirmed success. Ambiguous
post-marker states are IN_DOUBT and the permanent marker is never removed.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

HANDOFF_ROOT = Path(
    "/var/lib/capability-fabric/releases/onshape-vps-fast-r100-direct-orbit1-paa-storage-r268-wechat-file-handoff-dryrun-20261031/.wechat-handoff"
)
MAX_FILE_BYTES = 64 * 1024 * 1024
OWNER_UID = 1000
OWNER_GID = 1000


def _reject(code: str) -> None:
    raise RuntimeError(code)


def validate_target(target: str) -> None:
    if target != "File Transfer":
        _reject("WECHAT_FILE_SEND_SCOPE_SELF_CHAT_ONLY")


def validate_handoff(path: str, expected_sha256: str, *,
                     handoff_root: str | Path = HANDOFF_ROOT,
                     uid: int = OWNER_UID, gid: int = OWNER_GID) -> tuple[Path, str, int]:
    root = Path(handoff_root).resolve(strict=True)
    candidate = Path(path)
    try:
        lst = candidate.lstat()
        real = candidate.resolve(strict=True)
        parent = real.parent.lstat()
    except OSError:
        _reject("WECHAT_HANDOFF_FILE_MISSING")
    if not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode):
        _reject("WECHAT_HANDOFF_PARENT_INVALID")
    if parent.st_uid != uid or parent.st_gid != gid or stat.S_IMODE(parent.st_mode) != 0o700:
        _reject("WECHAT_HANDOFF_PARENT_NOT_PRIVATE")
    if real.parent.parent != root or candidate.is_symlink():
        _reject("WECHAT_HANDOFF_PATH_INVALID")
    if not stat.S_ISREG(lst.st_mode) or lst.st_nlink != 1:
        _reject("WECHAT_HANDOFF_FILE_NOT_REGULAR")
    if lst.st_uid != uid or lst.st_gid != gid or stat.S_IMODE(lst.st_mode) != 0o600:
        _reject("WECHAT_HANDOFF_FILE_NOT_PRIVATE")
    if not 1 <= lst.st_size <= MAX_FILE_BYTES:
        _reject("WECHAT_HANDOFF_SIZE_OUT_OF_SCOPE")
    if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
        _reject("WECHAT_HANDOFF_SHA_INVALID")
    digest = hashlib.sha256(real.read_bytes()).hexdigest()
    if digest != expected_sha256.lower():
        _reject("WECHAT_HANDOFF_SHA_MISMATCH")
    return real, digest, lst.st_size


def classify_receipt(*, filename: str, before: list[str], after: list[str],
                     direction: str, send_clicks: int,
                     send_enabled_after: bool | None) -> dict:
    before_count = sum(filename in str(x) for x in before)
    after_count = sum(filename in str(x) for x in after)
    new_count = after_count - before_count
    ok = (new_count == 1 and bool(after) and filename in str(after[-1]) and
          direction == "out" and send_clicks in (0, 1) and
          send_enabled_after is False)
    if not ok:
        return {"state": "IN_DOUBT", "reason": "OUTBOUND_FILE_RECEIPT_NOT_UNIQUE",
                "provider_confirmed": False, "blind_retry_safe": False,
                "new_filename_rows": new_count, "direction": direction}
    return {"state": "UI_OUTBOUND_OBSERVED",
            "verification_source": "same_client_accessibility_and_pixel_direction",
            "provider_confirmed": False, "provider_fresh": False,
            "blind_retry_safe": False, "new_filename_rows": 1,
            "direction": "out"}


def dispatch_file_once(target: str, path: str, expected_sha256: str,
                       dialog_state_fn, select_target_fn=None) -> dict:
    validate_target(target)
    real, digest, size = validate_handoff(path, expected_sha256)
    sys.path.insert(0, "/tmp/wxeng")
    from atspi_backend import AtspiBackend
    from pointer_mapping import hover_target, click_once
    from wechat_live_lock import WeChatLiveLock
    from x11_modal_guard import (assert_no_wechat_modal,
                                 new_expected_file_chooser,
                                 mark_expected_file_click)
    from gate_click_accuracy import _button
    import wx_common as common
    import wx_nav as nav
    import wx_send as sender

    payload = "file-sha256:" + digest
    filename = real.name
    with WeChatLiveLock():
        if common.already_attempted(target, payload):
            return {"state": "FAILED", "reason": "WECHAT_FILE_PRIOR_ATTEMPT_NO_RETRY",
                    "provider_confirmed": False, "blind_retry_safe": False}
        assert_no_wechat_modal()
        if select_target_fn is not None:
            select_target_fn(target, allow_mark_read=False)
        backend = AtspiBackend()
        snap = backend.snapshot()
        common.require_chat(snap, target)
        if common.read_text(backend, common.composer(snap)) != "":
            _reject("WECHAT_COMPOSER_NOT_EMPTY")
        if common.send_button(snap, require_enabled=False).enabled():
            _reject("WECHAT_COMPOSER_ALREADY_HAS_STAGED_CONTENT")
        before = sender.all_row_names(snap)
        button = _button(snap, "Send File")
        plan = hover_target(backend, button, snap=snap,
                            allow_descendant=False, label="CF_WECHAT_FILE_BUTTON")
        scope = new_expected_file_chooser()
        mark_expected_file_click(scope, (plan[1], plan[2]))
        opened = subprocess.run(["xdotool", "mousemove", str(plan[1]), str(plan[2]),
                                  "click", "1"], capture_output=True,
                                 timeout=5, check=False)
        if opened.returncode != 0:
            _reject("WECHAT_FILE_CHOOSER_CLICK_FAILED")
        deadline = time.monotonic() + 4.0
        dialog = {}
        while time.monotonic() < deadline:
            dialog = dialog_state_fn()
            if dialog.get("is_distinct_file_dialog_candidate"):
                break
            time.sleep(0.08)
        if not dialog.get("is_distinct_file_dialog_candidate"):
            _reject("WECHAT_FILE_DIALOG_NOT_QUALIFIED")
        window_id = str(dialog.get("window_id") or "")
        focus = subprocess.run(["xdotool", "getwindowfocus"], capture_output=True,
                               text=True, timeout=3, check=False)
        if focus.returncode != 0 or focus.stdout.strip() != window_id:
            _reject("WECHAT_FILE_DIALOG_FOCUS_LOST")
        # The durable marker precedes the first chooser action that could
        # select/dispatch the file. It is never deleted on uncertain outcome.
        common.claim_send(target, payload)
        try:
            validate_handoff(str(real), digest)
            subprocess.run(["xdotool", "key", "ctrl+l"], check=True, timeout=3,
                           capture_output=True)
            subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", "1",
                            "--", str(real)], check=True, timeout=8, capture_output=True)
            subprocess.run(["xdotool", "key", "Return"], check=True, timeout=3,
                           capture_output=True)
        except Exception:
            return {"state": "IN_DOUBT", "reason": "WECHAT_FILE_CHOOSER_SELECTION_UNCERTAIN",
                    "provider_confirmed": False, "effect_may_have_occurred": True,
                    "blind_retry_safe": False}
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            current = dialog_state_fn()
            if not current.get("is_distinct_file_dialog_candidate"):
                break
            time.sleep(0.1)
        else:
            return {"state": "IN_DOUBT", "reason": "WECHAT_FILE_CHOOSER_STILL_OPEN",
                    "provider_confirmed": False, "effect_may_have_occurred": True,
                    "blind_retry_safe": False}
        try:
            assert_no_wechat_modal()
        except Exception:
            return {"state": "IN_DOUBT", "reason": "WECHAT_UNEXPECTED_MODAL_AFTER_SELECTION",
                    "provider_confirmed": False, "effect_may_have_occurred": True,
                    "blind_retry_safe": False}

        send_clicks = 0
        deadline = time.monotonic() + min(30.0, 3.0 + size / (2 * 1024 * 1024))
        staged_plan = None
        while time.monotonic() < deadline:
            snap = backend.snapshot()
            common.require_chat(snap, target)
            enabled = common.send_button(snap, require_enabled=False).enabled()
            after = sender.all_row_names(snap)
            new_count = sum(filename in str(x) for x in after) - sum(filename in str(x) for x in before)
            if enabled:
                # Do not send unless the exact staged filename is accessible.
                if not any(filename in (node.name or "") for node in snap.nodes):
                    return {"state": "IN_DOUBT", "reason": "STAGED_FILENAME_NOT_VISIBLE",
                            "provider_confirmed": False, "effect_may_have_occurred": True,
                            "blind_retry_safe": False}
                assert_no_wechat_modal()
                validate_handoff(str(real), digest)
                button = common.send_button(snap, require_enabled=True)
                staged_plan = hover_target(backend, button, snap=snap,
                                           label="CF_WECHAT_FILE_SEND")
                snap = backend.snapshot()
                common.require_chat(snap, target)
                if not common.send_button(snap, require_enabled=True).enabled() or not any(
                        filename in (node.name or "") for node in snap.nodes):
                    return {"state": "IN_DOUBT", "reason": "STAGED_ATTACHMENT_CHANGED",
                            "provider_confirmed": False, "effect_may_have_occurred": True,
                            "blind_retry_safe": False}
                assert_no_wechat_modal()
                try:
                    send_clicks = 1
                    click_once(staged_plan)
                except Exception:
                    return {"state": "IN_DOUBT", "reason": "WECHAT_SEND_CLICK_UNCERTAIN",
                            "provider_confirmed": False, "effect_may_have_occurred": True,
                            "blind_retry_safe": False}
                break
            if new_count == 1 and after and filename in str(after[-1]):
                direction = sender._last_direction_any(backend, nav.Pixels())
                receipt = classify_receipt(filename=filename, before=before, after=after,
                                            direction=direction, send_clicks=send_clicks,
                                            send_enabled_after=enabled)
                return {"provider": "wechat", "target": target, "filename": filename,
                        "size_bytes": size, "sha256_hex": digest, **receipt}
            time.sleep(0.15)
        else:
            return {"state": "IN_DOUBT", "reason": "WECHAT_FILE_NOT_STAGED_OR_SENT",
                    "provider_confirmed": False, "effect_may_have_occurred": True,
                    "blind_retry_safe": False}

        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            snap = backend.snapshot()
            common.require_chat(snap, target)
            enabled = common.send_button(snap, require_enabled=False).enabled()
            after = sender.all_row_names(snap)
            new_count = sum(filename in str(x) for x in after) - sum(filename in str(x) for x in before)
            if enabled is False and new_count == 1 and after and filename in str(after[-1]):
                direction = sender._last_direction_any(backend, nav.Pixels())
                receipt = classify_receipt(filename=filename, before=before, after=after,
                                            direction=direction, send_clicks=send_clicks,
                                            send_enabled_after=enabled)
                return {"provider": "wechat", "target": target, "filename": filename,
                        "size_bytes": size, "sha256_hex": digest, **receipt}
            time.sleep(0.15)
        return {"state": "IN_DOUBT", "reason": "WECHAT_POST_SEND_UI_RECEIPT_TIMEOUT",
                "provider_confirmed": False, "effect_may_have_occurred": True,
                "blind_retry_safe": False}
