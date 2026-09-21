#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,sys
from datetime import datetime,timezone
from pathlib import Path

EXPECTED_RUNTIME="bridge-0.6.7-code24-coord-v2"
EXPECTED_PACKAGE="dev.capabilityfabric.onshapebridge"
EXPECTED_VERSION_NAME="0.6.7"
EXPECTED_VERSION_CODE=24
EXPECTED_SOURCE="173425a5e2e0daef953812837e67b925816bded8"
EXPECTED_RELEASE_ID="onshape-vps-hardened-production-r4"
EXPECTED_MANIFEST="f2631a7f94ec5f6e5af5e9d3b3211cf440354eef0b55ff6fee7ab65cec50bfb9"

def blob_sha(raw:bytes)->str:
    return hashlib.sha1(f"blob {len(raw)}\0".encode()+raw).hexdigest()

def ts(v:str)->datetime:
    v=str(v).strip()
    if " • " in v: v=v.split(" • ",1)[0].strip()
    if v.endswith("Z"): v=v[:-1]+"+00:00"
    d=datetime.fromisoformat(v)
    if d.tzinfo is None: d=d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)

def status_from_body(text:str)->dict:
    marker="CF_ONSHAPE_RUNTIME_STATUS_V1"
    p=text.find(marker)
    if p<0: raise SystemExit("status marker missing")
    tail=text[p+len(marker):]
    start=tail.find("{")
    if start<0: raise SystemExit("status json missing")
    val,_=json.JSONDecoder().raw_decode(tail[start:])
    if not isinstance(val,dict): raise SystemExit("status json invalid")
    return val

if len(sys.argv)!=3:
    raise SystemExit("usage: verifier.py <control.json> <snapshot.json>")
raw=Path(sys.argv[1]).read_bytes()
root=json.loads(raw.decode())
snap=json.load(open(sys.argv[2]))
assert snap["schema"]=="capability-fabric.android-runtime-attestation-snapshot.v1"
src=snap["source"]
assert src["repository"]=="homayounisaghar/capability-fabric"
assert src["issueNumber"]==33 and src["issueState"]=="open"
status=status_from_body(snap["body"])

assert root["schema"]=="capability-fabric.onshape-runtime-control.v1"
assert root["controlRevision"]==540
assert status["observedRuntimeControlSha"]==blob_sha(raw)
assert status["controlRevision"]==root["controlRevision"]
assert status["runtimeGeneration"]==EXPECTED_RUNTIME
assert status["installedPackage"]==EXPECTED_PACKAGE
assert status["installedVersionName"]==EXPECTED_VERSION_NAME
assert status["installedVersionCode"]==EXPECTED_VERSION_CODE
assert status["sourceCommit"]==EXPECTED_SOURCE and status["sourceCommitVerified"] is True
assert status["admittedRuntimeGeneration"]==EXPECTED_RUNTIME
assert status["admittedSourceCommit"]==EXPECTED_SOURCE
assert status["pollLoopAlive"] is True and status["controlLoopAlive"] is True
assert status["onshapeSessionReady"] is True and status["cadState"]=="READY"
assert status["leaseState"]=="FREE" and status["queueDepth"]==0
assert status.get("currentCommandSourceId") is None
assert status.get("attemptId") in (None,"null")
assert ts(status["lastControlReadAt"]) >= ts(root["updatedAt"])
assert ts(status["reportedAt"]) >= ts(root["updatedAt"])
assert ts(status["heartbeatPublishedAt"]) >= ts(root["updatedAt"])

a=root["authority"]; r=root["routing"]; android=a["planes"]["android-v1"]; vps=a["planes"]["vps-fabric"]; guard=a["productionGuard"]
assert a["productionEpoch"]==11
assert a["mode"]=="VPS_PRODUCTION" and a["materialAuthority"]=="vps-fabric"
assert android["ingress"]=="CLOSED" and android["materialEffectsAllowed"] is False and android["busGeneration"]==3
assert vps["ingress"]=="ADMITTED" and vps["materialEffectsAllowed"] is True
assert vps["releaseSequence"]==67 and vps["releaseId"]==EXPECTED_RELEASE_ID and vps["manifestSha256"]==EXPECTED_MANIFEST
assert a["reconciliationHold"]["active"] is False
assert r["state"]=="CLOSED" and r["materialCommandsAllowed"] is False
assert r["busGeneration"]==3 and r["activeMailboxIssue"]==50 and r["candidateMailboxIssue"]==50
assert root["lease"]["state"]=="FREE" and root["lease"]["busGeneration"]==3
assert guard["generation"]==3 and guard["killSwitch"]=="ENGAGED"
assert guard["allowedDocumentIds"]==[]
assert guard["mutationBudget"]=={"budgetId":"epoch7-post-test-closed","maxMutations":0}

assert status["state"]=="BLOCKED"
assert status["routingState"]=="CLOSED"
assert status["materialCommandsAllowed"] is False
assert status["busGeneration"]==3
assert status["activeMailboxIssue"]==50 and status["candidateMailboxIssue"]==50
assert status["deviceAdmittedBusGeneration"]==3 and status["deviceAdmittedMailboxIssue"]==50
assert status["controlState"]=="BLOCKED"

print("CF_FINAL_ANDROID_CLOSED_CONTROL_SHA="+status["observedRuntimeControlSha"])
print("CF_FINAL_ANDROID_CLOSED_REVISION=540")
print("CF_FINAL_ANDROID_CLOSED_EPOCH=11")
print("CF_FINAL_ANDROID_CLOSED_BUS=3")
print("CF_FINAL_ANDROID_CLOSED_MAILBOX=50")
print("CF_FINAL_ANDROID_CLOSED_LEASE=FREE")
print("CF_FINAL_ANDROID_CLOSED_QUEUE=0")
print("CF_FINAL_ANDROID_CLOSED_LIVENESS=pass")
print("CF_FINAL_ANDROID_CLOSED_VPS_AUTHORITY=pass")
print("CF_FINAL_ANDROID_CLOSED=pass")
