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
EXPECTED_CONTROL=b526a61c5af2c054cbde6411f49c51f96982acc7
EXPECTED_MANIFEST=7fdfb79f43dba8a061767824984cb76c0a3cc1f8349a7628f806893ba04c8f2e

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "71" ]] || exit 20
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
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r7" ]] || exit 30
[[ "$(basename "$previous")" == "onshape-vps-hardened-production-r6" ]] || exit 30
[[ "$(cat "$STATE/last-good-sequence")" == "72" ]] || exit 30
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r7" ]] || exit 30
[[ ! -s "$STATE/last-failed-commit" ]] || exit 30
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 30
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 30

# Health may clear/reopen normal services. Re-establish the bounded critical section.
systemctl stop "$TIMER" >/dev/null 2>&1 || true
docker stop "$GATEWAY" >/dev/null 2>&1 || true
tmp="$GATE.tmp.r7.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 31; fi

echo CF_R7_DEPLOY_ACTIVE=seq72-r7
echo CF_R7_DEPLOY_PREVIOUS=seq71-r6
echo CF_R7_DEPLOY_MANIFEST_SHA256=$EXPECTED_MANIFEST
echo CF_R7_DEPLOY_CONTROL=epoch19-seq71-r6-guard-closed
echo CF_R7_DEPLOY_GATE=active
echo CF_R7_DEPLOY_GATEWAY=stopped
echo CF_R7_DEPLOY=pass
