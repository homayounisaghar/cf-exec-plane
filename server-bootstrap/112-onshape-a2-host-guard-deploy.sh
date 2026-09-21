#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo CF_A2_HOST_GUARD_REQUIRES_ROOT >&2; exit 2; }

agent_src=server-bootstrap/pull-agent/cf-pull-agent.sh
guard_src=server-bootstrap/pull-agent/runtime_control_guard.py
agent=/usr/local/libexec/capability-fabric-pull-agent
guard=/usr/local/libexec/capability-fabric-runtime-control-guard
control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
gate=/var/lib/capability-fabric/state/release-in-progress
lock=/run/lock/capability-fabric-pull.lock

[[ -s "$agent_src" && -s "$guard_src" && -s "$control" && -L "$active" ]] || exit 20
[[ ! -e "$gate" ]] || { echo CF_A2_HOST_GUARD_RELEASE_GATE=active >&2; exit 20; }
bash -n "$agent_src"
python3 "$guard_src" "$control" "$control" >/tmp/cf-a2-guard-selftest.$$
trap 'rm -f /tmp/cf-a2-guard-selftest.$$' EXIT
grep -Fq 'CF_AUTH_GUARD_IDENTICAL=pass' /tmp/cf-a2-guard-selftest.$$

active_before="$(readlink -f "$active")"
previous_before="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_before="$(sha256sum "$control" | awk '{print $1}')"
timer_enabled_before="$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)"
timer_active_before="$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)"
service_active_before="$(systemctl is-active capability-fabric-pull.service 2>/dev/null || true)"

python3 - "$active_before/manifest.json" "$control" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
assert m["sequence"]==63,m
assert m["release_id"]=="onshape-vps-hardened-rollback-r1",m
r=json.load(open(sys.argv[2])); a=r["authority"]
assert r["controlRevision"]==529
assert r["lease"]["state"]=="FREE"
assert a["productionEpoch"]==1
assert a["mode"]=="ANDROID_PRODUCTION"
assert a["materialAuthority"]=="android-v1"
assert a["planes"]["android-v1"]["materialEffectsAllowed"] is True
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_A2_HOST_GUARD_BASELINE=android-epoch1-seq63")
PY

containers=(capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway)
before="$(mktemp)"; after="$(mktemp)"
trap 'rm -f /tmp/cf-a2-guard-selftest.$$ "$before" "$after"' EXIT
for c in "${containers[@]}"; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Image}}' "$c" >>"$before"
done

exec 9>"$lock"
flock 9

install -d -m 0755 /usr/local/libexec
ta="$(mktemp /usr/local/libexec/.cf-pull-agent.XXXXXX)"
tg="$(mktemp /usr/local/libexec/.cf-runtime-control-guard.XXXXXX)"
trap 'rm -f /tmp/cf-a2-guard-selftest.$$ "$before" "$after" "$ta" "$tg"' EXIT
install -m 0750 -o root -g root "$agent_src" "$ta"
install -m 0750 -o root -g root "$guard_src" "$tg"
bash -n "$ta"
python3 "$tg" "$control" "$control" | grep -Fq 'CF_AUTH_GUARD_IDENTICAL=pass'
mv -f "$tg" "$guard"
mv -f "$ta" "$agent"
chown root:root "$guard" "$agent"
chmod 0750 "$guard" "$agent"

echo "CF_A2_HOST_AGENT_SHA256=$(sha256sum "$agent" | awk '{print $1}')"
echo "CF_A2_HOST_GUARD_SHA256=$(sha256sum "$guard" | awk '{print $1}')"
echo CF_A2_HOST_INSTALL=pass

# Exercise the real installed pull agent once. Main still advertises seq63, so
# this may mirror identical control/no-change metadata only; release activation is forbidden.
set +e
pull_output="$("$agent" pull 2>&1)"
pull_rc=$?
set -e
printf '%s\n' "$pull_output" | grep -E 'CF_RUNTIME_CONTROL_MIRROR=updated|CF_PULL_NO_CHANGE|CF_PULL_SKIPPED_PREVIOUSLY_FAILED_HEAD' || true
[[ "$pull_rc" -eq 0 ]] || { printf '%s\n' "$pull_output" >&2; exit 21; }

active_after="$(readlink -f "$active")"
previous_after="$(readlink -f "$previous" 2>/dev/null || true)"
control_sha_after="$(sha256sum "$control" | awk '{print $1}')"
timer_enabled_after="$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)"
timer_active_after="$(systemctl is-active capability-fabric-pull.timer 2>/dev/null || true)"
service_active_after="$(systemctl is-active capability-fabric-pull.service 2>/dev/null || true)"

[[ "$active_after" == "$active_before" ]] || { echo CF_A2_HOST_ACTIVE_POINTER=changed >&2; exit 22; }
[[ "$previous_after" == "$previous_before" ]] || { echo CF_A2_HOST_PREVIOUS_POINTER=changed >&2; exit 22; }
[[ "$control_sha_after" == "$control_sha_before" ]] || { echo CF_A2_HOST_CONTROL=changed >&2; exit 22; }
[[ "$timer_enabled_after" == "$timer_enabled_before" ]] || { echo CF_A2_HOST_TIMER_ENABLED=changed >&2; exit 22; }
[[ "$timer_active_after" == "$timer_active_before" ]] || { echo CF_A2_HOST_TIMER_ACTIVE=changed >&2; exit 22; }
[[ "$service_active_after" == "$service_active_before" ]] || { echo CF_A2_HOST_SERVICE_ACTIVE=changed >&2; exit 22; }
[[ ! -e "$gate" ]] || { echo CF_A2_HOST_RELEASE_GATE=changed >&2; exit 22; }

for c in "${containers[@]}"; do
  docker inspect -f '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.Image}}' "$c" >>"$after"
done
cmp -s "$before" "$after" || { echo CF_A2_HOST_CONTAINERS=changed >&2; exit 22; }

python3 "$guard" "$control" "$control" | grep -Fq 'CF_AUTH_GUARD_IDENTICAL=pass'
echo CF_A2_HOST_LIVE_GUARD=pass
echo CF_A2_HOST_ACTIVE_POINTER=unchanged
echo CF_A2_HOST_PREVIOUS_POINTER=unchanged
echo CF_A2_HOST_CONTROL=unchanged
echo "CF_A2_HOST_TIMER_ENABLED=$timer_enabled_after"
echo "CF_A2_HOST_TIMER_ACTIVE=$timer_active_after"
echo CF_A2_HOST_CONTAINERS=unchanged
echo CF_A2_HOST_AUTHORITY=android-epoch1
echo CF_A2_HOST_GUARD_DEPLOY=pass
