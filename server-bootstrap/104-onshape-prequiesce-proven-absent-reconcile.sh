#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "CF_PREQUIESCE_ABSENT_RECONCILE_REQUIRES_ROOT" >&2; exit 2; }

current="$(readlink -f /opt/capability-fabric/current)"
[[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 20
python3 - "$current/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"] == 63, m
assert m["release_id"] == "onshape-vps-hardened-rollback-r1", m
print("CF_ABSENT_RECONCILE_CURRENT_RELEASE=seq63")
PY

[[ ! -e /var/lib/capability-fabric/state/release-in-progress ]] || exit 21

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
a=r["authority"]
assert r["controlRevision"] == 529, r["controlRevision"]
assert r["lease"]["state"] == "FREE", r["lease"]
assert a["productionEpoch"] == 1, a
assert a["mode"] == "ANDROID_PRODUCTION", a
assert a["materialAuthority"] == "android-v1", a
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False, a
assert a["reconciliationHold"]["active"] is False, a
print("CF_ABSENT_RECONCILE_AUTHORITY=android-epoch1")
print("CF_ABSENT_RECONCILE_LEASE=FREE")
PY

historic=/var/lib/capability-fabric/releases/onshape-three-session-v47-fabric-shadow-r14-native-ui-capability
[[ -s "$historic/manifest.json" && -s "$historic/browser-native.js" ]] || {
  echo "CF_ABSENT_RECONCILE_HISTORIC_RELEASE_MISSING" >&2
  exit 22
}

python3 - "$historic/manifest.json" "$historic/browser-native.js" <<'PY'
import hashlib,json,sys
manifest_path,source_path=sys.argv[1:3]
m=json.load(open(manifest_path))
assert m["sequence"] == 62, m
assert m["release_id"] == "onshape-three-session-v47-fabric-shadow-r14-native-ui-capability", m
source=open(source_path,"rb").read()
digest=hashlib.sha256(source).hexdigest()
expected=m["files"]["browser-native.js"]
assert digest == expected == "26c7026248e096877603fb51939a5450294e57b0b0fb6ff7b7974b35ee061659", (digest,expected)
text=source.decode("utf-8")
branch=text.index('action === "request.fetch"')
guard=text.index('if (url.origin !== CAD_ORIGIN) throw coded("UI_NATIVE_ORIGIN"', branch)
effect=text.index("const response = await page.request.fetch", guard)
assert branch < guard < effect
print("CF_ABSENT_RECONCILE_SEQ62_SOURCE=proven")
print("CF_ABSENT_RECONCILE_ORIGIN_GUARD_BEFORE_FETCH=proven")
PY

db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
[[ -s "$db" ]] || exit 23

PYTHONPATH="$current/fabric-src" python3 - "$db" <<'PY'
import sys
from urllib.parse import urljoin,urlparse

from capability_fabric.domain import AckState, Outcome, OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore

db=sys.argv[1]
attempt_id="attempt:a8c7265c-9494-4749-bffe-21c776259358"
operation_id="operation:121f9ac2-b236-49e0-80ca-59aa0d7aaffb"
invocation_id="invocation:d76a791a-19d7-43cd-ae9a-c2b03dac270b"

with SqliteExecutionStateStore(db) as state:
    matches=[
        case for case in state.recoverable()
        if case.attempt is not None and case.attempt.attempt_id == attempt_id
    ]
    assert len(matches) == 1, len(matches)
    case=matches[0]
    assert case.operation is not None and case.attempt is not None and case.observation is not None
    assert case.invocation.invocation_id == invocation_id
    assert case.operation.operation_id == operation_id
    assert case.operation.effect == "onshape.ui.native.mutation_risk"
    assert case.observation.ack_state is AckState.UNKNOWN
    assert "UI_NATIVE_ORIGIN" in str(case.observation.detail or "")
    ev=dict(case.observation.evidence)
    assert ev.get("nativeAction") == "request.fetch"
    assert ev.get("nativeCompleted") is False
    assert ev.get("effectSent") is None
    assert ev.get("buildId") == "onshape-three-session-v47-fabric-native-ui-capability"

    payload=dict(case.dispatch.execution_payload)
    assert payload.get("operation") == "onshape.ui.native"
    args=dict(payload.get("args") or {})
    assert args.get("action") == "request.fetch"
    params=dict(args.get("params") or {})
    raw=params.get("url")
    assert isinstance(raw,str) and raw
    resolved=urljoin("https://cad.onshape.com",raw)
    assert urlparse(resolved).scheme + "://" + urlparse(resolved).netloc != "https://cad.onshape.com"

    outcome=Outcome(
        case.operation.operation_id,
        OutcomeState.ABSENT,
        "Exact seq62 request.fetch origin guard rejected the request before page.request.fetch; no external request effect was dispatched",
    )
    state.record_outcome(case.operation,outcome)
    state.append(
        "operation.reconciled.proven_absent_pre_effect",
        case.operation.operation_id,
        {
            "attempt_id": attempt_id,
            "same_attempt": True,
            "reexecuted": False,
            "proof": "seq62 UI_NATIVE_ORIGIN guard precedes page.request.fetch",
            "historic_browser_native_sha256": "26c7026248e096877603fb51939a5450294e57b0b0fb6ff7b7974b35ee061659",
        },
    )
print("CF_ABSENT_RECONCILE_ATTEMPT="+attempt_id)
print("CF_ABSENT_RECONCILE_OPERATION="+operation_id)
print("CF_ABSENT_RECONCILE_OUTCOME=ABSENT")
print("CF_ABSENT_RECONCILE_REEXECUTED=false")
PY

echo CF_PREQUIESCE_ABSENT_RECONCILE=pass
