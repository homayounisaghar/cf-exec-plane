#!/usr/bin/env python3
from __future__ import annotations

from ctypes import CDLL, c_char_p, c_double, c_int
from hashlib import sha256
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import base64
import html
import json
import os
from pathlib import Path
import secrets
import signal
import socket
from threading import RLock, Thread
import time
from urllib.parse import parse_qs, urlparse


SOCKET_PATH = Path(os.environ.get("PCG_TELEGRAM_SOCKET", "/run/pcg/telegram.sock"))
TDLIB_LIBRARY = os.environ.get("PCG_TDLIB_LIBRARY", "libtdjson.so")
EXPECTED_VERSION = os.environ.get("PCG_TDLIB_EXPECTED_VERSION", "1.8.67")
API_FILE = Path(os.environ.get("PCG_TELEGRAM_API_FILE", "/api-credentials/telegram-api.json"))
DB_KEY_FILE = Path(os.environ.get("PCG_TDLIB_DB_KEY_FILE", "/db-key/tdlib-db-key"))
DB_DIR = Path(os.environ.get("PCG_TDLIB_DB_DIR", "/state/tdlib-db"))
FILES_DIR = Path(os.environ.get("PCG_TDLIB_FILES_DIR", "/state/tdlib-files"))
PROVISION_TOKEN_FILE = Path(os.environ.get("PCG_PROVISION_TOKEN_FILE", "/provision/token"))
PROVISION_COMPLETE_FILE = Path(os.environ.get("PCG_PROVISION_COMPLETE_FILE", "/run/pcg/provision-complete"))
PROVISION_PORT = int(os.environ.get("PCG_PROVISION_PORT", "8766"))
PROVISION_TTL_SECONDS = int(os.environ.get("PCG_PROVISION_TTL_SECONDS", "900"))
STOP = False


def stop_handler(_signum, _frame):
    global STOP
    STOP = True


signal.signal(signal.SIGTERM, stop_handler)
signal.signal(signal.SIGINT, stop_handler)


class RuntimeErrorSafe(RuntimeError):
    pass


def private_regular_file(path: Path, *, allow_group_read: bool = False) -> None:
    st = path.stat()
    if not path.is_file() or path.is_symlink():
        raise RuntimeErrorSafe("required private file is not a regular file")
    forbidden = 0o027 if allow_group_read else 0o077
    if st.st_mode & forbidden:
        raise RuntimeErrorSafe("required private file permissions are too broad")


def load_db_key() -> bytes:
    private_regular_file(DB_KEY_FILE, allow_group_read=True)
    key = DB_KEY_FILE.read_bytes()
    if len(key) < 32:
        raise RuntimeErrorSafe("TDLib database key is invalid")
    return key


def load_api_credentials() -> tuple[int, str] | None:
    if not API_FILE.exists():
        return None
    private_regular_file(API_FILE)
    value = json.loads(API_FILE.read_text(encoding="utf-8"))
    if value.get("schema_version") != 1:
        raise RuntimeErrorSafe("unsupported Telegram API credential schema")
    api_id = value.get("telegram_api_id")
    api_hash = value.get("telegram_api_hash")
    if not isinstance(api_id, int) or api_id <= 0:
        raise RuntimeErrorSafe("invalid Telegram api_id")
    if not isinstance(api_hash, str) or not api_hash.strip():
        raise RuntimeErrorSafe("invalid Telegram api_hash")
    return api_id, api_hash


def create_api_credentials(api_id: int, api_hash: str) -> None:
    if not isinstance(api_id, int) or api_id <= 0:
        raise RuntimeErrorSafe("api_id must be a positive integer")
    if not isinstance(api_hash, str) or not api_hash.strip():
        raise RuntimeErrorSafe("api_hash must be non-empty")
    API_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if API_FILE.exists():
        raise RuntimeErrorSafe("Telegram API credentials already exist")
    payload = (
        json.dumps(
            {
                "schema_version": 1,
                "telegram_api_id": api_id,
                "telegram_api_hash": api_hash,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    fd = os.open(API_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        API_FILE.unlink(missing_ok=True)
        raise
    os.chmod(API_FILE, 0o600)


class TdJson:
    def __init__(self, library: str) -> None:
        self.lib = CDLL(library)
        self.lib.td_execute.restype = c_char_p
        self.lib.td_execute.argtypes = [c_char_p]
        self.lib.td_create_client_id.restype = c_int
        self.lib.td_create_client_id.argtypes = []
        self.lib.td_send.restype = None
        self.lib.td_send.argtypes = [c_int, c_char_p]
        self.lib.td_receive.restype = c_char_p
        self.lib.td_receive.argtypes = [c_double]
        self._execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 1})
        version = self._execute({"@type": "getOption", "name": "version"})
        if version.get("@type") != "optionValueString" or version.get("value") != EXPECTED_VERSION:
            raise RuntimeErrorSafe("unexpected TDLib version")
        self.version = EXPECTED_VERSION

    def _execute(self, request: dict) -> dict:
        raw = self.lib.td_execute(json.dumps(request, separators=(",", ":")).encode("utf-8"))
        if not raw:
            raise RuntimeErrorSafe("TDLib execute returned no response")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise RuntimeErrorSafe("TDLib execute returned invalid JSON")
        return value


class AuthorizationRuntime:
    def __init__(self, tdjson: TdJson) -> None:
        self.tdjson = tdjson
        self.lock = RLock()
        self.client_id = 0
        self.sequence = 0
        self.inbox: list[dict] = []
        self.authorization_state = "NO_CREDENTIALS"
        self.online_effective = "UNCHECKED"
        if API_FILE.exists():
            self.ensure_client()

    def _next_extra(self) -> str:
        self.sequence += 1
        return f"pcg-provision:{self.client_id}:{self.sequence}"

    def _receive_raw(self, timeout: float) -> dict | None:
        raw = self.tdjson.lib.td_receive(float(timeout))
        if not raw:
            return None
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            return None
        client_id = value.get("@client_id")
        if client_id is not None and client_id != self.client_id:
            return None
        return value

    def _receive(self, timeout: float) -> dict | None:
        if self.inbox:
            return self.inbox.pop(0)
        return self._receive_raw(timeout)

    def _send(self, request: dict, *, timeout: float = 12.0) -> dict:
        extra = self._next_extra()
        payload = dict(request)
        payload["@extra"] = extra
        self.tdjson.lib.td_send(
            self.client_id,
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        )
        deadline = time.monotonic() + timeout
        deferred: list[dict] = []
        try:
            while time.monotonic() < deadline:
                event = self._receive_raw(min(0.5, max(0.0, deadline - time.monotonic())))
                if event is None:
                    continue
                if event.get("@extra") == extra:
                    if event.get("@type") == "error":
                        code = event.get("code")
                        raise RuntimeErrorSafe(
                            f"TDLib operation failed with code {code if isinstance(code, int) else 'unknown'}"
                        )
                    return event
                deferred.append(event)
            raise RuntimeErrorSafe("TDLib request timed out")
        finally:
            if deferred:
                self.inbox[0:0] = deferred

    def ensure_client(self) -> None:
        with self.lock:
            if self.client_id > 0:
                return
            credentials = load_api_credentials()
            if credentials is None:
                self.authorization_state = "NO_CREDENTIALS"
                return
            load_db_key()
            DB_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            FILES_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(DB_DIR, 0o700)
            os.chmod(FILES_DIR, 0o700)
            self.client_id = int(self.tdjson.lib.td_create_client_id())
            if self.client_id <= 0:
                raise RuntimeErrorSafe("TDLib client creation failed")
            self.authorization_state = "STARTING"
            self.advance(max_events=160)

    def _parameters(self) -> dict:
        credentials = load_api_credentials()
        if credentials is None:
            raise RuntimeErrorSafe("Telegram API credentials are absent")
        api_id, api_hash = credentials
        key = base64.b64encode(load_db_key()).decode("ascii")
        return {
            "@type": "setTdlibParameters",
            "use_test_dc": False,
            "database_directory": str(DB_DIR),
            "files_directory": str(FILES_DIR),
            "database_encryption_key": key,
            "use_file_database": True,
            "use_chat_info_database": True,
            "use_message_database": True,
            "use_secret_chats": False,
            "api_id": api_id,
            "api_hash": api_hash,
            "system_language_code": "en",
            "device_model": "PCG-VPS",
            "system_version": "",
            "application_version": "0.3",
        }

    def _handle_auth_update(self, event: dict) -> None:
        if event.get("@type") != "updateAuthorizationState":
            return
        state = event.get("authorization_state")
        if not isinstance(state, dict):
            return
        state_type = state.get("@type")
        if not isinstance(state_type, str):
            return
        self.authorization_state = state_type
        if state_type == "authorizationStateWaitTdlibParameters":
            self._send(self._parameters())
        elif state_type == "authorizationStateReady":
            online = self._send({"@type": "getOption", "name": "online"})
            if online.get("@type") != "optionValueBoolean" or online.get("value") is not False:
                raise RuntimeErrorSafe("effective Telegram online option is not false")
            self.online_effective = "FALSE"

    def advance(self, *, max_events: int = 96) -> str:
        with self.lock:
            if self.client_id <= 0:
                self.ensure_client()
                if self.client_id <= 0:
                    return self.authorization_state
            for _ in range(max_events):
                event = self._receive(0.08)
                if event is None:
                    if self.authorization_state not in {"STARTING", "authorizationStateWaitTdlibParameters"}:
                        break
                    continue
                self._handle_auth_update(event)
                if self.authorization_state in {
                    "authorizationStateWaitPhoneNumber",
                    "authorizationStateWaitEmailAddress",
                    "authorizationStateWaitEmailCode",
                    "authorizationStateWaitCode",
                    "authorizationStateWaitRegistration",
                    "authorizationStateWaitPassword",
                    "authorizationStateWaitOtherDeviceConfirmation",
                    "authorizationStateWaitPremiumPurchase",
                    "authorizationStateReady",
                    "authorizationStateLoggingOut",
                    "authorizationStateClosing",
                    "authorizationStateClosed",
                }:
                    break
            return self.authorization_state

    def submit(self, phase: str, value: dict[str, str]) -> str:
        with self.lock:
            state = self.advance()
            expected = {
                "PHONE_NUMBER": "authorizationStateWaitPhoneNumber",
                "EMAIL_ADDRESS": "authorizationStateWaitEmailAddress",
                "EMAIL_CODE": "authorizationStateWaitEmailCode",
                "AUTHENTICATION_CODE": "authorizationStateWaitCode",
                "REGISTRATION": "authorizationStateWaitRegistration",
                "PASSWORD": "authorizationStateWaitPassword",
                "OTHER_DEVICE_CONFIRMATION": "authorizationStateWaitOtherDeviceConfirmation",
            }
            if phase not in expected or state != expected[phase]:
                raise RuntimeErrorSafe("authorization input is not valid in the current state")
            if phase == "PHONE_NUMBER":
                phone = value.get("phone_number", "").strip()
                if not phone:
                    raise RuntimeErrorSafe("phone number is required")
                self._send({"@type": "setAuthenticationPhoneNumber", "phone_number": phone, "settings": None})
            elif phase == "EMAIL_ADDRESS":
                email = value.get("email_address", "").strip()
                if not email:
                    raise RuntimeErrorSafe("email address is required")
                self._send({"@type": "setAuthenticationEmailAddress", "email_address": email})
            elif phase == "EMAIL_CODE":
                code = value.get("email_code", "")
                if not code:
                    raise RuntimeErrorSafe("email code is required")
                self._send(
                    {
                        "@type": "checkAuthenticationEmailCode",
                        "code": {"@type": "emailAddressAuthenticationCode", "code": code},
                    }
                )
            elif phase == "AUTHENTICATION_CODE":
                code = value.get("authentication_code", "")
                if not code:
                    raise RuntimeErrorSafe("authentication code is required")
                self._send({"@type": "checkAuthenticationCode", "code": code})
            elif phase == "PASSWORD":
                password = value.get("password", "")
                if not password:
                    raise RuntimeErrorSafe("password is required")
                self._send({"@type": "checkAuthenticationPassword", "password": password})
            elif phase == "REGISTRATION":
                first = value.get("first_name", "").strip()
                last = value.get("last_name", "").strip()
                if not first:
                    raise RuntimeErrorSafe("first name is required")
                self._send(
                    {
                        "@type": "registerUser",
                        "first_name": first,
                        "last_name": last,
                        "disable_notification": False,
                    }
                )
            elif phase == "OTHER_DEVICE_CONFIRMATION":
                pass
            return self.advance(max_events=160)

    def close(self) -> None:
        with self.lock:
            if self.client_id <= 0:
                return
            try:
                self.tdjson.lib.td_send(
                    self.client_id,
                    b'{"@type":"close","@extra":"pcg-close"}',
                )
                deadline = time.monotonic() + 8.0
                while time.monotonic() < deadline:
                    event = self._receive(0.5)
                    if event is None:
                        continue
                    self._handle_auth_update(event)
                    if self.authorization_state == "authorizationStateClosed":
                        break
            finally:
                self.client_id = 0


def phase_for_state(runtime: AuthorizationRuntime) -> tuple[str, str, tuple[str, ...], set[str], bool]:
    if not API_FILE.exists():
        return (
            "API_CREDENTIALS",
            "Enter the Telegram API credentials for this PCG host.",
            ("api_id", "api_hash"),
            {"api_hash"},
            False,
        )
    state = runtime.advance()
    mapping = {
        "authorizationStateWaitPhoneNumber": (
            "PHONE_NUMBER",
            "Enter the Telegram account phone number in international format.",
            ("phone_number",),
            {"phone_number"},
        ),
        "authorizationStateWaitEmailAddress": (
            "EMAIL_ADDRESS",
            "Enter the login email requested by Telegram.",
            ("email_address",),
            {"email_address"},
        ),
        "authorizationStateWaitEmailCode": (
            "EMAIL_CODE",
            "Enter the email verification code requested by Telegram.",
            ("email_code",),
            {"email_code"},
        ),
        "authorizationStateWaitCode": (
            "AUTHENTICATION_CODE",
            "Enter the Telegram login code.",
            ("authentication_code",),
            {"authentication_code"},
        ),
        "authorizationStateWaitRegistration": (
            "REGISTRATION",
            "Telegram requires account registration details.",
            ("first_name", "last_name"),
            set(),
        ),
        "authorizationStateWaitPassword": (
            "PASSWORD",
            "Enter the Telegram 2-step verification password.",
            ("password",),
            {"password"},
        ),
        "authorizationStateWaitOtherDeviceConfirmation": (
            "OTHER_DEVICE_CONFIRMATION",
            "Approve the login on another Telegram device, then press Continue.",
            tuple(),
            set(),
        ),
        "authorizationStateReady": (
            "READY",
            "Telegram authorization is ready. This one-time provisioning surface will close.",
            tuple(),
            set(),
        ),
    }
    if state in mapping:
        phase, prompt, fields, secret_fields = mapping[state]
        return phase, prompt, fields, secret_fields, phase == "READY"
    if state in {
        "authorizationStateLoggingOut",
        "authorizationStateClosing",
        "authorizationStateClosed",
    }:
        raise RuntimeErrorSafe("Telegram authorization session is closing or revoked")
    if state == "authorizationStateWaitPremiumPurchase":
        raise RuntimeErrorSafe("Telegram requested an unsupported premium-purchase authorization step")
    return "WAITING", "Waiting for Telegram authorization state. Press Refresh.", tuple(), set(), False


class ProvisioningController:
    def __init__(self, runtime: AuthorizationRuntime) -> None:
        self.runtime = runtime

    def view(self):
        return phase_for_state(self.runtime)

    def submit(self, values: dict[str, str]):
        phase, _prompt, _fields, _secret_fields, ready = self.view()
        if ready:
            return self.view()
        if phase == "API_CREDENTIALS":
            try:
                api_id = int(values.get("api_id", ""), 10)
            except ValueError as exc:
                raise RuntimeErrorSafe("api_id must be a positive integer") from exc
            api_hash = values.get("api_hash", "").strip()
            create_api_credentials(api_id, api_hash)
            self.runtime.ensure_client()
            return self.view()
        self.runtime.submit(phase, values)
        return self.view()


def hostname_from_host_header(value: str) -> str | None:
    raw = value.strip()
    if raw.startswith("["):
        end = raw.find("]")
        return raw[1:end] if end > 1 else None
    return raw.rsplit(":", 1)[0] if ":" in raw else raw


def safe_host(value: str | None) -> bool:
    return isinstance(value, str) and hostname_from_host_header(value) in {
        "127.0.0.1",
        "::1",
        "localhost",
    }


def safe_origin(value: str | None) -> bool:
    if value is None:
        return True
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}


def page(view, *, nonce: str, bootstrap: bool = False, error: str | None = None) -> bytes:
    phase, prompt, fields, secret_fields, ready = view
    parts = [
        "<!doctype html><meta charset=utf-8>",
        "<meta name=viewport content='width=device-width,initial-scale=1'>",
        "<title>PCG Telegram provisioning</title>",
        "<h1>PCG Telegram provisioning</h1>",
    ]
    if error:
        parts.append("<p role=alert>" + html.escape(error) + "</p>")
    if bootstrap:
        parts.append("<p>Authenticate this one-time local provisioning session.</p>")
        parts.append("<p id='status'>Authenticating local session...</p>")
        parts.append(
            "<script nonce='" + html.escape(nonce) + "'>"
            "(async()=>{"
            "const s=document.getElementById('status');"
            "const p=new URLSearchParams(location.hash.slice(1));"
            "const t=p.get('token');"
            "if(!t){s.textContent='Missing local bootstrap token.';return;}"
            "for(let i=0;i<20;i++){"
            "try{"
            "const r=await fetch('/session',{method:'POST',headers:{'Content-Type':'text/plain'},body:t,cache:'no-store'});"
            "if(r.ok){location.replace('/');return;}"
            "}catch(_e){}"
            "await new Promise(resolve=>setTimeout(resolve,300));"
            "}"
            "s.textContent='Local session authentication did not complete. Refresh this exact bootstrap URL while the SSH tunnel remains open.';"
            "})();"
            "</script>"
        )
        return "".join(parts).encode("utf-8")
    parts.append("<p>Phase: " + html.escape(phase) + "</p>")
    parts.append("<p>" + html.escape(prompt) + "</p>")
    if ready:
        parts.append("<p>READY. This one-time surface is closing.</p>")
        return "".join(parts).encode("utf-8")
    parts.append("<form method=post action='/submit'>")
    for field in fields:
        kind = "password" if field in secret_fields else "text"
        autocomplete = "off" if field in secret_fields else "on"
        parts.append(
            "<label>" + html.escape(field.replace("_", " ")) + " "
            "<input required name='" + html.escape(field) + "' type='" + kind
            + "' autocomplete='" + autocomplete + "'></label><br>"
        )
    parts.append("<button type=submit>Continue</button></form>")
    parts.append("<form method=post action='/refresh'><button type=submit>Refresh</button></form>")
    return "".join(parts).encode("utf-8")


class ProvisionSession:
    COOKIE = "pcg_provision"

    def __init__(self, token: str, expires_at: float) -> None:
        self.digest = sha256(token.encode("utf-8")).digest()
        self.expires_at = expires_at

    def expired(self) -> bool:
        return time.monotonic() >= self.expires_at

    def matches(self, value: str) -> bool:
        return isinstance(value, str) and secrets.compare_digest(
            sha256(value.encode("utf-8")).digest(),
            self.digest,
        )

    def authenticated(self, header: str | None) -> bool:
        if self.expired() or not header:
            return False
        cookie = SimpleCookie()
        try:
            cookie.load(header)
        except Exception:
            return False
        morsel = cookie.get(self.COOKIE)
        return morsel is not None and self.matches(morsel.value)


def handler_factory(session: ProvisionSession, controller: ProvisioningController):
    class Handler(BaseHTTPRequestHandler):
        server_version = "PCGProvision/2"
        sys_version = ""

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def headers_out(self, status: HTTPStatus, *, length: int, nonce: str | None = None, cookie: str | None = None):
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            csp = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'"
            if nonce:
                csp += "; script-src 'nonce-" + nonce + "'"
            self.send_header("Content-Security-Policy", csp)
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()

        def body(self, limit: int = 16384) -> bytes:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError as exc:
                raise RuntimeErrorSafe("invalid request length") from exc
            if length < 0 or length > limit:
                raise RuntimeErrorSafe("request body exceeds provisioning limit")
            return self.rfile.read(length)

        def render(self, view, *, bootstrap=False, error=None):
            nonce = secrets.token_urlsafe(18)
            data = page(view, nonce=nonce, bootstrap=bootstrap, error=error)
            self.headers_out(HTTPStatus.OK, length=len(data), nonce=nonce)
            self.wfile.write(data)

        def bad_host(self) -> bool:
            if not safe_host(self.headers.get("Host")):
                self.headers_out(HTTPStatus.BAD_REQUEST, length=0)
                return True
            return False

        def do_GET(self):
            if self.bad_host():
                return
            if self.path == "/healthz":
                data = b'{"ok":true,"mode":"one-time-loopback-same-writer"}'
                self.headers_out(HTTPStatus.OK, length=len(data))
                self.wfile.write(data)
                return
            if self.path != "/":
                self.headers_out(HTTPStatus.NOT_FOUND, length=0)
                return
            if session.expired():
                self.headers_out(HTTPStatus.GONE, length=0)
                return
            if not session.authenticated(self.headers.get("Cookie")):
                self.render(("TOKEN", "Authenticate this browser session.", tuple(), set(), False), bootstrap=True)
                return
            try:
                self.render(controller.view())
            except Exception:
                self.render(("ERROR", "Provisioning unavailable.", tuple(), set(), False), error="The local provisioning backend could not advance safely.")

        def do_POST(self):
            if self.bad_host():
                return
            if session.expired():
                self.headers_out(HTTPStatus.GONE, length=0)
                return
            if not safe_origin(self.headers.get("Origin")):
                self.headers_out(HTTPStatus.FORBIDDEN, length=0)
                return
            if self.path == "/session":
                try:
                    token = self.body(limit=512).decode("utf-8")
                except Exception:
                    self.headers_out(HTTPStatus.BAD_REQUEST, length=0)
                    return
                if not session.matches(token):
                    self.headers_out(HTTPStatus.FORBIDDEN, length=0)
                    return
                max_age = max(1, int(session.expires_at - time.monotonic()))
                cookie = f"{session.COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
                self.headers_out(HTTPStatus.NO_CONTENT, length=0, cookie=cookie)
                return
            if not session.authenticated(self.headers.get("Cookie")):
                self.headers_out(HTTPStatus.FORBIDDEN, length=0)
                return
            if self.path not in {"/submit", "/refresh"}:
                self.headers_out(HTTPStatus.NOT_FOUND, length=0)
                return
            try:
                if self.path == "/refresh":
                    view = controller.view()
                else:
                    parsed = parse_qs(self.body().decode("utf-8"), keep_blank_values=True)
                    values = {key: items[-1] if items else "" for key, items in parsed.items()}
                    view = controller.submit(values)
                self.render(view)
                if view[4]:
                    setattr(self.server, "provisioning_complete", True)
            except Exception:
                self.render(("ERROR", "The submitted step was rejected.", tuple(), set(), False), error="The provisioning step was rejected without echoing or persisting transient login values.")

    return Handler


class Runtime:
    def __init__(self) -> None:
        self.tdjson = TdJson(TDLIB_LIBRARY)
        self.auth = AuthorizationRuntime(self.tdjson)
        self.controller = ProvisioningController(self.auth)
        self.provision_thread: Thread | None = None
        self.provision_generation: bytes | None = None
        self.provision_state = "INACTIVE"

    def _current_token(self) -> tuple[str, bytes] | None:
        if PROVISION_COMPLETE_FILE.exists() or not PROVISION_TOKEN_FILE.exists():
            return None
        private_regular_file(PROVISION_TOKEN_FILE, allow_group_read=True)
        token = PROVISION_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(token) < 32:
            raise RuntimeErrorSafe("provisioning token is invalid")
        return token, sha256(token.encode("utf-8")).digest()

    def maybe_start_provisioning(self) -> None:
        current = self._current_token()
        if current is None:
            return
        token, generation = current
        if self.provision_thread is not None and self.provision_thread.is_alive():
            # A host-side window reopen rotates the token. The existing worker must stop
            # accepting the old token and yield to a new worker without restarting TDLib.
            if self.provision_generation == generation:
                return
            return
        self.provision_generation = generation
        self.provision_state = "ACTIVE"

        def worker(worker_generation: bytes):
            try:
                session = ProvisionSession(token, time.monotonic() + PROVISION_TTL_SECONDS)
                server = HTTPServer(("0.0.0.0", PROVISION_PORT), handler_factory(session, self.controller))
                server.timeout = 1.0
                setattr(server, "provisioning_complete", False)
                try:
                    while not STOP and not session.expired() and not bool(getattr(server, "provisioning_complete", False)):
                        current_worker_token = self._current_token()
                        if current_worker_token is None or current_worker_token[1] != worker_generation:
                            self.provision_state = "ROTATED"
                            break
                        server.handle_request()
                finally:
                    server.server_close()
                if bool(getattr(server, "provisioning_complete", False)):
                    PROVISION_COMPLETE_FILE.write_text("READY\n", encoding="utf-8")
                    self.provision_state = "COMPLETE"
                elif self.provision_state != "ROTATED":
                    self.provision_state = "EXPIRED"
            except Exception:
                self.provision_state = "FAILED"

        self.provision_thread = Thread(
            target=worker,
            args=(generation,),
            name="pcg-provision",
            daemon=True,
        )
        self.provision_thread.start()

    def health(self) -> dict:
        state = self.auth.authorization_state
        if state == "NO_CREDENTIALS":
            authorization = "PROVISIONING_REQUIRED"
        elif state == "authorizationStateReady":
            authorization = "READY"
        else:
            authorization = "PROVISIONING_INCOMPLETE"
        return {
            "ok": True,
            "component": "pcg-telegram",
            "mode": "REAL_TDLIB_PROVISIONABLE",
            "tdlib_version": self.tdjson.version,
            "tdlib_client": "CREATED" if self.auth.client_id > 0 else "NOT_CREATED",
            "provider_network": "ENABLED_FOR_AUTH_RUNTIME",
            "authorization": authorization,
            "authorization_state": state,
            "online_effective": self.auth.online_effective,
            "provisioning_surface": self.provision_state,
            "startup_reconciliation": "COMPLETE_NO_EFFECTS",
            "material_send_admission": "CLOSED",
            "model_content_admission": "CLOSED",
            "presence_control": "NOT_INVOKED",
        }

    def close(self) -> None:
        self.auth.close()


def main() -> None:
    if PROVISION_PORT != 8766 or PROVISION_TTL_SECONDS < 30 or PROVISION_TTL_SECONDS > 3600:
        raise RuntimeErrorSafe("unsafe provisioning configuration")
    runtime = Runtime()
    SOCKET_PATH.parent.mkdir(mode=0o770, parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(8)
    server.settimeout(1.0)
    try:
        while not STOP:
            runtime.maybe_start_provisioning()
            try:
                conn, _ = server.accept()
            except TimeoutError:
                continue
            with conn:
                conn.settimeout(2.0)
                raw = conn.recv(4096)
                try:
                    request = json.loads(raw.decode("utf-8"))
                except Exception:
                    request = {}
                if request.get("op") == "health":
                    payload = runtime.health()
                else:
                    payload = {"ok": False, "error": "unsupported-operation"}
                conn.sendall((json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
    finally:
        server.close()
        runtime.close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
