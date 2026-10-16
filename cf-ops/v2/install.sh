#!/usr/bin/env bash
# CF-ops host agent installer v2. Run as root from the bundle directory.
# Installs: cf-ops agent 2.0, root approval wrapper (Telegram code), one sudoers rule.
# Full backup + automatic rollback. Never touches WeChat services, the paa-remote service, or CF containers.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "FAIL root_required"; exit 30; }
here="$(cd "$(dirname "$0")" && pwd)"
user="$(getent passwd 1000 | cut -d: -f1)"
lib=/usr/local/lib/capability-fabric/cf-ops
state=/var/lib/capability-fabric/cf-ops
run=/var/lib/capability-fabric/cf-ops-run
unit=/etc/systemd/system/capability-fabric-cf-ops.service
envf=/etc/capability-fabric/cf-ops.env
wrapper=/usr/local/sbin/cf-admin-exec
sudoers=/etc/sudoers.d/cf-admin
wx=(capability-fabric-pcg-wechat.service capability-fabric-pcg-wechat-semantic.service)

[[ -n "$user" ]] || { echo "FAIL uid1000_missing"; exit 31; }
echo "PASS user=$user uid=$(id -u "$user")"
declare -A before
for s in "${wx[@]}"; do before[$s]="$(systemctl show "$s" -p MainPID --value 2>/dev/null || echo none)"; done
python3 -m py_compile "$here/cf_ops_agent.py" "$here/github_api.py"
command -v visudo >/dev/null || { echo "FAIL visudo_missing"; exit 32; }
for b in /usr/bin/systemd-run /usr/bin/systemctl /usr/bin/timeout /bin/bash; do [[ -x "$b" ]] || { echo "FAIL missing_$b"; exit 33; }; done

bk="/var/lib/capability-fabric/cf-ops-backup/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$bk"
for f in "$lib/cf_ops_agent.py" "$lib/github_api.py" "$unit" "$wrapper" "$sudoers" "$envf"; do
  [[ -e "$f" ]] && cp -a "$f" "$bk/$(echo "$f" | tr / _)"
done
echo "PASS backup=$bk"
rollback() {
  echo "FAIL install_error_rolling_back"
  for f in "$lib/cf_ops_agent.py" "$lib/github_api.py" "$unit" "$wrapper" "$sudoers" "$envf"; do
    b="$bk/$(echo "$f" | tr / _)"
    if [[ -e "$b" ]]; then cp -a "$b" "$f"; else rm -f "$f"; fi
  done
  systemctl daemon-reload || true
  if [[ -f "$unit" ]]; then systemctl restart capability-fabric-cf-ops.service || true; echo "INFO rollback=restored_previous"
  else systemctl disable --now capability-fabric-cf-ops.service >/dev/null 2>&1 || true; echo "INFO rollback=removed"; fi
}
trap rollback ERR

install -d -m 0755 -o root -g root "$lib"
install -m 0644 -o root -g root "$here/cf_ops_agent.py" "$lib/cf_ops_agent.py"
install -m 0644 -o root -g root "$here/github_api.py" "$lib/github_api.py"
install -d -m 0700 -o "$user" -g "$user" "$state"
install -d -m 0755 -o "$user" -g "$user" "$run"
install -d -m 0700 -o root -g root /var/lib/capability-fabric/cf-admin /var/log/cf-admin
cat > "$wrapper.tmp" <<'CFADMINPY'
#!/usr/bin/env python3
"""cf-admin-exec: owner-approved root actions for CF-server.

Invoked only through sudo by the cf-ops agent user (uid 1000). Every root
command needs a fresh 6-digit code that is sent to the owner's Telegram Saved
Messages together with the exact command text and who asked for it. Codes are
stored only as salted hashes, expire after 10 minutes, allow 5 attempts, are
single-use, and approvals lock for 24 h after 20 wrong codes. Commands run in
their own systemd unit (outside the cf-ops agent cgroup), so they survive agent
restarts and the user migration. JSON in on stdin, JSON out. No arguments.
"""
import contextlib, fcntl, hashlib, hmac, json, os, re, secrets, signal, socket, subprocess, sys, time

STATE = "/var/lib/capability-fabric/cf-admin"
AUDIT = "/var/log/cf-admin/audit.jsonl"
WEB_SOCK = "/var/lib/capability-fabric/pcg/run/ingress/web.sock"
SYSTEMD_RUN, SYSTEMCTL, BASH, TIMEOUT = "/usr/bin/systemd-run", "/usr/bin/systemctl", "/bin/bash", "/usr/bin/timeout"
TTL, MAX_ATTEMPTS, MAX_OUT, MAX_CMD = 600, 5, 20000, 3200
MAX_PENDING, MAX_FAILS, FAIL_WINDOW, KEEP_DAYS = 5, 20, 86400, 30
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8"}
RID_RE = re.compile(r"^[0-9a-f]{16}$")
CMD_RE = re.compile(r"^[\x20-\x7e\t\n]+$")


def out(obj, rc=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n"); sys.stdout.flush(); sys.exit(rc)


def fail(code, msg=None):
    out({"ok": False, "error": {"code": code, "message": msg or code}}, 0)


def now(): return time.time()


def clean(s, n):
    """One-line text without control/format characters (safe to show in Telegram)."""
    s = "".join(ch if ch.isprintable() and not ("\u200b" <= ch <= "\u200f" or "\u202a" <= ch <= "\u202e"
                                                or "\u2066" <= ch <= "\u2069" or ch == "\ufeff") else " " for ch in str(s or ""))
    return " ".join(s.split())[:n]


def audit(event, **kw):
    os.makedirs(os.path.dirname(AUDIT), mode=0o700, exist_ok=True)
    rec = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, "sudo_uid": os.environ.get("SUDO_UID"), **kw}
    fd = os.open(AUDIT, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def path(rid, ext=".json"):
    if not (isinstance(rid, str) and RID_RE.match(rid)):
        fail("INVALID_REQUEST_ID")
    return os.path.join(STATE, rid + ext)


def load(rid):
    try:
        with open(path(rid), encoding="utf-8") as f: return json.load(f)
    except FileNotFoundError: fail("REQUEST_NOT_FOUND")


def save(rid, rec):
    tmp = path(rid) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(rec, f, ensure_ascii=False)
    os.replace(tmp, path(rid))


@contextlib.contextmanager
def locked():
    fd = os.open(os.path.join(STATE, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX); yield
    finally:
        os.close(fd)


def requests():
    for n in os.listdir(STATE):
        if n.endswith(".json") and RID_RE.match(n[:-5]):
            try:
                with open(os.path.join(STATE, n), encoding="utf-8") as f: yield json.load(f)
            except (OSError, ValueError): continue


def prune():
    cutoff = now() - KEEP_DAYS * 86400
    for n in os.listdir(STATE):
        p = os.path.join(STATE, n)
        if RID_RE.match(n[:16]) and os.path.getmtime(p) < cutoff:
            with contextlib.suppress(OSError): os.unlink(p)


def failures(add=False):
    p = os.path.join(STATE, "failures.json")
    try:
        with open(p, encoding="utf-8") as f: xs = [x for x in json.load(f) if isinstance(x, (int, float)) and x > now() - FAIL_WINDOW]
    except (OSError, ValueError): xs = []
    if add:
        xs.append(now()); fd = os.open(p + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump(xs, f)
        os.replace(p + ".tmp", p)
    return len(xs)


def pcg(payload, timeout=30):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect(WEB_SOCK)
    s.sendall((json.dumps(payload) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk: break
        buf += chunk
        if len(buf) > 2_000_000: break
    s.close()
    return json.loads(buf.split(b"\n", 1)[0])


def telegram_saved_messages(text):
    r = pcg({"op": "semantic.invoke", "operation": "communication.conversation.search", "purpose": "PROTECTED_DISPLAY",
             "args": {"query": "Saved Messages", "limit": 20}})
    rows = (r.get("protected_provider_data") or {}).get("conversations") or []
    hs = [x.get("handle") for x in rows if str(x.get("name", "")).strip().lower() == "saved messages" and str(x.get("handle", "")).startswith("tgchat:")]
    if len(hs) != 1: raise RuntimeError("SAVED_MESSAGES_NOT_RESOLVED")
    r = pcg({"op": "semantic.invoke", "operation": "communication.message.send", "purpose": "OWNER_REQUEST",
             "args": {"conversation_handle": hs[0], "text": text}}, timeout=60)
    if r.get("state") == "ACHIEVED" or r.get("state") == "ACKNOWLEDGED_UNVERIFIED" or r.get("ok"):
        return "confirmed"
    ob = r.get("observation") or {}
    # Telegram Web created the message but could not confirm it (seen 2026-10-15 after a browser restart).
    # The owner typing the code is the delivery proof, so keep the request pending.
    if (r.get("error") == "MESSAGE_DELIVERY_UNCONFIRMED" and not ob.get("provider_rejected")
            and str(ob.get("created_message_handle") or "").startswith("tgmsg:")):
        return "unconfirmed"
    raise RuntimeError("TELEGRAM_SEND_" + str(r.get("error") or r.get("state")))


def read_cut(p):
    """Head and tail of a possibly huge output file, without reading it all."""
    try:
        size = os.path.getsize(p)
        with open(p, "rb") as f:
            if size <= MAX_OUT: return f.read().decode("utf-8", "replace")
            head = f.read(MAX_OUT // 2); f.seek(size - MAX_OUT // 2); tail = f.read()
        return head.decode("utf-8", "replace") + "\n...cut (%d bytes total)...\n" % size + tail.decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def unit_active(rid):
    r = subprocess.run([SYSTEMCTL, "is-active", "--quiet", "cf-admin-%s.service" % rid], env=ENV,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return r.returncode == 0


def read_rc(rid):
    try:
        with open(path(rid, ".rc"), encoding="utf-8") as f: return int(f.read().strip())
    except (OSError, ValueError): return None


def run_foreground(rid, rec):
    """Runs in a transient scope (own cgroup), waits, kills the whole scope on timeout."""
    outp, errp, t = path(rid, ".out"), path(rid, ".err"), rec["timeout_s"]
    with open(outp, "wb") as o, open(errp, "wb") as e:
        p = subprocess.Popen([SYSTEMD_RUN, "--scope", "--quiet", "--collect", "--unit=cf-admin-%s" % rid,
                              "--description=CF admin request %s" % rid, BASH, path(rid, ".sh")],
                             stdin=subprocess.DEVNULL, stdout=o, stderr=e, start_new_session=True, cwd="/root", env=ENV)
        try:
            rc = p.wait(timeout=t)
        except subprocess.TimeoutExpired:
            for sig, wait in (("SIGTERM", 10), ("SIGKILL", 5)):
                subprocess.run([SYSTEMCTL, "kill", "--signal=" + sig, "cf-admin-%s.scope" % rid], env=ENV,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with contextlib.suppress(ProcessLookupError, PermissionError): os.killpg(p.pid, getattr(signal, sig))
                try: p.wait(timeout=wait); break
                except subprocess.TimeoutExpired: continue
            rc = 124
            e.write(b"\nTIMEOUT after %d s\n" % t)
    return rc


def start_background(rid, rec):
    """Runs as its own transient service; the runner records the exit code in <rid>.rc."""
    runner = path(rid, ".run")
    fd = os.open(runner, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n%s -k 10 %d %s %s\nrc=$?\necho \"$rc\" > %s.tmp && mv -f %s.tmp %s\n"
                % (TIMEOUT, rec["timeout_s"], BASH, path(rid, ".sh"), path(rid, ".rc"), path(rid, ".rc"), path(rid, ".rc")))
    r = subprocess.run([SYSTEMD_RUN, "--quiet", "--collect", "--unit=cf-admin-%s" % rid, "--service-type=exec",
                        "--description=CF admin request %s" % rid, "-p", "WorkingDirectory=/root",
                        "-p", "RuntimeMaxSec=%d" % (rec["timeout_s"] + 60),
                        "-p", "StandardOutput=file:" + path(rid, ".out"), "-p", "StandardError=file:" + path(rid, ".err"),
                        BASH, runner], stdin=subprocess.DEVNULL, capture_output=True, env=ENV, timeout=60)
    return r.returncode, (r.stderr or b"").decode("utf-8", "replace")[:300]


def main():
    if os.geteuid() != 0: fail("ROOT_REQUIRED")
    if len(sys.argv) != 1: fail("NO_ARGUMENTS_ALLOWED")
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    try: a = json.loads(sys.stdin.read(200_000) or "{}")
    except ValueError: fail("INVALID_JSON")
    if not isinstance(a, dict): fail("INVALID_JSON")
    act = a.get("action")
    caller = clean(a.get("caller") or "unknown", 200)
    if act == "request":
        cmd, reason = a.get("command"), clean(a.get("reason"), 300)
        if not (isinstance(cmd, str) and cmd.strip()): fail("INVALID_COMMAND")
        if len(cmd) > MAX_CMD: fail("COMMAND_TOO_LONG", "max %d characters (it must fit in one Telegram message); put longer scripts in a file first" % MAX_CMD)
        if not CMD_RE.match(cmd): fail("COMMAND_NOT_PLAIN_ASCII", "root commands may contain only printable ASCII, tabs and newlines")
        if "```" in cmd: fail("COMMAND_HAS_TRIPLE_BACKTICK", "``` is reserved for the Telegram code block")
        if not reason: fail("REASON_REQUIRED")
        try: timeout = int(a.get("timeout_s") or 300)
        except (TypeError, ValueError): fail("INVALID_TIMEOUT")
        if not 1 <= timeout <= 3600: fail("INVALID_TIMEOUT")
        background = bool(a.get("background"))
        with locked():
            prune()
            pending = sum(1 for r in requests() if r.get("status") == "pending" and now() <= r.get("expires", 0))
            if pending >= MAX_PENDING: fail("TOO_MANY_PENDING", "cancel or wait for pending requests (max %d)" % MAX_PENDING)
            rid, code, salt = secrets.token_hex(8), "%06d" % secrets.randbelow(10**6), secrets.token_hex(16)
            rec = {"id": rid, "command": cmd, "reason": reason, "timeout_s": timeout, "background": background,
                   "salt": salt, "hash": hashlib.sha256((salt + code).encode()).hexdigest(), "created": now(),
                   "expires": now() + TTL, "attempts": 0, "status": "pending", "caller": caller}
            save(rid, rec)
        text = ("CF root request " + rid + "\nRequested by: " + caller + "\nReason: " + reason +
                "\nMode: " + ("background" if background else "foreground") + ", timeout " + str(timeout) + " s" +
                "\nCommand:\n```\n" + cmd + "\n```\n\nValid 10 minutes, single use. Only give the code if you approve exactly this command."
                "\nThe code is in the next message (copy that whole message) \U0001F447")
        code_text = "CF root code: " + code
        try:
            if len(text.encode("utf-16-le")) // 2 > 4096: raise RuntimeError("MESSAGE_TOO_LONG_FOR_TELEGRAM")
            d1 = telegram_saved_messages(text)
            d2 = telegram_saved_messages(code_text)
            delivery = "confirmed" if d1 == d2 == "confirmed" else "unconfirmed"
        except Exception as e:
            rec["status"] = "delivery_failed"; rec.pop("hash"); save(rid, rec)
            audit("request_delivery_failed", id=rid, caller=caller, command=cmd, error=str(e)[:200])
            fail("TELEGRAM_DELIVERY_FAILED", str(e)[:200])
        audit("request", id=rid, caller=caller, command=cmd, reason=reason, timeout_s=timeout, background=background, delivery=delivery)
        res = {"request_id": rid, "expires_in_s": TTL, "delivered_to": "Telegram Saved Messages", "delivery": delivery,
               "next": "Ask the owner for the 6-digit code (they may paste the whole code message 'CF root code: NNNNNN'; pass only the 6 digits), then call server_admin_approve."}
        if delivery == "unconfirmed":
            res["note"] = "Telegram accepted the message but did not confirm delivery. If the owner did not get it, cancel this request and retry."
        out({"ok": True, "result": res})
    if act == "approve":
        rid, code = a.get("request_id"), str(a.get("code") or "").strip()
        with locked():
            rec = load(rid)
            if rec["status"] != "pending": fail("REQUEST_NOT_PENDING", rec["status"])
            if now() > rec["expires"]:
                rec["status"] = "expired"; rec.pop("hash", None); save(rid, rec); fail("CODE_EXPIRED")
            if rec["attempts"] >= MAX_ATTEMPTS:
                rec["status"] = "locked"; rec.pop("hash", None); save(rid, rec); fail("TOO_MANY_ATTEMPTS")
            if failures() >= MAX_FAILS:
                audit("approve_refused_lockout", id=rid, caller=caller)
                fail("APPROVALS_LOCKED", "too many wrong codes in the last 24 h; try again later")
            if not (re.fullmatch(r"[0-9]{6}", code) and hmac.compare_digest(hashlib.sha256((rec["salt"] + code).encode()).hexdigest(), rec["hash"])):
                rec["attempts"] += 1
                if rec["attempts"] >= MAX_ATTEMPTS: rec["status"] = "locked"; rec.pop("hash", None)
                save(rid, rec); failures(add=True)
                audit("approve_bad_code", id=rid, caller=caller, attempts=rec["attempts"])
                fail("CODE_INVALID", "attempts left: %d" % max(0, MAX_ATTEMPTS - rec["attempts"]))
            rec["status"] = "approved"; rec.pop("hash"); rec["approved"] = now(); rec["approved_by"] = caller; save(rid, rec)
        audit("approved", id=rid, caller=caller, requested_by=rec.get("caller"), command=rec["command"])
        fd = os.open(path(rid, ".sh"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
        with os.fdopen(fd, "w", encoding="utf-8") as f: f.write(rec["command"] + "\n")
        if rec["background"]:
            rc, err = start_background(rid, rec)
            if rc != 0:
                rec["status"] = "start_failed"; rec["finished"] = now(); save(rid, rec)
                audit("start_failed", id=rid, error=err)
                fail("BACKGROUND_START_FAILED", err)
            rec["status"] = "running"; rec["unit"] = "cf-admin-%s.service" % rid; save(rid, rec)
            audit("started", id=rid, unit=rec["unit"])
            out({"ok": True, "result": {"request_id": rid, "background": True, "status": "running", "unit": rec["unit"],
                 "next": "Poll server_admin_output with this request_id."}})
        rec["status"] = "running"; save(rid, rec)
        rc = run_foreground(rid, rec)
        rec["status"] = "done"; rec["exit_code"] = rc; rec["finished"] = now(); save(rid, rec)
        audit("done", id=rid, exit_code=rc)
        out({"ok": True, "result": {"request_id": rid, "exit_code": rc, "stdout": read_cut(path(rid, ".out")), "stderr": read_cut(path(rid, ".err"))}})
    if act == "output":
        rid = a.get("request_id"); rec = load(rid)
        if rec["status"] == "running" and rec.get("background"):
            rc = read_rc(rid)
            if rc is not None or not unit_active(rid):
                with locked():
                    rec = load(rid)
                    if rec["status"] == "running":
                        rec["status"] = "done"; rec["exit_code"] = rc; rec["finished"] = now()
                        if rc is None: rec["note"] = "job ended without recording an exit code (killed or runtime limit)"
                        save(rid, rec); audit("done", id=rid, exit_code=rc)
        res = {k: rec.get(k) for k in ("id", "status", "exit_code", "background", "unit", "note")}
        res["request_id"] = res.pop("id")
        res["stdout"], res["stderr"] = read_cut(path(rid, ".out")), read_cut(path(rid, ".err"))
        out({"ok": True, "result": res})
    if act == "list":
        rows = sorted(requests(), key=lambda r: r.get("created", 0), reverse=True)[:20]
        for r in rows:
            if r.get("status") == "pending" and now() > r.get("expires", 0): r["status"] = "expired"
        out({"ok": True, "result": {"requests": [{k: r.get(k) for k in ("id", "status", "reason", "caller", "background", "timeout_s", "created", "exit_code")}
                                                 | {"command": str(r.get("command", ""))[:200]} for r in rows],
                                    "wrong_codes_last_24h": failures()}})
    if act == "cancel":
        rid = a.get("request_id")
        with locked():
            rec = load(rid)
            if rec["status"] == "pending": rec["status"] = "cancelled"; rec.pop("hash", None); save(rid, rec); audit("cancelled", id=rid, caller=caller)
        out({"ok": True, "result": {"request_id": rid, "status": rec["status"]}})
    fail("INVALID_ACTION")


if __name__ == "__main__":
    main()
CFADMINPY
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$wrapper.tmp"
install -m 0755 -o root -g root "$wrapper.tmp" "$wrapper"; rm -f "$wrapper.tmp"
printf '# CF owner-approved root actions (each needs a Telegram code)\n#%s ALL=(root) NOPASSWD: %s\n' "$(id -u "$user")" "$wrapper" > "$sudoers.tmp"
visudo -cf "$sudoers.tmp" >/dev/null
install -m 0440 -o root -g root "$sudoers.tmp" "$sudoers"; rm -f "$sudoers.tmp"
visudo -c >/dev/null
echo "PASS files_installed wrapper+sudoers"

{
  systemctl show capability-fabric-pcg-wechat.service -p Environment --value 2>/dev/null | tr ' ' '\n' \
    | grep -E '^(DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|PULSE_SERVER|PULSE_RUNTIME_PATH|DBUS_SESSION_BUS_ADDRESS|LANG|LC_ALL)=' || true
} > "$envf.tmp"
grep -q '^XDG_RUNTIME_DIR=' "$envf.tmp" || echo "XDG_RUNTIME_DIR=/run/user/$(id -u "$user")" >> "$envf.tmp"
install -m 0644 -o root -g root "$envf.tmp" "$envf"; rm -f "$envf.tmp"

py="$(command -v python3)"
cat > "$unit.tmp" <<UNIT
[Unit]
Description=Capability Fabric owner host-ops agent (cf-ops)
After=network-online.target

[Service]
Type=simple
User=$user
Group=$user
EnvironmentFile=-$envf
Environment=CF_OPS_STATE=$state
Environment=CF_OPS_SOCKET=$run/agent.sock
Environment=CF_OPS_ALLOWED_UIDS=0
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$state
ExecStart=$py $lib/cf_ops_agent.py
Restart=always
RestartSec=3
KillMode=process
MemoryMax=2G
TasksMax=512
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
install -m 0644 -o root -g root "$unit.tmp" "$unit"; rm -f "$unit.tmp"
systemctl daemon-reload
systemctl enable capability-fabric-cf-ops.service >/dev/null
systemctl restart capability-fabric-cf-ops.service
echo "PASS unit_restarted"

sleep 1
for _ in $(seq 1 20); do [[ -S "$run/agent.sock" ]] && break; sleep 1; done
[[ -S "$run/agent.sock" ]]
python3 - "$run/agent.sock" <<'PY'
import json,socket,sys
def call(op,args,t=30):
    s=socket.socket(socket.AF_UNIX); s.settimeout(t); s.connect(sys.argv[1])
    s.sendall((json.dumps({"op":op,"args":args,"caller":"installer"})+"\n").encode())
    return json.loads(s.makefile().readline())
r=call("server_status",{}); assert r.get("ok") is True, r
x=r["result"]; assert x["version"]=="cf-ops-agent/2.0", x
print("PASS agent_status user=%s version=%s github=%s" % (x["user"],x["version"],x["github_logged_in"]))
r=call("server_admin_list",{}); assert r.get("ok") is True, r
print("PASS admin_wrapper_reachable_via_sudo requests=%d" % len(r["result"]["requests"]))
PY
trap - ERR
for s in "${wx[@]}"; do
  now="$(systemctl show "$s" -p MainPID --value 2>/dev/null || echo none)"
  [[ "$now" == "${before[$s]}" ]] && echo "PASS wechat_untouched $s pid=$now" || echo "WARN wechat_pid_changed $s ${before[$s]}->$now"
done
echo "CF_OPS_INSTALL=success"
