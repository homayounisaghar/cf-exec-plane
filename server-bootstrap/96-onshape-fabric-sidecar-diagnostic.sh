#!/usr/bin/env bash
set -euo pipefail
container=capability-fabric-onshape-fabric
server=capability-fabric-onshape-server

echo CF_FABRIC_SIDECAR_DIAG_BEGIN
echo CF_FABRIC_PRECUTOVER_EVIDENCE_BEGIN
current_release="$(readlink -f /opt/capability-fabric/current 2>/dev/null || true)"
echo "CF_FABRIC_PRECUTOVER_CURRENT_RELEASE=${current_release:-missing}"
if [[ -n "$current_release" && -s "$current_release/manifest.json" ]]; then
  echo "CF_FABRIC_PRECUTOVER_MANIFEST_SHA256=$(sha256sum "$current_release/manifest.json" | awk '{print $1}')"
else
  echo CF_FABRIC_PRECUTOVER_MANIFEST_SHA256=missing
fi
if [[ -e /var/lib/capability-fabric/state/release-in-progress ]]; then
  echo CF_FABRIC_PRECUTOVER_RELEASE_GATE=active
else
  echo CF_FABRIC_PRECUTOVER_RELEASE_GATE=clear
fi
docker exec "$container" python - <<'PY'
import sqlite3
db="file:/fabric-state/execution.sqlite3?mode=ro"
con=sqlite3.connect(db, uri=True)
recoverable=con.execute("""
SELECT COUNT(*)
FROM invocations i
LEFT JOIN operations o ON o.invocation_id=i.invocation_id
LEFT JOIN attempts a ON a.operation_id=o.operation_id
WHERE i.phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')
  AND i.dispatch_payload IS NOT NULL
""").fetchone()[0]
in_doubt_ops=con.execute("SELECT COUNT(*) FROM operations WHERE state='IN_DOUBT'").fetchone()[0]
in_doubt_attempts=con.execute("SELECT COUNT(*) FROM attempts WHERE state='IN_DOUBT'").fetchone()[0]
print(f"CF_FABRIC_PRECUTOVER_RECOVERABLE={recoverable}")
print(f"CF_FABRIC_PRECUTOVER_IN_DOUBT_OPERATIONS={in_doubt_ops}")
print(f"CF_FABRIC_PRECUTOVER_IN_DOUBT_ATTEMPTS={in_doubt_attempts}")
con.close()
PY
docker exec "$server" node --input-type=module - <<'NODE'
import fs from "node:fs";
const dir="/agent-state";
let executing=0, uncertain=0, records=0;
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!name.endsWith(".json")) continue;
  records++;
  const v=JSON.parse(fs.readFileSync(dir+"/"+name,"utf8"));
  if (v?.state==="EXECUTING") executing++;
  if (v?.observation?.state==="UNCERTAIN") uncertain++;
}
console.log("CF_FABRIC_PRECUTOVER_AGENT_RECORDS="+records);
console.log("CF_FABRIC_PRECUTOVER_AGENT_EXECUTING="+executing);
console.log("CF_FABRIC_PRECUTOVER_AGENT_UNCERTAIN="+uncertain);
NODE
echo CF_FABRIC_PRECUTOVER_EVIDENCE_END
for name in "$server" "$container"; do
  if docker inspect "$name" >/dev/null 2>&1; then
    docker inspect -f 'CONTAINER={{.Name}} STATUS={{.State.Status}} RUNNING={{.State.Running}} RESTARTING={{.State.Restarting}} EXIT={{.State.ExitCode}} OOM={{.State.OOMKilled}} RESTARTS={{.RestartCount}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name"
  else
    echo "CONTAINER=$name MISSING"
  fi
done
for p in 8788 8789 8791; do
  if ss -lnt | awk -v x="127.0.0.1:$p" '$4 == x {f=1} END {exit f?0:1}'; then
    echo "PORT_$p=present"
  else
    echo "PORT_$p=absent"
  fi
done
set +e
python3 - <<'PY'
import json, urllib.request
for url in ("http://127.0.0.1:8791/","http://127.0.0.1:8791/v1/capabilities"):
    try:
        with urllib.request.urlopen(url,timeout=3) as r:
            body=r.read().decode("utf-8","replace")
            print("HTTP",url,r.status,body[:1200])
    except Exception as e:
        print("HTTP",url,"ERROR",type(e).__name__,str(e)[:300])
PY
rc=$?
set -e
echo CF_FABRIC_SIDECAR_LOG_BEGIN
docker logs --tail 160 "$container" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
echo CF_FABRIC_SIDECAR_LOG_END
echo CF_FABRIC_SERVER_LOG_BEGIN
docker logs --tail 100 "$server" 2>&1 | sed -E 's#https?://[^[:space:]"]+#<url>#g' || true
echo CF_FABRIC_SERVER_LOG_END
echo CF_FABRIC_SIDECAR_DIAG_END
exit "$rc"
