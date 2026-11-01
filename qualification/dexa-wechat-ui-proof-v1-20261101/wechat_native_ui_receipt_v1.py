"""Provider-native durable outbound UI evidence (no send, no API receipt claim).

The helper owns the exclusive WeChat GUI lock and records observations only
after the unique fresh visible outgoing row and disabled composer are observed
following one physically attempted Send click.
"""
import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path

VIDEO_EXTS=frozenset(('.mp4','.mov','.m4v','.webm','.mkv','.avi','.3gp','.wmv'))
VIDEO_ROW=re.compile(r'(?i)^video(?:[ \\t]+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?$')
HEX=re.compile(r'^[0-9a-f]{64}$')
SCHEMA='cf.wechat.native-outbound-ui-receipt.v1'
MARKER=Path.home()/'.local/state/wechat-send-v10'

def fresh_video_row(before,after,filename,is_separator):
    if not isinstance(filename,str) or Path(filename).suffix.lower() not in VIDEO_EXTS:
        return False
    b=[str(x or '') for x in before if not is_separator(str(x or ''))]
    a=[str(x or '') for x in after if not is_separator(str(x or ''))]
    if not a or a==b or not VIDEO_ROW.fullmatch(a[-1].strip()):
        return False
    if len(a)==len(b)+1 and a[:-1]==b:
        return True
    # A WeChat viewport may evict the first old row as a new row appears.
    if len(a)==len(b) and len(b)>0 and a[:-1]==b[1:]:
        return True
    return False

def receipt_key(target,upload_id,digest):
    if (not isinstance(target,str) or not target or
        not isinstance(upload_id,str) or not HEX.fullmatch(upload_id) or
        not isinstance(digest,str) or not HEX.fullmatch(digest)):
        raise ValueError('WECHAT_UI_RECEIPT_IDENTITY_INVALID')
    payload='cf-file:'+upload_id+':'+digest
    return hashlib.sha256(('v10\0'+target+'\0'+payload).encode('utf8')).hexdigest()

def record_verified_ui(target,upload_id,digest,filename,size,clicks,source,root=MARKER):
    if (clicks!=1 or source not in ('exact_filename_row','unique_video_row') or
        not isinstance(filename,str) or not filename or not isinstance(size,int) or size<1):
        raise ValueError('WECHAT_UI_RECEIPT_UNQUALIFIED')
    key=receipt_key(target,upload_id,digest)
    root=Path(root)
    ds=root.lstat()
    if not stat.S_ISDIR(ds.st_mode) or ds.st_uid!=os.getuid() or ds.st_mode&0o077:
        raise ValueError('WECHAT_UI_RECEIPT_DIRECTORY_UNSAFE')
    attempt=root/(key+'.attempt')
    st=attempt.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077:
        raise ValueError('WECHAT_UI_RECEIPT_ATTEMPT_MISSING')
    now=time.time_ns()
    if st.st_mtime_ns>now:
        raise ValueError('WECHAT_UI_RECEIPT_TIME_INVALID')
    evidence={
        'schema':SCHEMA,'marker_key':key,'target':target,'upload_id':upload_id,
        'sha256_hex':digest,'filename':filename,'size_bytes':size,
        'state':'UI_OUTBOUND_OBSERVED','direction':'out',
        'fresh_outbound_row':True,'send_enabled_after':False,
        'send_clicks':1,'provider_send_performed':True,'provider_confirmed':False,
        'blind_retry_safe':False,'verification_source':'native_same_client_atspi_x11',
        'row_evidence':source,'observed_at_ns':str(now),
        'attempt_mtime_ns':str(st.st_mtime_ns)
    }
    raw=json.dumps(evidence,sort_keys=True,separators=(',',':')).encode()+b'\n'
    if len(raw)>4096:
        raise ValueError('WECHAT_UI_RECEIPT_OVERSIZED')
    file=root/(key+'.observed.json')
    temp=root/(key+'.observed.'+str(os.getpid())+'.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        # Hard link gives atomic NO-REPLACE semantics; an old witness cannot
        # be overwritten or silently refreshed for a later dispatch.
        os.link(temp,file,follow_symlinks=False)
        dfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(dfd)
        finally:os.close(dfd)
    finally:
        try:temp.unlink()
        except FileNotFoundError:pass
    return key
