#!/bin/sh
set -eu
RID="$1"
[ "$RID" = dexa-stage5-20261027-v1 ] || { echo INVALID_REQUEST_ID >&2;exit 61; }
TAR="/tmp/$RID.tgz"
[ -f "$TAR" ] && [ ! -L "$TAR" ] || { echo BUNDLE_MISSING >&2;exit 62; }
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR" "$0"
 runuser -u cfserver -- env HOME=/home/cfserver \
  XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  sh "$0" "$RID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo OWNER_USER_REQUIRED >&2;exit 63; }
umask 077
DIR=$(mktemp -d "$HOME/dexa-stage5-publish.XXXXXXXX")
tar -xzf "$TAR" -C "$DIR"
[ -f "$DIR/deploy-stage5.sh" ] || exit 64
RELEASE_ID="$RID" sh "$DIR/deploy-stage5.sh"
