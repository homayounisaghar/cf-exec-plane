#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
gate="/var/lib/capability-fabric/state/release-in-progress"
lock="/run/lock/capability-fabric-pull.lock"
timer="capability-fabric-pull.timer"
prod_server="capability-fabric-onshape-server"
prod_fabric="capability-fabric-onshape-fabric"
prod_gateway="capability-fabric-onshape-gateway"
root="/var/lib/capability-fabric/onshape-session-pool-phase5-lab"
marker="$root/agent-state/phase5-live-unresolved.json"
[[ -e "$gate" && -s "$marker" ]] || { echo CF_PHASE5_ORPHAN_PREFLIGHT=not-applicable >&2; exit 20; }
exec 9>"$lock"
flock -n 9 || { echo CF_PHASE5_ORPHAN_LOCK=owned >&2; exit 21; }
if ps -eo args | grep -E '300-onshape-session-pool-phase5-live|onshape-session-pool-phase5' | grep -v grep >/dev/null; then
  echo CF_PHASE5_ORPHAN_PROCESS=present >&2; exit 22
fi
echo CF_PHASE5_ORPHAN_PROOF=no-owner-lock-free
rm -f "$gate"
docker start "$prod_server" >/dev/null
for _ in $(seq 1 180); do curl -fsS http://127.0.0.1:8788/ 2>/dev/null | grep -Fq 'cf-onshape-single ok' && break; sleep 1; done
curl -fsS http://127.0.0.1:8788/ | grep -Fq 'cf-onshape-single ok'
docker start "$prod_fabric" >/dev/null
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:8791/ 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:8791/ | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True'
bash server-bootstrap/281-onshape-production-cohort-recover.sh
docker start "$prod_gateway" >/dev/null 2>&1 || true
systemctl start "$timer" >/dev/null 2>&1 || true
echo CF_PHASE5_ORPHAN_PRODUCTION_RESTORED=pass
flock -u 9
bash server-bootstrap/305-onshape-phase5-current-pre-effect-recover.sh
