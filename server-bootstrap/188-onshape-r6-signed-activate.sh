#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

ACTIVE=/opt/capability-fabric/current
PREVIOUS=/opt/capability-fabric/previous
STATE=/var/lib/capability-fabric/state
CONTROL=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
GATE="$STATE/release-in-progress"
TIMER=capability-fabric-pull.timer
SERVICE=capability-fabric-pull.service
PULL=/usr/local/libexec/capability-fabric-pull-agent
GATEWAY=capability-fabric-onshape-gateway
SERVER=capability-fabric-onshape-server
EXPECTED_CONTROL=be24a7a3beb329aad2f04ad8fa96247afc282a55
EXPECTED_MANIFEST=e64a1053c02a5abf6becd09275b91768f8642a724c7f0db6d4106a8cbe19583f

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r5" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "70" ]] || exit 20
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 20
[[ -f "$GATE" ]] && grep -Fxq RELEASE_IN_PROGRESS "$GATE"
if systemctl is-active --quiet "$TIMER"; then exit 20; fi
if systemctl is-active --quiet "$SERVICE"; then exit 20; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]] || exit 20

out="$("$PULL" pull)"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Fxq 'CF_PULL_APPLY=success'

active="$(readlink -f "$ACTIVE")"
previous="$(readlink -f "$PREVIOUS")"
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r6" ]] || exit 30
[[ "$(basename "$previous")" == "onshape-vps-hardened-production-r5" ]] || exit 30
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 30
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r6" ]] || exit 30
[[ ! -s "$STATE/last-failed-commit" ]] || exit 30
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 30
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 30

# Preserve the E9 critical section after health has passed.
systemctl stop "$TIMER" >/dev/null 2>&1 || true
docker stop "$GATEWAY" >/dev/null
tmp="$GATE.tmp.r6.$$"
printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"
chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"

[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 31; fi

echo CF_R6_DEPLOY_ACTIVE=seq71-r6
echo CF_R6_DEPLOY_PREVIOUS=seq70-r5
echo CF_R6_DEPLOY_MANIFEST_SHA256=$EXPECTED_MANIFEST
echo CF_R6_DEPLOY_CONTROL=epoch15-guard-closed
echo CF_R6_DEPLOY_GATE=active
echo CF_R6_DEPLOY_GATEWAY=stopped
echo CF_R6_DEPLOY=pass
