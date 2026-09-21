#!/usr/bin/env python3
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
from datetime import datetime, timezone

EXPECTED_RUNTIME="bridge-0.6.7-code24-coord-v2"
EXPECTED_PACKAGE="dev.capabilityfabric.onshapebridge"
EXPECTED_VERSION_NAME="0.6.7"
EXPECTED_VERSION_CODE=24
EXPECTED_SOURCE="173425a5e2e0daef953812837e67b925816bded8"


def blob_sha(raw: bytes) -> str:
    return hashlib.sha1(f"blob {len(raw)}\0".encode()+raw).hexdigest()


def status_from_body(text: str) -> dict:
    marker="CF_ONSHAPE_RUNTIME_STATUS_V1"
    p=text.find(marker)
    if p < 0:
        raise SystemExit("status marker missing")
    tail=text[p+len(marker):]
    start=tail.find("{")
    if start < 0:
        raise SystemExit("status json missing")
    value,end=json.JSONDecoder().raw_decode(tail[start:])
    if not isinstance(value,dict):
        raise SystemExit("status json must be object")
    return value


def load(control_path: str, status_path: str):
    raw=Path(control_path).read_bytes()
    root=json.loads(raw.decode())
    status=status_from_body(Path(status_path).read_text())
    return raw,root,status


def _ts(value: str) -> datetime:
    value=str(value).strip()
    if " • " in value:
        value=value.split(" • ",1)[0].strip()
    if value.endswith("Z"):
        value=value[:-1]+"+00:00"
    dt=datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt=dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def common(raw,root,status):
    assert root["schema"]=="capability-fabric.onshape-runtime-control.v1"
    assert status["observedRuntimeControlSha"]==blob_sha(raw)
    assert status["controlRevision"]==root["controlRevision"]
    assert status["runtimeGeneration"]==EXPECTED_RUNTIME
    assert status["installedPackage"]==EXPECTED_PACKAGE
    assert status["installedVersionName"]==EXPECTED_VERSION_NAME
    assert status["installedVersionCode"]==EXPECTED_VERSION_CODE
    assert status["sourceCommit"]==EXPECTED_SOURCE
    assert status["sourceCommitVerified"] is True
    assert status["admittedRuntimeGeneration"]==EXPECTED_RUNTIME
    assert status["admittedSourceCommit"]==EXPECTED_SOURCE
    assert status["pollLoopAlive"] is True
    assert status["controlLoopAlive"] is True
    assert status["leaseState"]=="FREE"
    assert status["queueDepth"]==0
    assert status.get("currentCommandSourceId") is None
    control_updated=_ts(root["updatedAt"])
    assert _ts(status["lastControlReadAt"]) >= control_updated
    assert _ts(status["reportedAt"]) >= control_updated
    assert _ts(status["heartbeatPublishedAt"]) >= control_updated


def current(raw,root,status):
    common(raw,root,status)
    a=root["authority"]; r=root["routing"]
    assert a["mode"]=="ANDROID_PRODUCTION"
    assert a["materialAuthority"]=="android-v1"
    assert a["planes"]["android-v1"]["ingress"]=="ADMITTED"
    assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True
    assert r["state"]=="ADMITTED" and r["materialCommandsAllowed"] is True
    assert status["routingState"]=="ADMITTED"
    assert status["materialCommandsAllowed"] is True
    assert status["busGeneration"]==r["busGeneration"]
    assert status["deviceAdmittedBusGeneration"]==r["busGeneration"]
    assert status["deviceAdmittedMailboxIssue"]==r["activeMailboxIssue"]
    print("CF_ANDROID_ATTESTATION_CHANNEL=current-admitted-pass")


def closed(raw,root,status):
    a=root["authority"]; r=root["routing"]
    is_closed=(
      a["mode"]=="QUIESCED_RECONCILING"
      and a["materialAuthority"] is None
      and a["planes"]["android-v1"]["ingress"]=="CLOSED"
      and a["planes"]["android-v1"]["materialEffectsAllowed"] is False
      and a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
      and r["state"]!="ADMITTED"
      and r["materialCommandsAllowed"] is False
    )
    if not is_closed:
        print("CF_ANDROID_CLOSE_ATTESTATION=not-closed")
        raise SystemExit(30)
    common(raw,root,status)
    assert status["routingState"]==r["state"]
    assert status["materialCommandsAllowed"] is False
    assert status["busGeneration"]==r["busGeneration"]
    assert status["deviceAdmittedBusGeneration"]==r["busGeneration"]
    assert status["deviceAdmittedMailboxIssue"]==r["activeMailboxIssue"]
    assert status["state"]=="BLOCKED"
    print("CF_ANDROID_CLOSE_ATTESTATION_CONTROL_SHA="+status["observedRuntimeControlSha"])
    print("CF_ANDROID_CLOSE_ATTESTATION_REVISION="+str(status["controlRevision"]))
    print("CF_ANDROID_CLOSE_ATTESTATION_BUS="+str(status["deviceAdmittedBusGeneration"]))
    print("CF_ANDROID_CLOSE_ATTESTATION_LEASE=FREE")
    print("CF_ANDROID_CLOSE_ATTESTATION_QUEUE=0")
    print("CF_ANDROID_CLOSE_ATTESTATION_LIVENESS=pass")
    print("CF_ANDROID_CLOSE_ATTESTATION=pass")


if len(sys.argv)!=4 or sys.argv[1] not in {"current","closed"}:
    raise SystemExit("usage: verifier.py current|closed <control.json> <issue-body.txt>")
raw,root,status=load(sys.argv[2],sys.argv[3])
(current if sys.argv[1]=="current" else closed)(raw,root,status)
