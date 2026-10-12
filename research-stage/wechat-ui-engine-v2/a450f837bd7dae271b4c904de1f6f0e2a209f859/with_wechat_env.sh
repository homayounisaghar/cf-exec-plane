#!/usr/bin/env bash
# Run a command inside the official WeChat client's own display/AT-SPI context.
# Must be run as the same Unix user as WeChat (cfop). Owner-approved helper.
# Copies only display/bus/accessibility variables; prints nothing private.
set -euo pipefail
P=$(pgrep -u "$USER" -x wechat | head -1 || true)
[ -z "$P" ] && P=$(pgrep -u "$USER" -f /opt/wechat/wechat | head -1 || true)
[ -z "$P" ] && { echo "WECHAT_PROCESS_NOT_FOUND_FOR_USER"; exit 3; }
mapfile -t V < <(tr '\0' '\n' < "/proc/$P/environ" | grep -E '^(DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|QT_ACCESSIBILITY|QT_LINUX_ACCESSIBILITY_ALWAYS_ON|AT_SPI_BUS_ADDRESS|NO_AT_BRIDGE|QT_SCALE_FACTOR)=')
XAUTHORITY_PATH=/var/lib/capability-fabric/pcg/wechat/Xauthority
[ -r "$XAUTHORITY_PATH" ] || { echo "WECHAT_XAUTHORITY_UNAVAILABLE"; exit 4; }
export XAUTHORITY="$XAUTHORITY_PATH"
exec env "${V[@]}" "$@"
