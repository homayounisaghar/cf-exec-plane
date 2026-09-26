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
EXPECTED_CONTROL=8401980fa765a9810a5d4fa6f636502e379e643d
EXPECTED_MANIFEST=08873ac1a6830ed42f15ebe340604ed6ffea33b8e7cb12b3a192982f3dcd6e9c

[[ "$(basename "$(readlink -f "$ACTIVE")")" == "onshape-vps-hardened-production-r7" ]] || exit 20
[[ "$(basename "$(readlink -f "$PREVIOUS")")" == "onshape-vps-hardened-production-r6" ]] || exit 20
[[ "$(cat "$STATE/last-good-sequence")" == "72" ]] || exit 20
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r7" ]] || exit 20
[[ ! -s "$STATE/last-failed-commit" ]] || exit 20
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
[[ "$(basename "$active")" == "onshape-vps-hardened-production-r8" ]] || exit 30
[[ "$(basename "$previous")" == "onshape-vps-hardened-production-r7" ]] || exit 30
[[ "$(cat "$STATE/last-good-sequence")" == "73" ]] || exit 30
[[ "$(cat "$STATE/last-good-release")" == "onshape-vps-hardened-production-r8" ]] || exit 30
[[ ! -s "$STATE/last-failed-commit" ]] || exit 30
[[ "$(sha256sum "$active/manifest.json" | awk '{print $1}')" == "$EXPECTED_MANIFEST" ]] || exit 30
[[ "$(git hash-object "$CONTROL")" == "$EXPECTED_CONTROL" ]] || exit 30

backend_headers="$(curl -fsS -D - -o /dev/null --max-time 3 http://127.0.0.1:8788/ | tr -d '\r')"
printf '%s\n' "$backend_headers" | grep -Fqi 'X-CF-Build-Id: onshape-vps-hardened-r8'
echo CF_R8_DEPLOY_RUNTIME_BUILD_ID=onshape-vps-hardened-r8

# Health can reopen services; restore the bounded fail-closed section.
systemctl stop "$TIMER" >/dev/null 2>&1 || true
docker stop "$GATEWAY" >/dev/null 2>&1 || true
tmp="$GATE.tmp.r8.$$"; printf '%s\n' RELEASE_IN_PROGRESS >"$tmp"; chmod 0600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$GATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" == true ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY")" == false ]]
if systemctl is-active --quiet "$TIMER"; then exit 31; fi

echo CF_R8_DEPLOY_ACTIVE=seq73-r8
echo CF_R8_DEPLOY_PREVIOUS=seq72-r7
echo CF_R8_DEPLOY_MANIFEST_SHA256=$EXPECTED_MANIFEST
echo CF_R8_DEPLOY_CONTROL=epoch21-seq72-r7-guard-closed
echo CF_R8_DEPLOY_GATE=active
echo CF_R8_DEPLOY_GATEWAY=stopped
echo CF_R8_DEPLOY=pass
