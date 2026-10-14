#!/usr/bin/env bash
# Read-only status report (no secrets).
set -uo pipefail
echo "active_release=$(readlink -f /opt/capability-fabric/current)"
echo "served_build=$(curl -fsS -D - -o /dev/null --max-time 3 http://127.0.0.1:8788/ 2>/dev/null | awk 'tolower($1)=="x-cf-build-id:"{print $2}' | tr -d '\r')"
docker ps --format '{{.Names}} {{.Status}}' 2>&1 | grep -i capability || true
for s in capability-fabric-cf-ops capability-fabric-pcg-wechat capability-fabric-pcg-wechat-semantic capability-fabric-onshape-server; do
  echo "unit $s $(systemctl is-active $s 2>&1) pid=$(systemctl show $s -p MainPID --value 2>&1)"; done
ls -l /var/lib/capability-fabric/cf-ops-run/ 2>&1
docker exec capability-fabric-onshape-server sh -c 'ls -l /run/cf-ops/ 2>&1; node -e "const n=require(\"net\");const s=n.createConnection(\"/run/cf-ops/agent.sock\");s.on(\"connect\",()=>s.write(JSON.stringify({op:\"server_status\",args:{}})+\"\\n\"));let b=\"\";s.on(\"data\",d=>b+=d);s.on(\"close\",()=>console.log(\"container_probe\",b.slice(0,160)));s.on(\"error\",e=>console.log(\"container_probe_error\",e.code));"' 2>&1 | tail -5
journalctl -u capability-fabric-cf-ops -n 15 --no-pager 2>&1 | tail -15
df -h / | tail -1
free -m 2>&1 | head -3
