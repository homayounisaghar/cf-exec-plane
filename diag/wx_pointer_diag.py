"""HOVER-ONLY pointer diagnostic for WeChat on :97. No click, no key, no text.
Prints only geometry numbers and booleans. Run from /tmp/wxeng via with_wechat_env.sh."""
import os, subprocess, sys
os.environ.setdefault("WX_GATE_F_TARGET","diag")
sys.path.insert(0, os.getcwd())
import benchmark_gate_f_readsafe as f
from engine import TARGETS
from atspi_backend import AtspiBackend

def sh(*a):
    p=subprocess.run(a,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,check=False)
    return p.returncode, p.stdout.decode("ascii","replace")

def kv(txt):
    d={}
    for l in txt.splitlines():
        if "=" in l:
            k,v=l.split("=",1); d[k.strip()]=v.strip()
    return d

def geo(w):
    rc,o=sh("xdotool","getwindowgeometry","--shell",str(w)); g=kv(o)
    return "rc=%d x=%s y=%s w=%s h=%s"%(rc,g.get("X"),g.get("Y"),g.get("WIDTH"),g.get("HEIGHT"))

b=AtspiBackend(); snap=b.snapshot()
R=lambda r: "x=%d y=%d w=%d h=%d"%(r.x,r.y,r.w,r.h) if r else "None"
ml={f._norm_label(x) for x in TARGETS["main_frame"].labels}
frames=[n for n in snap.nodes if n.role.casefold() in ("frame","window") and n.visible() and n.rect]
for n in frames:
    print("DIAG_ATSPI_TOPLEVEL role=%s is_main=%s depth=%d %s"%(n.role.replace(" ","_"), f._norm_label(n.name) in ml, len(n.path), R(n.rect)))
sl={f._norm_label(x) for x in TARGETS["send_button"].labels}
sends=[n for n in snap.nodes if n.role.casefold() in ("button","push button") and n.visible() and n.rect and f._norm_label(n.name) in sl]
print("DIAG_SEND_CANDIDATES count=%d"%len(sends))
for n in sends: print("DIAG_SEND enabled=%s %s"%(n.enabled(), R(n.rect)))
rc,o=sh("xdotool","getdisplaygeometry"); print("DIAG_X_DISPLAY rc=%d size=%s"%(rc,o.strip()))
rc,o=sh("pgrep","-u",str(os.getuid()),"-x","wechat"); pids=o.split()
print("DIAG_WECHAT_PIDS count=%d"%len(pids))
for pid in pids[:2]:
    rc,o=sh("xdotool","search","--onlyvisible","--pid",pid)
    for w in o.split()[:12]: print("DIAG_X_WINDOW pid_match=True id=%s %s"%(w,geo(w)))
if len(sends)==1:
    r=sends[0].rect; x,y=r.x+r.w//2,r.y+r.h//2
    hit=b.hit_test(x,y)
    print("DIAG_HIT x=%d y=%d hit_is_send=%s"%(x,y, bool(hit and hit.path==sends[0].path)))
    rc,_=sh("xdotool","mousemove",str(x),str(y))
    rc2,o=sh("xdotool","getmouselocation","--shell"); loc=kv(o)
    print("DIAG_HOVER move_rc=%d loc_rc=%d X=%s Y=%s WINDOW=%s"%(rc,rc2,loc.get("X"),loc.get("Y"),loc.get("WINDOW")))
    if loc.get("WINDOW","").isdigit(): print("DIAG_WINDOW_UNDER_POINTER %s"%geo(loc["WINDOW"]))
    rc,o=sh("xdotool","getactivewindow"); print("DIAG_ACTIVE_WINDOW rc=%d id=%s"%(rc,o.strip()))
print("DIAG_DONE no_click=True no_key=True")
