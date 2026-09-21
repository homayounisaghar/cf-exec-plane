#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
mode="${CF_PHASE4_MODE:-install}"
case "$mode" in install|activate) ;; *) echo "CF_PHASE4_MODE must be install or activate" >&2; exit 2 ;; esac

credential=/etc/capability-fabric/secrets/repo-read-token
trust_key=/etc/capability-fabric/trust/deploy-signing.pub
[[ -s "$credential" ]] || { echo "BLOCKED: missing read-only repository credential at $credential" >&2; exit 20; }
[[ -s "$trust_key" ]] || { echo "BLOCKED: missing deployment signing public key at $trust_key" >&2; exit 21; }

read -r key_type key_data extra < "$trust_key" || true
[[ "$key_type" == ssh-ed25519 && -n "${key_data:-}" && -z "${extra:-}" ]] || { echo "invalid deployment signing public key format" >&2; exit 21; }
case "$key_data" in *[!A-Za-z0-9+/=]*) echo "invalid deployment signing public key data" >&2; exit 21 ;; esac

for cmd in git python3 ssh-keygen flock docker; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 22; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin missing" >&2; exit 22; }

src=server-bootstrap/pull-agent/cf-pull-agent-pcg.sh
provision_src=server-bootstrap/44-pcg-provisioning-window.sh
[[ -s "$src" ]] || { echo "PCG pull-agent source missing from bootstrap bundle" >&2; exit 22; }
[[ -s "$provision_src" ]] || { echo "PCG provisioning supervisor missing from bootstrap bundle" >&2; exit 22; }

install -d -m 0755 /usr/local/libexec /opt/capability-fabric/channels/pcg /run/lock
install -m 0750 -o root -g root "$src" /usr/local/libexec/capability-fabric-pcg-pull-agent
install -m 0750 -o root -g root "$provision_src" /usr/local/libexec/capability-fabric-pcg-provision-window
CF_PCG_PROVISION_WINDOW_MODE=install /usr/local/libexec/capability-fabric-pcg-provision-window
install -d -m 0750 -o root -g root /var/lib/capability-fabric/deploy/pcg/state /var/lib/capability-fabric/deploy/pcg/releases /var/lib/capability-fabric/deploy/pcg/signatures /var/log/capability-fabric
install -d -m 0750 -o root -g root /var/lib/capability-fabric/pcg
install -d -m 0770 -o 65534 -g 65534 /var/lib/capability-fabric/pcg/run
install -d -m 0700 -o 65534 -g 65534 /var/lib/capability-fabric/pcg/core-state /var/lib/capability-fabric/pcg/telegram-state
install -d -m 0700 -o root -g root /var/lib/capability-fabric/pcg/correlation

cat > /etc/systemd/system/capability-fabric-pcg-pull.service <<'UNIT'
[Unit]
Description=Capability Fabric PCG signed pull deploy agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/capability-fabric-pcg-pull-agent pull
User=root
Group=root
UMask=0077
Environment=HOME=/var/lib/capability-fabric/agent-home
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=/var/lib/capability-fabric/deploy/pcg /var/lib/capability-fabric/pcg /var/lib/capability-fabric/agent-home /var/log/capability-fabric /opt/capability-fabric/channels/pcg /run/lock
LockPersonality=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/capability-fabric-pcg-pull.timer <<'UNIT'
[Unit]
Description=Poll private PCG branch for a signed PCG deployment

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
RandomizedDelaySec=45s
Persistent=true
Unit=capability-fabric-pcg-pull.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl disable --now capability-fabric-pcg-pull.timer >/dev/null 2>&1 || true

if [[ "$mode" == install ]]; then
  systemctl cat capability-fabric-pcg-pull.service >/dev/null
  systemctl cat capability-fabric-pcg-pull.timer >/dev/null
  printf 'CF_PCG_PULL_AGENT_INSTALL_BEGIN\n'
  printf 'AGENT_INSTALLED=yes\n'
  printf 'SERVICE_INSTALLED=yes\n'
  printf 'TIMER_INSTALLED=yes\n'
  printf 'TIMER_ENABLED=no\n'
  printf 'CF_PCG_PULL_AGENT_INSTALL_END\n'
  exit 0
fi

if ! /usr/local/libexec/capability-fabric-pcg-pull-agent pull; then
  echo "PCG signed activation failed; timer remains disabled" >&2
  exit 30
fi
if ! /usr/local/libexec/capability-fabric-pcg-pull-agent rollback-drill; then
  echo "PCG rollback drill failed; timer remains disabled" >&2
  exit 31
fi
systemctl enable --now capability-fabric-pcg-pull.timer
printf 'CF_PCG_PULL_AGENT_ACTIVATE_BEGIN\n'
printf 'SIGNED_APPLY=pass\n'
printf 'ROLLBACK_DRILL=pass\n'
printf 'TIMER_ENABLED=yes\n'
printf 'CF_PCG_PULL_AGENT_ACTIVATE_END\n'
