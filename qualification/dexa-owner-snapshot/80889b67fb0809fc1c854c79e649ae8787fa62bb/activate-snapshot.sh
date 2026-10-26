#!/bin/sh
set -eu
RID="$1"
[ "$RID" = "dexa-kata-owner-snapshot-20261026-v1" ] || { echo SNAPSHOT_RELEASE_ID_INVALID >&2;exit 64; }
TAR="/tmp/$RID.tgz"
[ -f "$TAR" ] || { echo SNAPSHOT_RELEASE_ARCHIVE_MISSING >&2;exit 65; }
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR" "$0"
 runuser -u cfserver -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$0" "$RID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo SNAPSHOT_DEPLOY_USER_INVALID >&2;exit 66; }
umask 077
STAGE="$(mktemp -d "$HOME/dexa-owner-snapshot-publish.XXXXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
tar -tzf "$TAR" | python3 -c 'import sys;a=sys.stdin.read().splitlines();assert a and all(not p.startswith("/") and ".." not in p.split("/") for p in a)'
tar -xzf "$TAR" -C "$STAGE"
[ -f "$STAGE/manifest.json" ] && [ -f "$STAGE/deploy-snapshot.sh" ] || exit 67
bash -n "$STAGE/deploy-snapshot.sh"
bash "$STAGE/deploy-snapshot.sh"
