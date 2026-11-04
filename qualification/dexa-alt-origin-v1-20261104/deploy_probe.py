#!/usr/bin/env python3
"""Isolated Caddy hostname connectivity probe, strict readback and rollback.
No Dexa route, backend, catalog, credentials, or Caddy process restart.
Only the two existing route-keeper user units restart after exact-line guard change.
"""
import copy, hashlib, json, os, pathlib, socket, subprocess, sys, time, urllib.request, urllib.error
BASE=pathlib.Path("/home/cfserver/dexa-alt-origin-20261104")
HOST="dexa-probe.65-109-215-241.sslip.io"
IP="65.109.215.241"
ADMIN="http://127.0.0.1:2019/config"
OLD_HOST="cf-onshape.duckdns.org"
MOBILE=pathlib.Path("/home/cfserver/.local/share/dexa-mobile-gateway-20261023/ensure-caddy-route.py")
LITE=pathlib.Path("/home/cfserver/.local/share/dexa-lite-20261103/ensure_lite_route.py")
BACK=BASE/"backups"
UNITS=("dexa-mobile-route-keeper.service","dexa-lite-route-keeper.service")
EXPECTED={
 MOBILE:("6c1ebd0019a59cdb4c52204eca26c196c07c178df31d25ad2b22751cfdbba271","len(root)!=1","len(root)<1"),
 LITE:("166a0c50ff7bcd4bdb4e0859e8fe0513a926f382c85ec1a08bc56fe0994d7070","len(roots)!=1","len(roots)<1")
}
PROBE_ROUTE={
 "match":[{"host":[HOST]}],
 "handle":[{"handler":"static_response",
    "body":"DEXA_ALT_ORIGIN_TEST_OK\\nNo private data or Dexa access on this host.\\n",
    "headers":{"Content-Type":["text/plain; charset=utf-8"],"Cache-Control":["no-store"]}}],
 "terminal":True
}
ENV={**os.environ,"XDG_RUNTIME_DIR":"/run/user/1000"}

def read(path):
    with urllib.request.urlopen(ADMIN+path,timeout=5) as r:
        return json.load(r),r.headers.get("ETag")

def update(path,value,etag):
    if not etag:raise RuntimeError("MISSING_ETAG_"+path.replace("/","_"))
    req=urllib.request.Request(ADMIN+path,
        data=json.dumps(value,separators=(",",":")).encode("utf-8"),
        headers={"Content-Type":"application/json","If-Match":etag},method="PATCH")
    with urllib.request.urlopen(req,timeout=15) as r:
        if r.status not in (200,201,204):raise RuntimeError("CADDY_WRITE_HTTP_"+str(r.status))

def check_state():
    cfg,_=read("/")
    srv=cfg.get("apps",{}).get("http",{}).get("servers",{}).get("srv0",{})
    routes=srv.get("routes",[])
    policies=cfg.get("apps",{}).get("tls",{}).get("automation",{}).get("policies",[])
    if srv.get("listen")!=[":443"] or not routes or routes[0].get("match")!=[{"host":[OLD_HOST]}]:
        raise RuntimeError("PUBLIC_CADDY_BASE_ROUTE_CHANGED")
    if routes[0].get("handle",[{}])[0].get("handler")!="subroute":
        raise RuntimeError("PUBLIC_CADDY_BASE_HANDLER_CHANGED")
    if not policies or policies[0].get("subjects")!=[OLD_HOST]:
        raise RuntimeError("PUBLIC_CADDY_TLS_BASE_CHANGED")
    if sum(x.get("match")==PROBE_ROUTE["match"] for x in routes)>1 or sum(x.get("subjects")==[HOST] for x in policies)>1:
        raise RuntimeError("DUPLICATE_PROBE_COMPONENT")
    return routes,policies

def modify_watchers():
    BACK.mkdir(mode=0o700,parents=True,exist_ok=True)
    for p,(sha,old,new) in EXPECTED.items():
        raw=p.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=sha:
            raise RuntimeError("WATCHER_HASH_CHANGED_"+p.name)
        s=raw.decode("utf-8")
        if s.count(old)!=1 or s.count(new)!=0:
            raise RuntimeError("WATCHER_GUARD_UNEXPECTED_"+p.name)
        (BACK/p.name).write_bytes(raw)
        (BACK/p.name).chmod(0o600)
        target=s.replace(old,new)
        # Validate the modified guard before changing any live file.
        compile(target,str(p),"exec")
    for p,(sha,old,new) in EXPECTED.items():
        original=p.read_bytes().decode("utf-8")
        tmp=p.with_name(p.name+".dexa-alt-origin.tmp")
        tmp.write_text(original.replace(old,new),encoding="utf-8")
        tmp.chmod(0o600)
        tmp.replace(p)
    for unit in UNITS:
        subprocess.run(["systemctl","--user","restart",unit],check=True,env=ENV,timeout=18)
        subprocess.run(["systemctl","--user","is-active","--quiet",unit],check=True,env=ENV,timeout=5)

def restore_watchers():
    for p,(sha,old,new) in EXPECTED.items():
        b=BACK/p.name
        if not b.exists():continue
        now=p.read_text(encoding="utf-8")
        orig=b.read_bytes()
        # Never clobber an unrelated intervening change.
        if now==orig.decode("utf-8"):continue
        if now.count(new)!=1 or now.replace(new,old).encode("utf-8")!=orig:
            raise RuntimeError("WATCHER_CONCURRENT_CHANGE_"+p.name)
        tmp=p.with_name(p.name+".dexa-alt-rollback.tmp")
        tmp.write_bytes(orig);tmp.chmod(0o600);tmp.replace(p)
    for unit in UNITS:
        subprocess.run(["systemctl","--user","restart",unit],check=True,env=ENV,timeout=18)

def remove_own_caddy_parts():
    routes,policies=check_state()
    r=[x for x in routes if x!=PROBE_ROUTE]
    if len(r)!=len(routes):
        if len(r)!=len(routes)-1:raise RuntimeError("PROBE_ROUTE_COLLISION_ON_ROLLBACK")
        _,etag=read("/apps/http/servers/srv0/routes")
        update("/apps/http/servers/srv0/routes",r,etag)
    routes,policies=check_state()
    p=[x for x in policies if x.get("subjects")!=[HOST]]
    if len(p)!=len(policies):
        if len(p)!=len(policies)-1:raise RuntimeError("PROBE_POLICY_COLLISION_ON_ROLLBACK")
        _,etag=read("/apps/tls/automation/policies")
        update("/apps/tls/automation/policies",p,etag)

def verify_public(timeout_s=105):
    last="not-started"
    until=time.monotonic()+timeout_s
    while time.monotonic()<until:
        try:
            with urllib.request.urlopen("https://"+HOST+"/",timeout=8) as r:
                body=r.read(1000).decode()
                if r.status==200 and "DEXA_ALT_ORIGIN_TEST_OK" in body:
                    break
                last="probe_http_"+str(r.status)
        except Exception as e:
            last=type(e).__name__+":"+str(e)[:120]
        time.sleep(3)
    else:
        raise RuntimeError("PROBE_TLS_NOT_READY:"+last)
    # No regression to the original private UI or the local engine.
    try:
        urllib.request.urlopen("https://"+OLD_HOST+"/dexa-mobile/",timeout=8)
        raise RuntimeError("ORIGINAL_OWNER_AUTH_UNEXPECTED_OPEN")
    except urllib.error.HTTPError as e:
        if e.code!=401:raise RuntimeError("ORIGINAL_OWNER_AUTH_CHANGED_"+str(e.code))
    with urllib.request.urlopen("https://"+OLD_HOST+"/dexa-lite/check",timeout=8) as r:
        if r.status!=200:raise RuntimeError("ORIGINAL_LITE_DIAG_CHANGED")
    with urllib.request.urlopen("http://127.0.0.1:9471/healthz",timeout=8) as r:
        if json.load(r).get("ok") is not True:raise RuntimeError("ORIGINAL_CORE_NOT_HEALTHY")
    return True

def main():
    if os.getuid()!=1000:raise RuntimeError("CFUSER_REQUIRED")
    if socket.gethostbyname(HOST)!=IP:raise RuntimeError("WILDCARD_DNS_CHANGED")
    if BACK.exists():raise RuntimeError("EXISTING_BACKUP_STOP_REDEPLOY")
    routes,policies=check_state()
    if len(routes)!=1 or len(policies)!=1:
        raise RuntimeError("PROBE_CONFIG_ALREADY_PRESENT_OR_CHANGED")
    if any(HOST in str(x) for x in routes+policies):
        raise RuntimeError("ALT_HOST_ALREADY_CONFIGURED")
    original_policy=policies[0]
    policy=copy.deepcopy(original_policy)
    policy["subjects"]=[HOST]
    # The single deploy alters only one static-response route and one TLS policy.
    candidate,_=read("/")
    candidate["apps"]["http"]["servers"]["srv0"]["routes"].append(PROBE_ROUTE)
    candidate["apps"]["tls"]["automation"]["policies"].append(policy)
    candidate_path=BASE/"candidate-validated.json"
    candidate_path.write_text(json.dumps(candidate,separators=(",",":")),encoding="utf-8")
    candidate_path.chmod(0o600)
    subprocess.run(["/usr/bin/caddy","validate","--config",str(candidate_path)],
                   check=True,capture_output=True,timeout=30)
    watchers=False
    try:
        modify_watchers()
        watchers=True
        r,p=check_state()
        if r!=routes or p!=policies:raise RuntimeError("CADDY_CHANGED_BEFORE_APPLY")
        _,etag=read("/apps/tls/automation/policies")
        update("/apps/tls/automation/policies",p+[policy],etag)
        _,etag=read("/apps/http/servers/srv0/routes")
        update("/apps/http/servers/srv0/routes",r+[PROBE_ROUTE],etag)
        rr,pp=check_state()
        if rr!=r+[PROBE_ROUTE] or pp!=p+[policy]:
            raise RuntimeError("CADDY_READBACK_FAILED")
        verify_public()
        for unit in ("dexa-main.service","dexa-mobile-gateway.service","dexa-lite.service"):
            subprocess.run(["systemctl","--user","is-active","--quiet",unit],check=True,env=ENV,timeout=6)
        print(json.dumps({"alternateHost":HOST,"liveHttps":True,"probeVerified":True,
            "existingDexaUntouched":True,"caddyProcessNotRestarted":True,
            "routeKeepersRestarted":list(UNITS)}))
    except BaseException:
        try:remove_own_caddy_parts()
        except Exception as exc:print("ROLLBACK_CADDY_ERROR",str(exc)[:200],file=sys.stderr)
        if BACK.exists():
            try:restore_watchers()
            except Exception as exc:print("ROLLBACK_KEEPER_ERROR",str(exc)[:200],file=sys.stderr)
        raise
if __name__=="__main__":
    main()
