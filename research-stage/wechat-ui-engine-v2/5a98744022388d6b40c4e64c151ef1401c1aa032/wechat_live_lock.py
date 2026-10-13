"""Process-exclusive advisory lock for EVERY WeChat UI effect.

Scope: /tmp/wxeng/wechat-live.lock, user cfop (uid 1000).
The OS flock, not a racy PID test, is the source of exclusion. Metadata is
diagnostic only. A dead previous owner is safely superseded on acquisition.
No override flag, force mode, or stale-lock deletion.
"""
from __future__ import annotations
import datetime
import fcntl
import json
import os
from pathlib import Path
import secrets
import stat
import time
from engine import UIBlocked

LOCK_PATH=Path("/tmp/wxeng/wechat-live.lock")
_current=None

def _pid_alive(pid):
    if type(pid) is not int or pid<1:
        return False
    try:
        os.kill(pid,0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True

def _proc_start(pid):
    try:
        data=Path("/proc")/str(pid)/"stat"
        raw=data.read_text()
        return raw[raw.rfind(")")+2:].split()[19]  # /proc field 22
    except (OSError,ValueError,IndexError):
        return None

def _metadata(fd):
    try:
        os.lseek(fd,0,os.SEEK_SET)
        raw=os.read(fd,2048)
        obj=json.loads(raw)
        return obj if isinstance(obj,dict) else {}
    except Exception:
        return {}

def _safe_file(fd):
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1:
        raise UIBlocked("WECHAT_LIVE_LOCK_FILE_UNSAFE")
    return st

class WeChatLiveLock:
    """One per process. Do not share with subprocesses/fork; hold entire action."""

    def __init__(self,*,path=LOCK_PATH,clock=time.time):
        self.path=Path(path)
        self.clock=clock
        self.fd=None
        self.info=None
        self.takeover_stale=False

    def __enter__(self):
        global _current
        if _current is not None:
            raise UIBlocked("WECHAT_LIVE_LOCK_ALREADY_HELD_IN_PROCESS")
        if os.getuid()!=1000:
            raise UIBlocked("WECHAT_LIVE_LOCK_WRONG_UID")
        p=self.path
        root=p.parent
        try:
            rst=root.lstat()
        except OSError:
            raise UIBlocked("WECHAT_LIVE_LOCK_DIRECTORY_MISSING")
        if (not stat.S_ISDIR(rst.st_mode) or rst.st_uid!=os.getuid()
                or rst.st_mode & 0o022):
            raise UIBlocked("WECHAT_LIVE_LOCK_DIRECTORY_UNSAFE")
        flags=os.O_RDWR|os.O_CREAT|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_CLOEXEC",0)
        try:
            fd=os.open(p,flags,0o600)
        except OSError:
            raise UIBlocked("WECHAT_LIVE_LOCK_OPEN_FAILED")
        try:
            _safe_file(fd)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                owner=_metadata(fd)
                holder=owner.get("pid")
                code=("WECHAT_LIVE_LOCK_HELD_PID_"+str(holder)
                      if _pid_alive(holder) and str(holder).isdigit()
                      else "WECHAT_LIVE_LOCK_BUSY_UNKNOWN")
                raise UIBlocked(code)
            previous=_metadata(fd)
            prior_pid=previous.get("pid")
            # If previous PID alive but its proc start differs, it is a reused
            # PID, not the previous owner. flock remains authoritative.
            prior_start=previous.get("proc_start")
            self.takeover_stale=bool(type(prior_pid) is int and prior_pid>0 and
                (not _pid_alive(prior_pid) or
                 (prior_start is not None and _proc_start(prior_pid)!=prior_start)))
            now=self.clock()
            info={"pid":os.getpid(),
                  "run_id":secrets.token_hex(12),
                  "started_at":datetime.datetime.fromtimestamp(
                      now,datetime.timezone.utc).isoformat(timespec="seconds"),
                  "proc_start":_proc_start(os.getpid()),
                  "status":"held"}
            data=(json.dumps(info,sort_keys=True,ensure_ascii=True)+"\n").encode("ascii")
            os.ftruncate(fd,0)
            os.lseek(fd,0,os.SEEK_SET)
            os.write(fd,data)
            os.fsync(fd)
            self.info=info
            self.fd=fd
            _current=self
            return self
        except Exception:
            os.close(fd)
            raise

    def __exit__(self,exc_type,exc,tb):
        global _current
        if self.fd is None:
            return False
        try:
            # Explicit release metadata remains on disk, preserving run
            # provenance and allowing a new pid to acquire normally.
            state=dict(self.info or {})
            state["status"]="released"
            state["ended_at"]=datetime.datetime.now(datetime.timezone.utc).isoformat(
                timespec="seconds")
            data=(json.dumps(state,sort_keys=True)+"\n").encode("ascii")
            os.ftruncate(self.fd,0)
            os.lseek(self.fd,0,os.SEEK_SET)
            os.write(self.fd,data)
            os.fsync(self.fd)
        finally:
            _current=None
            try:
                fcntl.flock(self.fd,fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd=None
        return False

def require_wechat_lock():
    lock=_current
    if (lock is None or lock.fd is None or lock.info is None or
            lock.info.get("pid")!=os.getpid()):
        raise UIBlocked("WECHAT_LIVE_ACTION_WITHOUT_LOCK")
    try:
        st=_safe_file(lock.fd)
        path_st=lock.path.lstat()
        if (st.st_ino!=path_st.st_ino or st.st_dev!=path_st.st_dev):
            raise UIBlocked("WECHAT_LIVE_LOCK_PATH_REPLACED")
    except OSError:
        raise UIBlocked("WECHAT_LIVE_LOCK_LOST")
    return True

def lock_status():
    """Read metadata only; never asserts ownership in another process."""
    try:
        with open(LOCK_PATH,"rb") as reader:
            raw=reader.read(2048)
        m=json.loads(raw)
        return {k:m.get(k) for k in ("pid","run_id","started_at","status")}
    except Exception:
        return {}
