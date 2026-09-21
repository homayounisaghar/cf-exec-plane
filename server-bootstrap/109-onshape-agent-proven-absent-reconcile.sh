#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_AGENT_RECONCILE_REQUIRES_ROOT" >&2; exit 2; }

release="$(readlink -f /opt/capability-fabric/current)"
[[ "$release" == /var/lib/capability-fabric/releases/* ]] || exit 20
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"] == 63, m
assert m["release_id"] == "onshape-vps-hardened-rollback-r1", m
print("CF_AGENT_RECONCILE_RELEASE=seq63")
PY

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"] == 529
assert r["lease"]["state"] == "FREE"
assert a["productionEpoch"] == 1
assert a["mode"] == "ANDROID_PRODUCTION"
assert a["materialAuthority"] == "android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_AGENT_RECONCILE_AUTHORITY=android-epoch1")
print("CF_AGENT_RECONCILE_LEASE=FREE")
PY

historic=/var/lib/capability-fabric/releases/onshape-three-session-v47-fabric-shadow-r14-native-ui-capability
[[ -s "$historic/manifest.json" && -s "$historic/browser-native.js" ]] || exit 21
python3 - "$historic/manifest.json" "$historic/browser-native.js" <<'PY'
import hashlib,json,sys
mp,sp=sys.argv[1:3]
m=json.load(open(mp))
assert m["sequence"] == 62
assert m["release_id"] == "onshape-three-session-v47-fabric-shadow-r14-native-ui-capability"
raw=open(sp,"rb").read()
sha=hashlib.sha256(raw).hexdigest()
assert sha == m["files"]["browser-native.js"]
assert sha == "26c7026248e096877603fb51939a5450294e57b0b0fb6ff7b7974b35ee061659"
text=raw.decode()
branch=text.index('action === "request.fetch"')
guard=text.index('if (url.origin !== CAD_ORIGIN) throw coded("UI_NATIVE_ORIGIN"',branch)
effect=text.index("const response = await page.request.fetch",guard)
assert branch < guard < effect
print("CF_AGENT_RECONCILE_SEQ62_GUARD_BEFORE_FETCH=pass")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
agent_dir=/var/lib/capability-fabric/onshape/fabric-agent
attempt='attempt:a8c7265c-9494-4749-bffe-21c776259358'
operation='operation:121f9ac2-b236-49e0-80ca-59aa0d7aaffb'

python3 - "$db" "$agent_dir" "$attempt" "$operation" <<'PY'
import hashlib,json,os,pathlib,sqlite3,sys,tempfile,datetime
db,agent_dir,attempt,operation=sys.argv[1:]
root=pathlib.Path(agent_dir)
name=hashlib.sha256(attempt.encode()).hexdigest()+".json"
p=root/name
assert p.is_file(), p

c=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
c.row_factory=sqlite3.Row
try:
    row=c.execute("""
      SELECT o.state AS operation_state,o.outcome_payload,
             a.state AS attempt_state,a.observation_payload
      FROM operations o JOIN attempts a ON a.operation_id=o.operation_id
      WHERE o.operation_id=? AND a.attempt_id=?
    """,(operation,attempt)).fetchone()
    assert row is not None
    assert row["operation_state"] == "ABSENT", dict(row)
    outcome=json.loads(row["outcome_payload"])
    assert outcome["state"] == "ABSENT", outcome
    stored_obs=json.loads(row["observation_payload"])
    assert "UI_NATIVE_ORIGIN" in str(stored_obs.get("detail") or "")
finally:
    c.close()

raw=p.read_bytes()
original_sha=hashlib.sha256(raw).hexdigest()
v=json.loads(raw)
assert v.get("attemptId") == attempt
assert v.get("operationId") == operation
assert v.get("state") == "UNCERTAIN"
obs=v.get("observation") or {}
assert obs.get("state") == "UNCERTAIN"
assert "UI_NATIVE_ORIGIN" in str(obs.get("detail") or "")
ev=obs.get("evidence") or {}
assert ev.get("nativeAction") == "request.fetch"
assert ev.get("nativeCompleted") is False
assert ev.get("effectSent") is None

audit_dir=root/"reconciliation-audit"
audit_dir.mkdir(mode=0o700,exist_ok=True)
os.chmod(audit_dir,0o700)
audit_path=audit_dir/(name+".pre-reconcile.json")
audit={
  "schema":"capability-fabric.vps-agent-reconciliation-audit.v1",
  "attemptId":attempt,
  "operationId":operation,
  "originalRecordSha256":original_sha,
  "originalRecord":v,
  "proof":{
    "fabricOutcome":"ABSENT",
    "historicalReleaseSequence":62,
    "historicalBrowserNativeSha256":"26c7026248e096877603fb51939a5450294e57b0b0fb6ff7b7974b35ee061659",
    "basis":"UI_NATIVE_ORIGIN guard precedes page.request.fetch",
    "reexecuted":False
  }
}
encoded=json.dumps(audit,sort_keys=True,separators=(",",":")).encode()
if audit_path.exists():
    assert audit_path.read_bytes()==encoded
else:
    tmp=audit_path.with_name(audit_path.name+".tmp")
    tmp.write_bytes(encoded); os.chmod(tmp,0o600); os.replace(tmp,audit_path)

new=dict(v)
new["state"]="REJECTED"
new["updatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
new["reconciliation"]={
  "classification":"PROVEN_PRE_EFFECT_REJECTION",
  "fabricOutcome":"ABSENT",
  "originalRecordSha256":original_sha,
  "basis":"seq62 UI_NATIVE_ORIGIN guard before page.request.fetch",
  "reexecuted":False
}
new_obs=dict(obs)
new_obs["state"]="REJECTED"
new_obs["detail"]="reconciled proven pre-effect rejection: UI_NATIVE_ORIGIN"
new_ev=dict(ev)
new_ev["effectSent"]=False
new_ev["nativeCompleted"]=False
new_ev["nativeAction"]="request.fetch"
new_ev["reconciledFromState"]="UNCERTAIN"
new_ev["reconciliationBasis"]="seq62-origin-guard-before-page.request.fetch"
new_ev["reexecuted"]=False
new_obs["evidence"]=new_ev
new["observation"]=new_obs

payload=json.dumps(new,separators=(",",":")).encode()
tmp=p.with_name(p.name+".tmp")
tmp.write_bytes(payload); os.chmod(tmp,0o600); os.replace(tmp,p)
os.chmod(p,0o600)

check=json.loads(p.read_text())
assert check["state"]=="REJECTED"
assert check["observation"]["state"]=="REJECTED"
assert check["observation"]["evidence"]["effectSent"] is False
assert check["observation"]["evidence"]["reexecuted"] is False
print("CF_AGENT_RECONCILE_ATTEMPT="+attempt)
print("CF_AGENT_RECONCILE_ORIGINAL_STATE=UNCERTAIN")
print("CF_AGENT_RECONCILE_FINAL_STATE=REJECTED")
print("CF_AGENT_RECONCILE_FABRIC_OUTCOME=ABSENT")
print("CF_AGENT_RECONCILE_EFFECT_SENT=false")
print("CF_AGENT_RECONCILE_REEXECUTED=false")
print("CF_AGENT_RECONCILE_ORIGINAL_SHA256="+original_sha)
print("CF_AGENT_RECONCILE_AUDIT_CAPSULE=pass")
PY

echo CF_AGENT_RECONCILE=pass
