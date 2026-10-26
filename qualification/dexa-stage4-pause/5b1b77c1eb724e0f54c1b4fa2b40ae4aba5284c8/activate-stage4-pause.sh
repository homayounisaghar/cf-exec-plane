#!/bin/sh
set -eu
RID="$1"
[ "$RID" = dexa-stage4-pause-20261026-v2 ] ||
 { echo REQUEST_ID_REJECTED >&2;exit 64; }
TAR="/tmp/$RID.tgz"
[ -f "$TAR" ] && [ ! -L "$TAR" ] || exit 65
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR" "$0"
 runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh "$0" "$RID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo NOT_OWNER_SERVICE_USER >&2;exit 66; }
umask 077
STAGE="$(mktemp -d "$HOME/dexa-stage4-pause-publish.XXXXXXXX")"
tar -xzf "$TAR" -C "$STAGE"
[ -f "$STAGE/deploy-stage4-pause.sh" ] || exit 67
RELEASE_ID="$RID" sh "$STAGE/deploy-stage4-pause.sh"
