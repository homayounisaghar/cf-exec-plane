#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

service=capability-fabric-onshape-server.service
account=/etc/capability-fabric/secrets/onshape/account
password=/etc/capability-fabric/secrets/onshape/password
profile=/var/lib/capability-fabric/onshape/browser-profile

[[ "$(systemctl is-enabled "$service")" == "enabled" ]]
systemctl is-active --quiet "$service"
[[ -s "$account" && -s "$password" ]]
[[ "$(stat -c '%a %U:%G' "$account")" == "600 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$password")" == "600 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$profile")" == "700 root:root" ]]

before="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' capability-fabric-onshape-server)"
systemctl restart "$service"

healthy=no
for _ in $(seq 1 150); do
  body="$(curl -fsS --max-time 2 http://127.0.0.1:8787/ 2>/dev/null || true)"
  if [[ "$body" == "cf-onshape-single ok" ]]; then healthy=yes; break; fi
  sleep 1
done
[[ "$healthy" == yes ]]
systemctl is-active --quiet "$service"
after="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' capability-fabric-onshape-server)"
[[ "$before" != "$after" ]] || { echo "container start timestamp did not change" >&2; exit 22; }

[[ -s "$account" && -s "$password" ]]
[[ "$(stat -c '%a %U:%G' "$account")" == "600 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$password")" == "600 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$profile")" == "700 root:root" ]]

printf 'CF_ONSHAPE_RESTART=pass\n'
printf 'CF_ONSHAPE_RESTART_LOCAL_HEALTH=pass\n'
printf 'CF_ONSHAPE_RESTART_CREDENTIALS=preserved\n'
printf 'CF_ONSHAPE_RESTART_PROFILE=preserved\n'
