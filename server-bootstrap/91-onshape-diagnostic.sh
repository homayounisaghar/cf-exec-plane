#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

profile_parent=/var/lib/capability-fabric/onshape
profile=/var/lib/capability-fabric/onshape/browser-profile
active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
state=/var/lib/capability-fabric/state
detail=/var/log/capability-fabric/pull-agent-detail.log

safe_base() { local p="$1"; if [[ -L "$p" ]]; then basename "$(readlink -f "$p")"; else printf none; fi; }
read_state() { local p="$1"; [[ -r "$p" ]] && cat "$p" || printf none; }

echo CF_ONSHAPE_DIAG_BEGIN
echo "ACTIVE_RELEASE=$(safe_base "$active")"
echo "PREVIOUS_RELEASE=$(safe_base "$previous")"
echo "LAST_GOOD_SEQUENCE=$(read_state "$state/last-good-sequence")"
echo "LAST_GOOD_RELEASE=$(read_state "$state/last-good-release")"
echo "LAST_FAILED_COMMIT=$(read_state "$state/last-failed-commit")"

if [[ -d "$profile_parent" ]]; then echo "PROFILE_PARENT=$(stat -c '%a %u:%g' "$profile_parent")"; else echo PROFILE_PARENT=missing; fi
if [[ -d "$profile" ]]; then echo "PROFILE=$(stat -c '%a %u:%g' "$profile")"; else echo PROFILE=missing; fi
if getent passwd 19191 >/dev/null 2>&1; then echo HOST_UID_19191=assigned; else echo HOST_UID_19191=free; fi
if [[ -d "$profile" && "$(stat -c '%a %u:%g' "$profile")" == "700 19191:19191" ]]; then echo NEW_PROFILE_EXPECTATION=pass; else echo NEW_PROFILE_EXPECTATION=fail; fi
if [[ -d "$profile" && "$(stat -c '%a %U:%G' "$profile")" == "700 root:root" ]]; then echo OLD_PROFILE_EXPECTATION=pass; else echo OLD_PROFILE_EXPECTATION=fail; fi

if [[ -d "$profile" ]]; then
  bad_dirs="$(find "$profile" -xdev -type d ! -perm 0700 -print | wc -l | tr -d '[:space:]')"
  bad_files="$(find "$profile" -xdev -type f -perm /077 -print | wc -l | tr -d '[:space:]')"
  echo "PROFILE_BAD_DIR_MODES=$bad_dirs"
  echo "PROFILE_BAD_FILE_MODES=$bad_files"
  first_bad_dir="$(find "$profile" -xdev -type d ! -perm 0700 -printf '%P\n' -quit)"
  first_bad_file="$(find "$profile" -xdev -type f -perm /077 -printf '%P\n' -quit)"
  [[ -n "$first_bad_dir" ]] && echo "PROFILE_FIRST_BAD_DIR=$first_bad_dir" || echo "PROFILE_FIRST_BAD_DIR=none"
  [[ -n "$first_bad_file" ]] && echo "PROFILE_FIRST_BAD_FILE=$first_bad_file" || echo "PROFILE_FIRST_BAD_FILE=none"
fi

if docker inspect capability-fabric-onshape-chromium >/dev/null 2>&1; then echo "CONTAINER_CHROMIUM=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}' capability-fabric-onshape-chromium)"; else echo CONTAINER_CHROMIUM=missing; fi
if docker inspect capability-fabric-onshape-server >/dev/null 2>&1; then echo "CONTAINER_SERVER=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}' capability-fabric-onshape-server)"; else echo CONTAINER_SERVER=missing; fi

for p in 5800 8787 9222; do
  if ss -lnt | awk -v x="127.0.0.1:$p" '$4 == x {f=1} END {exit f?0:1}'; then echo "LOOPBACK_$p=pass"; else echo "LOOPBACK_$p=fail"; fi
  if ss -lnt | awk -v x="$p" '$4 == "0.0.0.0:"x || $4 == "[::]:"x || $4 == "*:"x {f=1} END {exit f?0:1}'; then echo "WILDCARD_$p=present"; else echo "WILDCARD_$p=absent"; fi
done

root_body="$(curl -fsS --max-time 3 http://127.0.0.1:8787/ 2>/dev/null || true)"
[[ "$root_body" == "cf-onshape-single ok" ]] && echo MCP_ROOT=pass || echo MCP_ROOT=fail
curl -fsS --max-time 3 http://127.0.0.1:5800/ >/dev/null 2>&1 && echo DESKTOP_HTTP=pass || echo DESKTOP_HTTP=fail
curl -fsS --max-time 3 http://127.0.0.1:9222/json/version 2>/dev/null | grep -q '"Browser"' && echo CDP_HTTP=pass || echo CDP_HTTP=fail
invalid_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/mcp/desktop/invalid-token/ 2>/dev/null || true)"
echo "DESKTOP_INVALID_CODE=$invalid_code"
echo "BOOT_UNIT_ENABLED=$(systemctl is-enabled capability-fabric-onshape-server.service 2>/dev/null || true)"
echo "BOOT_UNIT_ACTIVE=$(systemctl is-active capability-fabric-onshape-server.service 2>/dev/null || true)"

echo CF_PULL_DETAIL_TAIL_BEGIN
if [[ -r "$detail" ]]; then
  tail -n 180 "$detail" | sed -E 's#https?://[^[:space:]]+#<url>#g; s#([0-9]{1,3}\.){3}[0-9]{1,3}#<ipv4>#g'
else
  echo detail-log-missing
fi
echo CF_PULL_DETAIL_TAIL_END
echo CF_ONSHAPE_DIAG_END
