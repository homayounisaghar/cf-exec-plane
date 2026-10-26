#!/bin/sh
set -eu
RID="$1"
case "$RID" in dexa-stage4-20261026-[a-z0-9]*) ;; *) echo REQUEST_ID_REJECTED >&2; exit 64;; esac
TAR="/tmp/$RID.tgz"
[ -f "$TAR" ] || exit 65
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR"
 chmod 0644 "$0"
 runuser -u cfserver -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$0" "$RID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo UNAUTHORIZED_DEPLOY_USER >&2;exit 66; }
umask 077
STAGE="$(mktemp -d "$HOME/dexa-stage4-publish.XXXXXXXX")"
tar -xzf "$TAR" -C "$STAGE"
[ -f "$STAGE/deploy-stage4.sh" ] || exit 67
RELEASE_ID="$RID" sh "$STAGE/deploy-stage4.sh"
