#!/usr/bin/env python3
"""Add only the isolated Dexa Lite route to the live Caddy admin config."""
import json, sys, time, urllib.request
ADMIN="http://127.0.0.1:2019/config"
ROOT="/apps/http/servers/srv0/routes/0/handle/0/routes"
HOST="cf-onshape.duckdns.org"
PREFIX="/dexa-lite"
DIAL="127.0.0.1:9518"
ENTRY={"match":[{"path":[PREFIX,PREFIX+"/*"]}],
       "handle":[{"handler":"reverse_proxy","upstreams":[{"dial":DIAL}]}],
       "terminal":True}
def fetch(path=""):
    with urllib.request.urlopen(ADMIN+path,timeout=5) as res:
        return json.load(res),res.headers.get("Etag")
def paths(entry):
    return [p for m in entry.get("match",[]) for p in m.get("path",[])]
def ensure(dry=False):
    config,_=fetch()
    servers=config.get("apps",{}).get("http",{}).get("servers",{})
    srv=servers.get("srv0",{})
    if srv.get("listen")!=[":443"]:raise RuntimeError("TLS_443_SERVER_CHANGED")
    roots=srv.get("routes",[])
    if len(roots)!=1 or roots[0].get("match")!=[{"host":[HOST]}]:
        raise RuntimeError("EXPECTED_PUBLIC_HOST_ROUTE_CHANGED")
    handles=roots[0].get("handle",[])
    if len(handles)!=1 or handles[0].get("handler")!="subroute":
        raise RuntimeError("EXPECTED_PUBLIC_SUBROUTE_CHANGED")
    entries,etag=fetch(ROOT)
    matches=[(i,e) for i,e in enumerate(entries)
             if any(p==PREFIX or p.startswith(PREFIX+"/") for p in paths(e))]
    if matches:
        if len(matches)!=1 or matches[0][1]!=ENTRY:
            raise RuntimeError("EXISTING_DEXA_LITE_ROUTE_COLLISION")
        return "READY"
    for e in entries:
        for p in paths(e):
            if p.endswith("*") and PREFIX.startswith(p[:-1]):
                raise RuntimeError("EARLIER_WILDCARD_OVERLAPS_LITE")
    if dry:return "WOULD_ADD"
    if not etag:raise RuntimeError("CADDY_CONFIG_ETAG_MISSING")
    # Guarded atomic replacement; never overwrite a concurrent route update.
    insertion=1 if entries and paths(entries[0])==[
        "/dexa-mobile","/dexa-mobile/*"] else 0
    revised=entries[:insertion]+[ENTRY]+entries[insertion:]
    req=urllib.request.Request(ADMIN+ROOT,
        data=json.dumps(revised,separators=(",",":")).encode(),
        headers={"Content-Type":"application/json","If-Match":etag},
        method="PATCH")
    with urllib.request.urlopen(req,timeout=8) as response:
        if response.status not in (200,201,204):
            raise RuntimeError("CADDY_ATOMIC_UPDATE_REJECTED")
    after,_=fetch(ROOT)
    if ENTRY not in after or len(after)!=len(entries)+1:
        raise RuntimeError("CADDY_ROUTE_READBACK_FAILED")
    # Existing routes may only be reordered by the independent mobile keeper.
    old=[x for x in after if x!=ENTRY]
    if old!=entries and not (len(old)==len(entries) and sorted(map(
        lambda x:json.dumps(x,sort_keys=True),old))==sorted(map(
        lambda x:json.dumps(x,sort_keys=True),entries))):
        raise RuntimeError("CONCURRENT_ROUTES_CHANGED")
    return "ADDED"
if __name__=="__main__":
    dry="--check" in sys.argv[1:]
    watch="--watch" in sys.argv[1:]
    while True:
        try:
            outcome=ensure(dry)
            if not watch or outcome!="READY":
                print(json.dumps({"dexaLiteRoute":outcome,"path":PREFIX+"/"},ensure_ascii=False),flush=True)
        except Exception as exc:
            print(json.dumps({"dexaLiteRoute":"ERROR","reason":str(exc)[:130]}),file=sys.stderr,flush=True)
            if not watch:sys.exit(2)
        if not watch:break
        time.sleep(24)
