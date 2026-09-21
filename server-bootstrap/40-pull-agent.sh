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

export DEBIAN_FRONTEND=noninteractive
missing=()
for pair in git:git python3:python3 ssh-keygen:openssh-client flock:util-linux; do
  cmd="${pair%%:*}"
  pkg="${pair#*:}"
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$pkg")
done
if ((${#missing[@]})); then
  apt-get update
  apt-get install -y "${missing[@]}"
fi
command -v docker >/dev/null 2>&1 || { echo "Docker missing; Phase 3 must complete first" >&2; exit 22; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin missing" >&2; exit 22; }

src=server-bootstrap/pull-agent/cf-pull-agent.sh
guard_src=server-bootstrap/pull-agent/runtime_control_guard.py
[[ -s "$src" && -s "$guard_src" ]] || { echo "pull-agent/guard source missing from bootstrap bundle" >&2; exit 22; }
install -d -m 0755 /usr/local/libexec
install -m 0750 -o root -g root "$guard_src" /usr/local/libexec/capability-fabric-runtime-control-guard
install -m 0750 -o root -g root "$src" /usr/local/libexec/capability-fabric-pull-agent
install -d -m 0750 -o root -g root /var/lib/capability-fabric/state /var/lib/capability-fabric/agent-home /var/log/capability-fabric
install -d -m 0755 -o root -g root /opt/capability-fabric

cat > /etc/systemd/system/capability-fabric-pull.service <<'UNIT'
[Unit]
Description=Capability Fabric signed pull deploy agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/capability-fabric-pull-agent pull
User=root
Group=root
UMask=0077
Environment=HOME=/var/lib/capability-fabric/agent-home
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=/var/lib/capability-fabric /var/log/capability-fabric /opt/capability-fabric /run/lock
LockPersonality=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/capability-fabric-pull.timer <<'UNIT'
[Unit]
Description=Poll private Capability Fabric repository for a signed deployment

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=45s
Persistent=true
Unit=capability-fabric-pull.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl disable --now capability-fabric-pull.timer >/dev/null 2>&1 || true

if [[ "$mode" == install ]]; then
  systemctl cat capability-fabric-pull.service >/dev/null
  systemctl cat capability-fabric-pull.timer >/dev/null
  printf 'CF_PULL_AGENT_INSTALL_BEGIN\n'
  printf 'AGENT_INSTALLED=yes\n'
  printf 'SERVICE_INSTALLED=yes\n'
  printf 'TIMER_INSTALLED=yes\n'
  printf 'TIMER_ENABLED=no\n'
  printf 'CF_PULL_AGENT_INSTALL_END\n'
  exit 0
fi

# Activation is fail-closed. Enable the timer only after one signed release has
# applied successfully and the real local rollback drill passes.
if ! /usr/local/libexec/capability-fabric-pull-agent pull; then
  echo "Phase 4 activation failed; timer remains disabled" >&2
  exit 30
fi
if ! /usr/local/libexec/capability-fabric-pull-agent rollback-drill; then
  echo "Phase 4 rollback drill failed; timer remains disabled" >&2
  exit 31
fi
systemctl enable --now capability-fabric-pull.timer
printf 'CF_PULL_AGENT_ACTIVATE_BEGIN\n'
printf 'SIGNED_APPLY=pass\n'
printf 'ROLLBACK_DRILL=pass\n'
printf 'TIMER_ENABLED=yes\n'
printf 'CF_PULL_AGENT_ACTIVATE_END\n'
