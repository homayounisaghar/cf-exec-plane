#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

mode="${CF_PCG_PROVISION_WINDOW_MODE:-install}"
case "$mode" in install|open|status|close) ;; *) echo "invalid provisioning-window mode" >&2; exit 2 ;; esac

api_dir=/var/lib/capability-fabric/pcg/api-credentials
key_dir=/var/lib/capability-fabric/pcg/db-key
db_key="$key_dir/tdlib-db-key"
run_dir=/var/lib/capability-fabric/pcg/run
complete="$run_dir/provision-complete"
handoff_dir=/run/capability-fabric/pcg-provision
token_file="$handoff_dir/token"
bootstrap="$handoff_dir/bootstrap-url"
authorized_keys=/etc/capability-fabric/pcg-forward/authorized_keys
active=/opt/capability-fabric/channels/pcg/current
cleanup=/usr/local/libexec/capability-fabric-pcg-provision-cleanup
cleanup_service=/etc/systemd/system/capability-fabric-pcg-provision-cleanup.service
cleanup_timer=/etc/systemd/system/capability-fabric-pcg-provision-cleanup.timer
port=8766

for cmd in python3 install stat systemctl getent; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 3; }
done

ensure_layout() {
  getent passwd pcg-forward >/dev/null || { echo "pcg-forward principal missing" >&2; exit 20; }
  getent group pcg-forward >/dev/null || { echo "pcg-forward group missing" >&2; exit 20; }
  install -d -m 0700 -o 65534 -g 65534 "$api_dir"
  install -d -m 0750 -o root -g 65534 "$key_dir"
  install -d -m 0770 -o 65534 -g 65534 "$run_dir"
  install -d -m 0755 -o root -g root "$handoff_dir"

  if [[ -e "$db_key" ]]; then
    [[ -f "$db_key" && ! -L "$db_key" ]] || { echo "unsafe TDLib DB key path" >&2; exit 21; }
  else
    temp="$(mktemp "$key_dir/.tdlib-db-key.XXXXXX")"
    python3 - "$temp" <<'PY'
import os,sys
path=sys.argv[1]
with open(path,'wb') as f:
    f.write(os.urandom(32))
    f.flush()
    os.fsync(f.fileno())
PY
    chown root:65534 "$temp"
    chmod 0640 "$temp"
    mv -f "$temp" "$db_key"
  fi

  [[ "$(stat -c '%a %u:%g' "$api_dir")" == "700 65534:65534" ]]
  [[ "$(stat -c '%a %u:%g' "$key_dir")" == "750 0:65534" ]]
  [[ "$(stat -c '%a %u:%g' "$db_key")" == "640 0:65534" ]]
  [[ "$(stat -c '%s' "$db_key")" -ge 32 ]]
}

install_cleanup() {
  cat > "$cleanup" <<'CLEANUP'
#!/usr/bin/env bash
set -euo pipefail
rm -f /run/capability-fabric/pcg-provision/token
rm -f /run/capability-fabric/pcg-provision/bootstrap-url
CLEANUP
  chown root:root "$cleanup"
  chmod 0755 "$cleanup"

  cat > "$cleanup_service" <<EOF
[Unit]
Description=Close Capability Fabric PCG one-time provisioning window

[Service]
Type=oneshot
ExecStart=$cleanup
User=root
Group=root
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=$handoff_dir
EOF

  cat > "$cleanup_timer" <<EOF
[Unit]
Description=Expire Capability Fabric PCG one-time provisioning window

[Timer]
OnActiveSec=15min
AccuracySec=5s
Unit=capability-fabric-pcg-provision-cleanup.service

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "$cleanup_service" "$cleanup_timer"
  systemctl daemon-reload
}

status() {
  if [[ -s "$authorized_keys" ]]; then echo "PCG_FORWARD_KEY_INSTALLED=yes"; else echo "PCG_FORWARD_KEY_INSTALLED=no"; fi
  if [[ -s "$token_file" && -s "$bootstrap" && ! -e "$complete" ]]; then
    echo "PCG_PROVISION_WINDOW=active"
  else
    echo "PCG_PROVISION_WINDOW=inactive"
  fi
  if [[ -e "$complete" ]]; then echo "PCG_PROVISION_COMPLETE=yes"; else echo "PCG_PROVISION_COMPLETE=no"; fi
  echo "PCG_TDLIB_DB_KEY=present"
}

if [[ "$mode" == install ]]; then
  ensure_layout
  install_cleanup
  "$cleanup"
  echo "PCG_PROVISION_WINDOW_INSTALL=pass"
  status
  exit 0
fi

ensure_layout

if [[ "$mode" == close ]]; then
  "$cleanup"
  systemctl stop capability-fabric-pcg-provision-cleanup.timer >/dev/null 2>&1 || true
  echo "PCG_PROVISION_WINDOW=closed"
  exit 0
fi

if [[ "$mode" == status ]]; then
  status
  exit 0
fi

# open
[[ -s "$authorized_keys" ]] || { echo "BLOCKED: phone public key is not enrolled" >&2; exit 30; }
[[ -L "$active" ]] || { echo "BLOCKED: PCG active release is unavailable" >&2; exit 31; }
release="$(readlink -f "$active")"
[[ -r "$release/manifest.json" ]] || { echo "BLOCKED: active PCG manifest unavailable" >&2; exit 31; }
release_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_id"])' "$release/manifest.json")"
[[ "$release_id" == pcg-provisioning-r3 ]] || { echo "BLOCKED: final-channel provisioning release is not active" >&2; exit 31; }

rm -f "$complete"
"$cleanup"
token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
tmp_token="$(mktemp "$handoff_dir/.token.XXXXXX")"
printf '%s\n' "$token" > "$tmp_token"
chown root:65534 "$tmp_token"
chmod 0640 "$tmp_token"
mv -f "$tmp_token" "$token_file"

tmp_bootstrap="$(mktemp "$handoff_dir/.bootstrap.XXXXXX")"
printf 'http://127.0.0.1:%s/#token=%s\n' "$port" "$token" > "$tmp_bootstrap"
chown root:pcg-forward "$tmp_bootstrap"
chmod 0640 "$tmp_bootstrap"
mv -f "$tmp_bootstrap" "$bootstrap"
unset token

systemctl stop capability-fabric-pcg-provision-cleanup.timer >/dev/null 2>&1 || true
systemctl start capability-fabric-pcg-provision-cleanup.timer
echo "PCG_PROVISION_WINDOW=active"
echo "PCG_PROVISION_WINDOW_TTL_SECONDS=900"
