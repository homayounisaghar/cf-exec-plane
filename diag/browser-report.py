#!/usr/bin/env python3
"""Read-only report: per Chrome instance memory, tabs, age. Changes nothing."""
import os, re, json, time, urllib.request
ticks=os.sysconf("SC_CLK_TCK"); boot=time.time()-float(open("/proc/uptime").read().split()[0])
P={}
for d in os.listdir("/proc"):
    if not d.isdigit(): continue
    try:
        st=open(f"/proc/{d}/status").read()
        cmd=open(f"/proc/{d}/cmdline","rb").read().split(b"\0")
        cmd=[c.decode("utf-8","replace") for c in cmd if c]
        stat=open(f"/proc/{d}/stat").read().rsplit(")",1)[1].split()
    except Exception: continue
    g=lambda k:int((re.search(rf"^{k}:\s+(\d+)",st,re.M) or [0,0])[1])
    uid=int(re.search(r"^Uid:\s+(\d+)",st,re.M)[1])
    try: import pwd; user=pwd.getpwuid(uid).pw_name
    except Exception: user=str(uid)
    P[int(d)]=dict(ppid=int(stat[1]),start=boot+int(stat[19])/ticks,user=user,
        name=re.search(r"^Name:\s+(.*)",st,re.M)[1],kb=g("VmRSS")+g("VmSwap"),cmd=cmd)
kids={}
for p,v in P.items(): kids.setdefault(v["ppid"],[]).append(p)
def tree(p):
    out=[p]
    for c in kids.get(p,[]): out+=tree(c)
    return out
isch=lambda v: re.search(r"chrom",v["name"]+" "+(v["cmd"][0] if v["cmd"] else ""),re.I)
roots=[p for p,v in P.items() if isch(v) and not any(a.startswith("--type=") for a in v["cmd"])
       and not (v["ppid"] in P and isch(P[v["ppid"]]))]
rows=[];tot=0
for r in roots:
    v=P[r]; t=tree(r); kb=sum(P[x]["kb"] for x in t); tot+=kb
    rend=sum(1 for x in t if "--type=renderer" in P[x]["cmd"])
    arg=lambda k: next((a.split("=",1)[1] for a in v["cmd"] if a.startswith(k+"=")),"")
    port=arg("--remote-debugging-port"); tabs="?"
    if port and port!="0":
        try:
            j=json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list",timeout=2))
            tabs=str(sum(1 for x in j if x.get("type")=="page"))
        except Exception: tabs="?"
    disp=""
    try:
        env=open(f"/proc/{r}/environ","rb").read().split(b"\0")
        disp=next((e.decode()[8:] for e in env if e.startswith(b"DISPLAY=")),"-")
    except Exception: disp="n/a"
    prof=os.path.basename(arg("--user-data-dir").rstrip("/"))[:22] or "-"
    hl="H" if any(a.startswith("--headless") for a in v["cmd"]) else ""
    age=(time.time()-v["start"])/3600
    rows.append((kb,f"{kb//1024:5d}MB {len(t):3d}p rend={rend:2d} tabs={tabs:>2} {age:5.1f}h {v['user'][:10]:10} pid={r} disp={disp} {hl} {prof}"))
for _,s in sorted(rows,reverse=True): print(s)
print(f"TOTAL chrome instances={len(rows)} {tot//1024}MB")
m=open("/proc/meminfo").read(); f=lambda k:int(re.search(rf"^{k}:\s+(\d+)",m,re.M)[1])//1024
print(f"MemAvailable={f('MemAvailable')}MB SwapFree={f('SwapFree')}MB")
