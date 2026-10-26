#!/bin/sh
set -eu
RID="$1"
[ "$RID" = "dexa-kata-cf187-20261026-v1" ] || { echo DEXA_KATA_REQUEST_ID_INVALID >&2;exit 64; }
TAR="/tmp/$RID.tgz"
[ -f "$TAR" ] || { echo DEXA_KATA_PACKAGE_MISSING >&2;exit 65; }
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR" "$0"
 runuser -u cfserver -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$0" "$RID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo DEXA_KATA_DEPLOY_USER_INVALID >&2;exit 66; }
umask 077
STAGE="$(mktemp -d "$HOME/dexa-kata-publish.XXXXXXXX")"
cleanup(){ rm -rf "$STAGE"; }
trap cleanup EXIT
tar -tzf "$TAR" | python3 -c 'import sys;a=sys.stdin.read().splitlines();assert a and all(not p.startswith("/") and ".." not in p.split("/") for p in a)'
tar -xzf "$TAR" -C "$STAGE"
[ -f "$STAGE/manifest.json" ] && [ -f "$STAGE/deploy-kata.sh" ] || exit 67
bash -n "$STAGE/deploy-kata.sh"
bash "$STAGE/deploy-kata.sh"
