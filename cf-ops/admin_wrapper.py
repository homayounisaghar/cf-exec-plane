#!/usr/bin/env python3
"""Root-owned, narrowly callable sudo wrapper for a CF-confirmed admin request.

Only CF-server (NOT the host helper user) holds the bridge signing key.
Root owns the key and pending records. The host helper may request an
approval ONLY with CF's HMAC signature, and can execute ONLY once after
a delivered, ten-minute, six-digit OTP verified under root's private key.
Request contents, OTP, and signatures never appear in argv, logs or stdout.
"""
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

STATE = pathlib.Path(os.environ.get("CF_ADMIN_ROOT_STATE","/var/lib/cf-ops-admin"))
KEYFILE = pathlib.Path(os.environ.get("CF_ADMIN_BRIDGE_KEY","/etc/capability-fabric/secrets/cf-admin-bridge.key"))
MAX_STDIN = 32768
EXPIRE = 600
MAX_TRIES = 5

def now():
    return datetime.now(timezone.utc).isoformat()

def write_json(p, value):
    temp=p.with_name(p.name+"."+uuid.uuid4().hex+".tmp")
    with temp.open("x") as f:
        os.chmod(temp,0o600)
        json.dump(value,f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp,p)
    os.chmod(p,0o600)

def load_json(p):
    with p.open() as f:
        return json.load(f)

def digest(key, code, nonce):
    return hmac.new(key, (nonce+":"+code).encode(),hashlib.sha256).hexdigest()

def cap(data, size=20000):
    s=data.decode("utf-8","replace") if isinstance(data,bytes) else str(data)
    if len(s)>size:
        half=(size-12)//2
        s=s[:half]+"\n...cut...\n"+s[-half:]
    s=re.sub(r"(gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+)","(hidden)",s,flags=re.I)
    s=re.sub(r"((?:password|token|secret|api[_-]?key)\s*[=:]\s*)\S+",r"\1(hidden)",s,flags=re.I)
    return s

def verify_signature(request,key):
    raw=request.get("signed_payload")
    sig=request.get("signature")
    if not isinstance(raw,str) or not isinstance(sig,str) or len(raw)>20000:
        raise ValueError("SIGNED_REQUEST_REQUIRED")
    want=hmac.new(key,raw.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want,sig):
        raise ValueError("BAD_SIGNATURE")
    payload=json.loads(raw)
    if not isinstance(payload,dict) or not isinstance(payload.get("created_at"),int):
        raise ValueError("BAD_PAYLOAD")
    if abs(time.time()-payload["created_at"])>60:
        raise ValueError("REQUEST_TOO_OLD")
    if not re.fullmatch(r"cfsub_[a-f0-9]{64}",str(payload.get("caller",""))):
        raise ValueError("OWNER_FINGERPRINT_REQUIRED")
    return payload

def run(command):
    began=time.monotonic()
    try:
        completed=subprocess.run(["/bin/sh","-c",command], stdin=subprocess.DEVNULL,
                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600,
                  cwd="/",start_new_session=True,env={"PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","LANG":"C.UTF-8"})
        return dict(exit_code=completed.returncode,stdout=cap(completed.stdout),
                    stderr=cap(completed.stderr),duration_ms=int((time.monotonic()-began)*1000))
    except subprocess.TimeoutExpired as exc:
        return dict(exit_code=124,stdout=cap(exc.stdout or b""),stderr=cap((exc.stderr or b"")+b"\nTIMEOUT"),
                    duration_ms=int((time.monotonic()-began)*1000))

def dispatch(request,key):
    action=request.get("action")
    if action in ("request","delivered","cancel"):
        p=verify_signature(request,key)
        if p.get("action") != action:
            raise ValueError("SIGNED_ACTION_MISMATCH")
    else:
        p=request
    if action=="request":
        cmd,reason,code=p.get("command"),p.get("reason"),p.get("code")
        req_id=p.get("request_id")
        if not isinstance(cmd,str) or not 1<=len(cmd)<=16000 or "\x00" in cmd:
            raise ValueError("INVALID_COMMAND")
        if not isinstance(reason,str) or not 1<=len(reason)<=1000:
            raise ValueError("INVALID_REASON")
        if not re.fullmatch("[0-9]{6}",str(code)) or not re.fullmatch("[0-9a-f]{32}",str(req_id)):
            raise ValueError("INVALID_CODE_OR_ID")
        path=STATE/(req_id+".json")
        if path.exists():
            raise ValueError("REQUEST_EXISTS")
        salt=os.urandom(24).hex()
        write_json(path,dict(id=req_id,command=cmd,reason=reason,caller=p["caller"],
                    nonce=salt,code_hash=digest(key,code,salt),created=time.time(),
                    expires=time.time()+EXPIRE,status="pending_delivery",tries=0))
        return dict(request_id=req_id,expires_after_seconds=EXPIRE,status="pending_delivery")
    if action in ("delivered","cancel","approve"):
        req_id=p.get("request_id")
        if not re.fullmatch("[0-9a-f]{32}",str(req_id)):
            raise ValueError("INVALID_REQUEST_ID")
        path=STATE/(req_id+".json")
        x=load_json(path)
        if action=="delivered":
            if p["caller"]!=x["caller"] or x["status"]!="pending_delivery" or time.time()>=x["expires"]:
                raise ValueError("DELIVERY_REJECTED")
            x["status"]="pending"
            write_json(path,x)
            return dict(request_id=req_id,status="pending",expires_after_seconds=max(0,int(x["expires"]-time.time())))
        if action=="cancel":
            if p["caller"]!=x["caller"] or x["status"] not in ("pending_delivery","pending"):
                raise ValueError("CANCEL_REJECTED")
            x["status"]="cancelled"
            x.pop("code_hash",None)
            write_json(path,x)
            return dict(request_id=req_id,status="cancelled")
        code=p.get("code")
        if not isinstance(code,str) or not re.fullmatch("[0-9]{6}",code):
            raise ValueError("INVALID_APPROVAL_CODE")
        if x["status"]!="pending" or time.time()>x["expires"] or x["tries"]>=MAX_TRIES:
            raise ValueError("APPROVAL_NOT_PENDING")
        x["tries"]+=1
        valid=hmac.compare_digest(digest(key,code,x["nonce"]),x["code_hash"])
        if not valid:
            if x["tries"]>=MAX_TRIES:
                x["status"]="locked"
            write_json(path,x)
            raise ValueError("APPROVAL_CODE_REJECTED")
        # Mark consumed on root-owned disk BEFORE starting the root shell.
        x["status"]="running"
        x.pop("code_hash",None)
        write_json(path,x)
        result=run(x["command"])
        x["status"]="finished"
        x["completed"]=now()
        x["exit_code"]=result["exit_code"]
        # No duplicate admin command is allowed to run after an error or crash.
        write_json(path,x)
        return dict(request_id=req_id,status="finished",**result)
    if action=="list":
        rows=[]
        for p in sorted(STATE.glob("*.json"),key=lambda i:i.stat().st_mtime,reverse=True)[:100]:
            try:
                x=load_json(p)
                rows.append(dict(request_id=x["id"],reason=x["reason"],status=x["status"],
                                 created_at=x["created"],expires_at=x["expires"],
                                 exit_code=x.get("exit_code")))
            except Exception:
                pass
        return dict(requests=rows)
    raise ValueError("UNKNOWN_ACTION")

def main():
    if os.geteuid()!=0:
        raise ValueError("MUST_RUN_AS_ROOT")
    if not KEYFILE.is_file() or KEYFILE.stat().st_uid!=0 or KEYFILE.stat().st_mode&0o077:
        raise ValueError("BRIDGE_KEY_UNSAFE")
    key=KEYFILE.read_bytes()
    if len(key)!=32:
        raise ValueError("BRIDGE_KEY_INVALID")
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(STATE,0o700)
    raw=sys.stdin.buffer.read(MAX_STDIN+1)
    if len(raw)>MAX_STDIN:
        raise ValueError("REQUEST_TOO_LARGE")
    req=json.loads(raw)
    if not isinstance(req,dict):
        raise ValueError("INVALID_REQUEST")
    with (STATE/"lock").open("a+") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=dispatch(req,key)
    sys.stdout.write(json.dumps(result,separators=(",",":"))+"\n")

if __name__=="__main__":
    try: main()
    except Exception:
        # No sensitive reason or payload in stderr, journal or MCP outputs.
        sys.stderr.write("ADMIN_REQUEST_REJECTED\n")
        sys.exit(1)
