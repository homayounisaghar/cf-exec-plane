#!/usr/bin/env python3
"""CF owner-scoped host operations. Python stdlib; no listening TCP port."""
import base64
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from github_api import GithubAPI

ROOT = pathlib.Path(os.environ.get("CF_OPS_STATE", "/var/lib/capability-fabric/cf-ops"))
SOCKET = os.environ.get("CF_OPS_SOCKET", "/var/lib/capability-fabric/cf-ops-run/agent.sock")
ALLOWED_UIDS = {int(x) for x in os.environ.get("CF_OPS_ALLOWED_UIDS", "0").split(",") if x.strip()}
VERSION = "cf-ops-agent/1.0"
AUDIT = ROOT / "audit.jsonl"
MAX_REQUEST = 5 * 1024 * 1024
MAX_RESULT = 850000
MAX_FILE_CHUNK = 1024 * 1024
MAX_UPLOAD = 2 * 1024 ** 3
FP = re.compile(r"^cfsub_[0-9a-f]{64}$")
LOCK = threading.RLock()
EXEC_LOCK = threading.RLock()
SAFE_JOB_ID = re.compile(r"^[0-9a-f]{32}$")

class Problem(Exception):
    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code

def now():
    return datetime.now(timezone.utc).isoformat()

def must(condition, code):
    if not condition:
        raise Problem(code)

def make_root():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    for sub in ("jobs", "uploads"):
        (ROOT / sub).mkdir(mode=0o700, exist_ok=True)

def json_write(p, value):
    temp = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("x", encoding="utf-8") as f:
        os.chmod(temp, 0o600)
        json.dump(value, f, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, p)

def json_read(p):
    try:
        with p.open(encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise Problem("NOT_FOUND")

def data_path(value):
    must(isinstance(value, str) and value.startswith("/") and "\x00" not in value and len(value) < 4096, "INVALID_PATH")
    return pathlib.Path(value)

def regular_file(p):
    try:
        st = p.lstat()
    except FileNotFoundError:
        raise Problem("FILE_NOT_FOUND")
    must(stat.S_ISREG(st.st_mode), "NOT_REGULAR_FILE")
    return st

def limit_text(raw, cap=20000):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    if len(text) <= cap:
        return text
    keep = max(1, (cap - 11) // 2)
    return text[:keep] + "\n...cut...\n" + text[-keep:]

def secret_scrub(x):
    x = str(x)
    x = re.sub(r"(gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+)", "(hidden)", x, flags=re.I)
    x = re.sub(r"((?:password|secret|token|api[_-]?key)\s*[=:]\s*)\S+", r"\1(hidden)", x, flags=re.I)
    return x

def audit(caller, op, args, status, ms, size=0):
    # Commands are represented by hashes only; audit never persists their plaintext.
    details = {}
    if "command" in args:
        details["command"] = "sha256:" + hashlib.sha256(str(args["command"]).encode()).hexdigest()
    for key in ("path", "src", "dst", "dest_path", "repo", "branch", "job_id"):
        if isinstance(args.get(key), str):
            details[key] = secret_scrub(args[key])[:300]
    record = dict(time=now(), caller_fingerprint=caller, tool=op, detail=details,
                  status=status, duration_ms=ms, result_size_bytes=size)
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
    fd = os.open(AUDIT, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)

def file_read(a):
    p = data_path(a["path"])
    st = regular_file(p)
    offset, length = int(a.get("offset") or 0), int(a.get("length") or 65536)
    must(0 <= offset <= st.st_size and 0 <= length <= MAX_FILE_CHUNK, "INVALID_RANGE")
    with p.open("rb") as f:
        f.seek(offset)
        data = f.read(length)
    encoding = a.get("encoding", "text")
    must(encoding in ("text", "base64"), "INVALID_ENCODING")
    return dict(path=str(p), offset=offset, next_offset=offset+len(data), size_bytes=st.st_size,
                encoding=encoding, content=base64.b64encode(data).decode() if encoding == "base64" else data.decode("utf-8", "replace"))

def file_write(a):
    p = data_path(a["path"])
    mode = a.get("mode", "create")
    must(mode in ("create", "overwrite", "append"), "INVALID_MODE")
    has_text, has_b64 = "content" in a, "content_base64" in a
    must(has_text != has_b64, "CONTENT_REQUIRED")
    data = str(a["content"]).encode() if has_text else base64.b64decode(a["content_base64"], validate=True)
    must(len(data) <= MAX_REQUEST, "CHUNK_TOO_LARGE")
    if a.get("make_dirs"):
        p.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    if mode == "create":
        flags |= os.O_CREAT | os.O_EXCL
    elif mode == "append":
        flags |= os.O_CREAT | os.O_APPEND
    else:
        flags |= os.O_CREAT | os.O_TRUNC
    fd = os.open(p, flags, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    return dict(path=str(p), bytes_written=len(data), size_bytes=p.stat().st_size, mode=mode)

def file_edit(a):
    p = data_path(a["path"])
    st = regular_file(p)
    must(st.st_size <= 16 * 1024 * 1024, "FILE_TOO_LARGE")
    old, new = a.get("old_text"), a.get("new_text")
    must(isinstance(old, str) and old and isinstance(new, str), "INVALID_EDIT")
    source = p.read_text(encoding="utf-8")
    count = source.count(old)
    must(count > 0, "TEXT_NOT_FOUND")
    must(count == 1 or a.get("replace_all") is True, "TEXT_NOT_UNIQUE")
    changed = source.replace(old, new, -1 if a.get("replace_all") else 1)
    fd, temp = tempfile.mkstemp(prefix=".cfops-", dir=str(p.parent))
    try:
        os.fchmod(fd, stat.S_IMODE(st.st_mode))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(changed)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, p)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return dict(path=str(p), replacements=count if a.get("replace_all") else 1, size_bytes=p.stat().st_size)

def file_delete(a):
    must(a.get("confirm") is True, "CONFIRM_REQUIRED")
    p = data_path(a["path"])
    must(str(p.resolve()) not in ("/", "/var", "/etc", "/usr", "/home", "/root", "/tmp"), "ROOT_DELETE_FORBIDDEN")
    if p.is_dir() and not p.is_symlink():
        must(a.get("recursive") is True, "RECURSIVE_CONFIRM_REQUIRED")
        shutil.rmtree(p)
    else:
        p.unlink()
    return dict(deleted=True, path=str(p))

def file_list(a):
    p = data_path(a["path"])
    depth = int(a.get("depth") or 1)
    must(1 <= depth <= 3, "INVALID_DEPTH")
    must(p.is_dir(), "NOT_DIRECTORY")
    entries = []
    def walk(folder, d):
        for item in sorted(folder.iterdir(), key=lambda v: v.name):
            if len(entries) >= 500:
                return
            st = item.lstat()
            entries.append(dict(path=str(item), name=item.name, type="directory" if item.is_dir() and not item.is_symlink() else ("symlink" if item.is_symlink() else "file"), size_bytes=st.st_size))
            if item.is_dir() and not item.is_symlink() and d < depth:
                try: walk(item, d+1)
                except PermissionError: pass
    walk(p, 1)
    return dict(path=str(p), entries=entries, truncated=len(entries)>=500)

def file_stat(a):
    p = data_path(a["path"])
    st = p.lstat()
    return dict(path=str(p), size_bytes=st.st_size, mode=oct(stat.S_IMODE(st.st_mode)),
                uid=st.st_uid, gid=st.st_gid, modified_at=st.st_mtime,
                is_file=stat.S_ISREG(st.st_mode), is_directory=stat.S_ISDIR(st.st_mode),
                is_symlink=stat.S_ISLNK(st.st_mode))

def file_move(a):
    src, dst = data_path(a["src"]), data_path(a["dst"])
    must(not dst.exists() and not dst.is_symlink(), "DEST_EXISTS")
    src.rename(dst)
    return dict(src=str(src), dst=str(dst), moved=True)

def file_copy(a):
    src, dst = data_path(a["src"]), data_path(a["dst"])
    must(not dst.exists() and not dst.is_symlink(), "DEST_EXISTS")
    must(not src.is_symlink(), "SYMLINK_SOURCE_FORBIDDEN")
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=False)
    else:
        with src.open("rb") as inp, dst.open("xb") as out:
            shutil.copyfileobj(inp, out, 1024 * 1024)
    return dict(src=str(src), dst=str(dst), copied=True)

def file_search(a):
    root = data_path(a["path"])
    must(root.is_dir(), "NOT_DIRECTORY")
    glob, pattern = a.get("name_glob"), a.get("content_regex")
    must(glob or pattern, "SEARCH_FILTER_REQUIRED")
    rx = re.compile(pattern) if pattern else None
    cap = min(200, max(1, int(a.get("max_results") or 50)))
    matches, visited = [], 0
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not pathlib.Path(folder, d).is_symlink()]
        for name in files:
            visited += 1
            if visited > 10000 or len(matches) >= cap:
                break
            if glob and not fnmatch.fnmatch(name, glob):
                continue
            p = pathlib.Path(folder, name)
            try:
                st = p.lstat()
                if not stat.S_ISREG(st.st_mode):
                    continue
                if rx:
                    if st.st_size > 1024*1024:
                        continue
                    if not rx.search(p.read_text(errors="replace")):
                        continue
                matches.append(str(p))
            except (PermissionError, OSError, UnicodeError):
                pass
        if visited > 10000 or len(matches) >= cap:
            break
    return dict(matches=matches, visited=visited, truncated=visited>10000 or len(matches)>=cap)

def file_fetch(a):
    url = a.get("url_or_cf_download_path")
    must(isinstance(url, str) and len(url) < 4000, "INVALID_URL")
    if url.startswith("/mcp/"):
        must(re.fullmatch(r"/mcp/[a-z0-9-]{2,40}/[A-Za-z0-9_.-]{16,200}", url) is not None, "INVALID_CF_DOWNLOAD_PATH")
        url = "http://127.0.0.1:8788" + url
    else:
        u = urllib.parse.urlparse(url)
        must(u.scheme == "https" and bool(u.hostname) and not u.username and not u.password, "HTTPS_REQUIRED")
    dest = data_path(a["dest_path"])
    must(not dest.is_symlink(), "SYMLINK_DEST_FORBIDDEN")
    must(dest.parent.is_dir(), "DEST_PARENT_MISSING")
    expected = a.get("expected_size")
    expected_hash = a.get("sha256")
    if expected_hash:
        must(re.fullmatch("[0-9a-f]{64}", expected_hash) is not None, "INVALID_SHA256")
    temp = None
    total = 0
    sha = hashlib.sha256()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"cf-ops-agent/1"}), timeout=45) as response:
            with tempfile.NamedTemporaryFile(dir=dest.parent, prefix=".cfops-fetch-", delete=False) as f:
                temp = f.name
                os.chmod(temp, 0o600)
                while True:
                    chunk = response.read(1024*1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    must(total <= MAX_UPLOAD, "DOWNLOAD_TOO_LARGE")
                    sha.update(chunk)
                    f.write(chunk)
                f.flush()
                os.fsync(f.fileno())
        if expected is not None:
            must(total == int(expected), "SIZE_MISMATCH")
        if expected_hash:
            must(sha.hexdigest() == expected_hash, "SHA256_MISMATCH")
        os.replace(temp, dest)
        temp = None
        return dict(dest_path=str(dest), size_bytes=total, sha256=sha.hexdigest())
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)

def upload(a):
    action = a.get("action", "start")
    if action == "start":
        dest = data_path(a["path"])
        size = int(a["size_bytes"])
        must(0 <= size <= MAX_UPLOAD, "INVALID_UPLOAD_SIZE")
        must(dest.parent.is_dir(), "DEST_PARENT_MISSING")
        ticket = uuid.uuid4().hex
        temp = ROOT/"uploads"/(ticket+".part")
        with temp.open("xb"):
            pass
        json_write(ROOT/"uploads"/(ticket+".json"), dict(path=str(dest), size=size,
                    offset=0, expected_sha256=a.get("sha256"), created=time.time()))
        return dict(upload_id=ticket, offset=0, size_bytes=size, max_chunk_bytes=MAX_FILE_CHUNK)
    ticket = a.get("upload_id")
    must(isinstance(ticket, str) and SAFE_JOB_ID.fullmatch(ticket), "INVALID_UPLOAD_ID")
    meta = ROOT/"uploads"/(ticket+".json")
    part = ROOT/"uploads"/(ticket+".part")
    with LOCK:
        x = json_read(meta)
        must(time.time()-x["created"] < 3600, "UPLOAD_EXPIRED")
        if action == "status":
            return dict(upload_id=ticket, offset=x["offset"], size_bytes=x["size"])
        if action == "chunk":
            offset = int(a["offset"])
            data = base64.b64decode(a["content_base64"], validate=True)
            must(0 < len(data) <= MAX_FILE_CHUNK, "INVALID_CHUNK")
            must(offset == x["offset"], "UPLOAD_OFFSET_MISMATCH")
            must(offset+len(data) <= x["size"], "UPLOAD_OVERFLOW")
            with part.open("r+b") as f:
                f.seek(offset)
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            x["offset"] += len(data)
            json_write(meta, x)
            return dict(upload_id=ticket, offset=x["offset"], complete=x["offset"] == x["size"])
        if action == "finish":
            must(x["offset"] == x["size"], "UPLOAD_INCOMPLETE")
            sha = hashlib.sha256()
            with part.open("rb") as f:
                for chunk in iter(lambda:f.read(1024*1024), b""):
                    sha.update(chunk)
            if x["expected_sha256"]:
                must(sha.hexdigest() == x["expected_sha256"], "SHA256_MISMATCH")
            dest = data_path(x["path"])
            os.replace(part, dest)
            meta.unlink()
            return dict(path=str(dest), size_bytes=x["size"], sha256=sha.hexdigest(), complete=True)
        if action == "cancel":
            meta.unlink(missing_ok=True)
            part.unlink(missing_ok=True)
            return dict(cancelled=True)
    raise Problem("INVALID_UPLOAD_ACTION")

def job_record(job_id):
    must(isinstance(job_id, str) and SAFE_JOB_ID.fullmatch(job_id), "INVALID_JOB_ID")
    return ROOT/"jobs"/(job_id+".json")

def job_status(a):
    x = json_read(job_record(a["job_id"]))
    pid = x.get("pid")
    live = False
    if pid:
        try:
            os.kill(pid, 0)
            live = True
        except ProcessLookupError:
            pass
    return dict(job_id=a["job_id"], running=live and x.get("exit_code") is None, label=x.get("label"),
                exit_code=x.get("exit_code"), created=x["created"],
                completed=x.get("completed"), pid=pid)

def job_run(job_id):
    p = job_record(job_id)
    x = json_read(p)
    out, err = ROOT/"jobs"/(job_id+".out"), ROOT/"jobs"/(job_id+".err")
    with out.open("wb") as o, err.open("wb") as e:
        try:
            proc = subprocess.Popen(["/bin/sh", "-c", x["command"]], cwd=x.get("cwd") or None,
                   env={**os.environ, **x.get("env", {})}, stdin=subprocess.DEVNULL, stdout=o, stderr=e,
                   start_new_session=True)
            with LOCK:
                y = json_read(p); y["child_pgid"] = proc.pid; json_write(p, y)
            try:
                exit_code = proc.wait(timeout=x["timeout_s"])
            except subprocess.TimeoutExpired:
                kill_group(proc.pid)
                proc.wait()
                exit_code = 124
        except Exception:
            exit_code = 127
    with LOCK:
        x = json_read(p)
        x["exit_code"] = exit_code
        x["completed"] = now()
        x.pop("command", None)
        x.pop("env", None)
        json_write(p, x)

def server_exec(a):
    cmd = a.get("command")
    must(isinstance(cmd, str) and 0 < len(cmd) <= 16000, "INVALID_COMMAND")
    cwd = a.get("cwd") or None
    if cwd is not None:
        must(data_path(cwd).is_dir(), "INVALID_CWD")
    timeout = int(a.get("timeout_s") or (3600 if a.get("background") else 60))
    must(1 <= timeout <= (86400 if a.get("background") else 600), "INVALID_TIMEOUT")
    env = a.get("env") or {}
    must(isinstance(env, dict) and len(env) <= 64 and
         all(isinstance(k,str) and re.fullmatch("[A-Za-z_][A-Za-z0-9_]*",k) and isinstance(v,str) and len(v)<4000 for k,v in env.items()), "INVALID_ENV")
    if a.get("background"):
        job_id = uuid.uuid4().hex
        info = dict(command=cmd, cwd=cwd, env=env, timeout_s=timeout, created=now(), exit_code=None,
                    label=str(a.get("label") or "")[:120])
        json_write(job_record(job_id), info)
        proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--job-run", job_id],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, start_new_session=True, env=os.environ.copy())
        info["pid"] = proc.pid
        json_write(job_record(job_id), info)
        return dict(job_id=job_id, background=True, pid=proc.pid)
    start = time.monotonic()
    proc = subprocess.Popen(["/bin/sh", "-c", cmd], cwd=cwd, env={**os.environ, **env},
           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        kill_group(proc.pid)
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = b"", b""
        code, err = 124, (err or b"") + b"\nTIMEOUT"
    return dict(exit_code=code, stdout=limit_text(out), stderr=limit_text(err),
                duration_ms=int((time.monotonic()-start)*1000), background=False)

def kill_group(pgid):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(1)

def job_output(a):
    key = a["job_id"]
    job_record(key)
    out = {}
    for name in ("stdout","stderr"):
        p = ROOT/"jobs"/(key+("."+"out" if name=="stdout" else ".err"))
        offset = int(a.get(name+"_offset") or 0)
        size = p.stat().st_size if p.exists() else 0
        must(0 <= offset <= size, "INVALID_OFFSET")
        if p.exists():
            with p.open("rb") as f:
                f.seek(offset)
                chunk = f.read(65536)
        else:
            chunk = b""
        out[name] = limit_text(chunk, 65536)
        out["next_"+name+"_offset"] = offset + len(chunk)
        out[name+"_size"] = size
    return dict(job_id=key, **out)

def job_kill(a):
    key = a["job_id"]
    x = json_read(job_record(key))
    status = job_status(dict(job_id=key))
    must(status["running"], "JOB_NOT_RUNNING")
    must(x.get("child_pgid"), "JOB_NOT_STARTED")
    kill_group(x["child_pgid"])
    return dict(job_id=key, signalled=True)

def job_list(_a):
    rows = []
    for p in sorted((ROOT/"jobs").glob("*.json"), key=lambda p:p.stat().st_mtime, reverse=True)[:100]:
        try: rows.append(job_status(dict(job_id=p.stem)))
        except (OSError, Problem): pass
    return dict(jobs=rows)

def server_status(_a):
    import platform, pwd
    du = shutil.disk_usage("/")
    try:
        load = os.getloadavg()
    except OSError:
        load = None
    try:
        up = float(open("/proc/uptime").read().split()[0])
    except OSError:
        up = None
    gh = (ROOT/"github"/"token.json").exists()
    return dict(version=VERSION, user=pwd.getpwuid(os.getuid()).pw_name, uid=os.getuid(), gid=os.getgid(),
                host=platform.node(), python=platform.python_version(), cwd=os.getcwd(), home=os.environ.get("HOME"),
                disk_root=dict(total=du.total, used=du.used, free=du.free), load=load, uptime_s=up,
                github_logged_in=gh, state_dir=str(ROOT), time=now())

METHODS = {
    "server_exec":server_exec, "server_job_status":job_status,
    "server_job_output":job_output, "server_job_list":job_list, "server_job_kill":job_kill,
    "server_file_read":file_read, "server_file_write":file_write,
    "server_file_edit":file_edit, "server_file_delete":file_delete,
    "server_file_list":file_list, "server_file_stat":file_stat,
    "server_file_move":file_move, "server_file_copy":file_copy,
    "server_file_search":file_search, "server_file_fetch":file_fetch,
    "server_file_upload":upload, "server_status":server_status,
}

def dispatch(op, args):
    if op in METHODS:
        return METHODS[op](args)
    if op.startswith("github_"):
        return GithubAPI(ROOT).call(op, args)
    raise Problem("UNKNOWN_TOOL")

def handle(r):
    start = time.monotonic()
    caller, op, args = r.get("caller") or "cf-mcp", r.get("op"), r.get("args", {})
    must(isinstance(caller,str) and len(caller) < 200, "INVALID_CALLER")
    must(isinstance(op,str) and isinstance(args,dict), "INVALID_REQUEST")
    try:
        data = dispatch(op, args)
        result = dict(ok=True, result=data)
        code = "OK"
    except Exception as e:
        code = getattr(e, "code", None) or type(e).__name__.upper()
        msg = secret_scrub(str(e))[:400] if not isinstance(e, Problem) or str(e) != code else code
        result = dict(ok=False, error=dict(code=code, message=msg))
    duration = int((time.monotonic()-start)*1000)
    result["duration_ms"] = duration
    try: audit(caller, op, args, code, duration, len(json.dumps(result)))
    except OSError:
        return dict(ok=False, error=dict(code="AUDIT_UNAVAILABLE", message="AUDIT_UNAVAILABLE"))
    if len(json.dumps(result).encode()) > MAX_RESULT:
        return dict(ok=False,error=dict(code="RESULT_TOO_LARGE",message="Use smaller length/offset or a background job"))
    return result

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            import struct, socket as _s
            cred = self.request.getsockopt(_s.SOL_SOCKET, _s.SO_PEERCRED, struct.calcsize("3i"))
            _pid, uid, _gid = struct.unpack("3i", cred)
            if uid not in ALLOWED_UIDS:
                self.wfile.write(b'{"ok":false,"error":{"code":"PEER_FORBIDDEN","message":"PEER_FORBIDDEN"}}\n')
                return
            raw = self.rfile.readline(MAX_REQUEST + 1)
            must(raw.endswith(b"\n") and len(raw) <= MAX_REQUEST, "INVALID_FRAME")
            req = json.loads(raw)
            must(isinstance(req,dict), "INVALID_REQUEST")
            result = handle(req)
        except Exception:
            result = dict(ok=False,error=dict(code="INVALID_REQUEST",message="INVALID_REQUEST"))
        self.wfile.write((json.dumps(result, ensure_ascii=False, separators=(",",":"))+"\n").encode())

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

def serve():
    make_root()
    parent = pathlib.Path(SOCKET).parent
    must(parent.is_dir(), "SOCKET_PARENT_MISSING")
    if os.path.lexists(SOCKET):
        must(stat.S_ISSOCK(os.lstat(SOCKET).st_mode), "SOCKET_PATH_OCCUPIED")
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as server:
        group = os.environ.get("CF_OPS_SOCKET_GID")
        if group:
            os.chown(SOCKET, -1, int(group))
        os.chmod(SOCKET, int(os.environ.get("CF_OPS_SOCKET_MODE", "666"), 8))
        server.serve_forever(poll_interval=0.2)

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--job-run":
        make_root()
        job_run(sys.argv[2])
    elif len(sys.argv) == 1:
        serve()
    else:
        sys.exit(2)
