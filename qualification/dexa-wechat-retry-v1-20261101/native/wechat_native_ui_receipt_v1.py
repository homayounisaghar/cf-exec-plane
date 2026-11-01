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

FAILED_VIDEO_ROW=re.compile(r'(?i)^Unable to send (video(?:[ \t]+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?)$')

def _visible_messages(rows,is_separator):
    return [str(x or '') for x in rows if not is_separator(str(x or ''))]

def classify_fresh_video(before,after,filename,is_separator):
    """Only one fresh final video; any number of old prefix rows may be evicted.
    Require a retained consecutive suffix anchor. Never infer from a lone
    screenshot, a changed old row or a completely disjoint viewport.
    """
    if not isinstance(filename,str) or Path(filename).suffix.lower() not in VIDEO_EXTS:
        return None
    b=_visible_messages(before,is_separator)
    a=_visible_messages(after,is_separator)
    if not a or a==b:
        return None
    new=a[-1].strip()
    kind='FAILED' if FAILED_VIDEO_ROW.fullmatch(new) else (
        'CLEAN' if VIDEO_ROW.fullmatch(new) else None)
    if kind is None:
        return None
    if not b:
        return kind if len(a)==1 else None
    # The surviving pre-existing rows must be an unchanged suffix of BEFORE,
    # and the new final row must be the only inserted row.
    for lost in range(len(b)):
        if a[:-1]==b[lost:]:
            return kind
    return None

def fresh_video_row(before,after,filename,is_separator):
    return classify_fresh_video(before,after,filename,is_separator)=='CLEAN'

def fresh_failed_video_row(before,after,filename,is_separator):
    return classify_fresh_video(before,after,filename,is_separator)=='FAILED'

def resend_cleared_video_row(before_failed,after,filename,is_separator):
    """The known freshly failed tail, and not an unrelated bubble, is recovered."""
    if Path(filename).suffix.lower() not in VIDEO_EXTS:
        return False
    b=_visible_messages(before_failed,is_separator)
    a=_visible_messages(after,is_separator)
    if not b or not a or not FAILED_VIDEO_ROW.fullmatch(b[-1]):
        return False
    expected=b[-1][len('Unable to send '):]
    if a[-1]!=expected or b[-1] in a:
        return False
    old=b[:-1]
    if not old:
        return len(a)==1
    return any(a[:-1]==old[drop:] for drop in range(len(old)))

def red_failure_icon_pixel(image,mapper,failed_row,viewport):
    """Provider-native red failure glyph in whitespace left of the media.
    Require one 9-22px isolated red component; content pixels or ambiguity
    return None (fail closed). Coordinates are window-relative physical.
    """
    x0,y0,x1,y1=mapper.box(failed_row.rect,viewport)
    x0=max(0,x0+(x1-x0)*27//100)
    x1=min(image.width,x1-(x1-x0)*13//100)
    y0=max(0,y0+5)
    y1=min(image.height,y1-5)
    if x1-x0<50 or y1-y0<24:
        return None
    def red(x,y):
        r,g,b=image.getpixel((x,y))
        return r>=218 and 50<=g<=168 and 45<=b<=168 and r-g>=82
    pts=set()
    for y in range(y0,y1):
        for x in range(x0,x1):
            if red(x,y):pts.add((x,y))
    candidates=[]
    while pts:
        todo=[pts.pop()];component=[]
        while todo:
            x,y=todo.pop();component.append((x,y))
            for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                q=(x+dx,y+dy)
                if q in pts:
                    pts.remove(q);todo.append(q)
        if not 24<=len(component)<=240:
            continue
        xa=min(x for x,y in component);xb=max(x for x,y in component)
        ya=min(y for x,y in component);yb=max(y for x,y in component)
        if not 8<=xb-xa<=23 or not 8<=yb-ya<=23:
            continue
        cx=(xa+xb)//2;cy=(ya+yb)//2
        if abs((xb-xa)-(yb-ya))>5:
            continue
        # The failure mark floats on the blank chat background, not
        # inside the colored thumbnail.
        surround=((cx-14,cy),(cx+14,cy),(cx,cy-14),(cx,cy+14))
        if all(min(image.getpixel(q))>=215 for q in surround):
            candidates.append((cx,cy))
    return candidates[0] if len(candidates)==1 else None

def receipt_key(target,upload_id,digest):
    if (not isinstance(target,str) or not target or
        not isinstance(upload_id,str) or not HEX.fullmatch(upload_id) or
        not isinstance(digest,str) or not HEX.fullmatch(digest)):
        raise ValueError('WECHAT_UI_RECEIPT_IDENTITY_INVALID')
    payload='cf-file:'+upload_id+':'+digest
    return hashlib.sha256(('v10\0'+target+'\0'+payload).encode('utf8')).hexdigest()

def claim_one_ui_resend(target,upload_id,digest,root=MARKER):
    """Irreversible one-retry journal before touching the failure icon."""
    key=receipt_key(target,upload_id,digest)
    root=Path(root)
    ds=root.lstat()
    if not stat.S_ISDIR(ds.st_mode) or ds.st_uid!=os.getuid() or ds.st_mode&0o077:
        raise ValueError('WECHAT_UI_RETRY_DIRECTORY_UNSAFE')
    attempt=root/(key+'.attempt')
    st=attempt.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077:
        raise ValueError('WECHAT_UI_RETRY_ORIGINAL_MISSING')
    if attempt.read_bytes()!=b'ATTEMPTED_NO_RETRY\n':
        raise ValueError('WECHAT_UI_RETRY_ORIGINAL_INVALID')
    marker=root/(key+'.resend')
    fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:
        f.write(b'EXPLICIT_UI_FAILED_ROW_RETRY_ONCE\n')
        f.flush();os.fsync(f.fileno())
    dirfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(dirfd)
    finally:os.close(dirfd)
    return key

def record_verified_ui(target,upload_id,digest,filename,size,clicks,source,root=MARKER):
    if (clicks!=1 or source not in ('exact_filename_row','unique_video_row','failed_video_resend_once') or
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
    if source=='failed_video_resend_once':
        retry=root/(key+'.resend')
        rs=retry.lstat()
        if (not stat.S_ISREG(rs.st_mode) or rs.st_uid!=os.getuid() or
            rs.st_mode&0o077 or rs.st_mtime_ns<st.st_mtime_ns or
            retry.read_bytes()!=b'EXPLICIT_UI_FAILED_ROW_RETRY_ONCE\n'):
            raise ValueError('WECHAT_UI_RETRY_EVIDENCE_INVALID')
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
        'row_evidence':source,'resend_confirm_clicks':int(source=='failed_video_resend_once'),
        'observed_at_ns':str(now),
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
