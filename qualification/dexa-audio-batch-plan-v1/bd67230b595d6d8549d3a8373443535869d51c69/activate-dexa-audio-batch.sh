#!/bin/sh
set -eu
ID=dexa-audio-batch-plan-20261028-v1
[ "${1:-}" = "$ID" ] || { echo INVALID_REQUEST_ID;exit 60; }
TAR="/tmp/$ID.tgz"
[ -f "$TAR" ] && [ ! -L "$TAR" ] || { echo STAGED_BUNDLE_MISSING;exit 61; }
if [ "$(id -u)" = 0 ];then
 chmod 0644 "$TAR" "$0"
 runuser -u cfserver -- env HOME=/home/cfserver XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /bin/sh "$0" "$ID"
 exit $?
fi
[ "$(id -un)" = cfserver ] || { echo DEXA_OWNER_USER_REQUIRED;exit 62; }
umask 077
DIR=$(mktemp -d "$HOME/dexa-audio-batch-activation.XXXXXXXX")
tar -xzf "$TAR" -C "$DIR"
[ -f "$DIR/deploy-dexa-audio-batch.sh" ] || { echo BUNDLE_DEPLOYER_MISSING;exit 63; }
RELEASE_ID="$ID" /bin/sh "$DIR/deploy-dexa-audio-batch.sh"
