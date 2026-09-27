#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2

echo CF_HUMAN_SURFACE_DIAG_BEGIN

for unit in xrdp.service xrdp-sesman.service; do
  key="$(printf "%s" "$unit" | tr -c "A-Za-z0-9" "_")"
  printf "UNIT_%s_ACTIVE=%s\\n" "$key" "$(systemctl is-active "$unit" 2>/dev/null || true)"
  printf "UNIT_%s_ENABLED=%s\\n" "$key" "$(systemctl is-enabled "$unit" 2>/dev/null || true)"
done

for p in 3389 5800 9222; do
  if ss -lnt | awk -v x=":$p" '$4 ~ x"$" {f=1} END{exit f?0:1}'; then
    echo "LISTENER_$p=present"
  else
    echo "LISTENER_$p=absent"
  fi
done

for bin in chromium chromium-browser google-chrome google-chrome-stable firefox; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "BROWSER_BIN_$bin=$(command -v "$bin")"
  else
    echo "BROWSER_BIN_$bin=absent"
  fi
done

echo CF_HUMAN_SURFACE_SESSIONS_BEGIN
loginctl list-sessions --no-legend 2>/dev/null | sed -n "1,20p" || true
echo CF_HUMAN_SURFACE_SESSIONS_END

echo CF_HUMAN_SURFACE_DISPLAY_PROCESSES_BEGIN
ps -eo user,pid,ppid,comm,args 2>/dev/null | grep -E "Xorg|Xvnc|xrdp|gnome-session|xfce4-session|weston|wayland" | grep -v grep | sed -n "1,40p" || true
echo CF_HUMAN_SURFACE_DISPLAY_PROCESSES_END

for c in capability-fabric-onshape-chromium capability-fabric-onshape-phase0-research capability-fabric-onshape-phase0-fabric; do
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "CONTAINER_$c=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c")"
    if [[ "$c" == capability-fabric-onshape-phase0-research ]]; then
      env_dump="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c")"
      printf "%s\\n" "$env_dump" | grep -E "^(CF_RESEARCH_SOURCE_COMMIT|CF_RESEARCH_FIXTURE_TARGET|DISPLAY|WAYLAND_DISPLAY)=" | sed "s/^/RESEARCH_ENV_/" || true
    fi
  else
    echo "CONTAINER_$c=absent"
  fi
done

echo CF_HUMAN_SURFACE_DIAG_END
