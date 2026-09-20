#!/usr/bin/env bash
set -euo pipefail
container=capability-fabric-onshape-fabric
server=capability-fabric-onshape-server

echo CF_FABRIC_SIDECAR_DIAG_BEGIN
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
