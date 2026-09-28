#!/usr/bin/env bash
set -euo pipefail

script_rel="${1:?usage: remote-bundle-exec-resilient.sh <server-bootstrap-script>}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
case "$script_rel" in server-bootstrap/*.sh) ;; *) echo "unsupported bootstrap script path" >&2; exit 2 ;; esac
[[ "$script_rel" != *".."* && "$script_rel" != *$'\n'* && "$script_rel" != *$'\r'* ]] || exit 2

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
[[ -f "$workspace/$script_rel" ]] || { echo "bootstrap script missing" >&2; exit 2; }
wait_seconds="${CF_REMOTE_BUNDLE_WAIT_SECONDS:-2100}"
runtime_seconds="${CF_REMOTE_BUNDLE_RUNTIME_SECONDS:-2220}"
poll_seconds="${CF_REMOTE_BUNDLE_POLL_SECONDS:-5}"
inject_poll_failures="${CF_REMOTE_BUNDLE_INJECT_POLL_FAILURES:-0}"
max_poll_failures="${CF_REMOTE_BUNDLE_MAX_POLL_FAILURES:-6}"
ssh_call_seconds="${CF_REMOTE_BUNDLE_SSH_CALL_SECONDS:-75}"
for n in "$wait_seconds" "$runtime_seconds" "$poll_seconds" "$inject_poll_failures" "$max_poll_failures" "$ssh_call_seconds"; do
  case "$n" in ''|*[!0-9]*) echo "resilient runner timing values must be numeric" >&2; exit 2 ;; esac
done
(( wait_seconds >= 60 && runtime_seconds > wait_seconds && poll_seconds >= 1 && poll_seconds <= 30 && max_poll_failures >= 2 && max_poll_failures <= 30 && ssh_call_seconds >= 15 && ssh_call_seconds <= 120 )) || {
  echo "invalid resilient runner timing bounds" >&2
  exit 2
}

key_file="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-vps-key.XXXXXX")"
known_hosts="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-known-hosts.XXXXXX")"
archive="$(mktemp "${RUNNER_TEMP:-/tmp}/cf-bootstrap-bundle.XXXXXX.tgz")"
cleanup() { rm -f "$key_file" "$known_hosts" "$archive"; }
trap cleanup EXIT
umask 077
printf '%s\n' "$VPS_SSH_KEY" > "$key_file"
chmod 600 "$key_file"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r key_type key_data extra <<< "$host_key_line"
[[ "$key_type" == ssh-ed25519 && -n "$key_data" && -z "${extra:-}" ]] || exit 3
printf '%s %s %s\n' "$VPS_HOST" "$key_type" "$key_data" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$key_type" "$key_data" >> "$known_hosts"
chmod 600 "$known_hosts"

ssh_opts=(
  -i "$key_file" -p "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$known_hosts"
  -o ConnectTimeout=15
  -o ConnectionAttempts=1
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o TCPKeepAlive=yes
)

ssh_run() {
  timeout --foreground --signal=TERM "${ssh_call_seconds}s" ssh_run "$@"
}

remote_env=("VPS_SSH_PORT=$port")
[[ -n "${CF_PHASE4_MODE:-}" ]] && remote_env+=("CF_PHASE4_MODE=$CF_PHASE4_MODE")
[[ -n "${CF_ADMIN_USER:-}" ]] && remote_env+=("CF_ADMIN_USER=$CF_ADMIN_USER")
[[ -n "${CF_NEW_SSH_PUBLIC_KEY:-}" ]] && remote_env+=("CF_NEW_SSH_PUBLIC_KEY=$CF_NEW_SSH_PUBLIC_KEY")
[[ -n "${CF_DEPLOY_SIGNING_PUBLIC_KEY:-}" ]] && remote_env+=("CF_DEPLOY_SIGNING_PUBLIC_KEY=$CF_DEPLOY_SIGNING_PUBLIC_KEY")
[[ -n "${CF_BACKUP_MODE:-}" ]] && remote_env+=("CF_BACKUP_MODE=$CF_BACKUP_MODE")
[[ -n "${CF_REAUTH_SESSION_ID:-}" ]] && remote_env+=("CF_REAUTH_SESSION_ID=$CF_REAUTH_SESSION_ID")
[[ -n "${CF_PCG_PROVISION_SSH_MODE:-}" ]] && remote_env+=("CF_PCG_PROVISION_SSH_MODE=$CF_PCG_PROVISION_SSH_MODE")
[[ -n "${CF_PCG_FORWARD_PUBLIC_KEY:-}" ]] && remote_env+=("CF_PCG_FORWARD_PUBLIC_KEY=$CF_PCG_FORWARD_PUBLIC_KEY")
[[ -n "${CF_PCG_PROVISION_WINDOW_MODE:-}" ]] && remote_env+=("CF_PCG_PROVISION_WINDOW_MODE=$CF_PCG_PROVISION_WINDOW_MODE")
[[ -n "${CF_PCG_WEB_CONTROL_MODE:-}" ]] && remote_env+=("CF_PCG_WEB_CONTROL_MODE=$CF_PCG_WEB_CONTROL_MODE")
[[ -n "${CF_PCG_WEB_CONTROL_CIPHERTEXT:-}" ]] && remote_env+=("CF_PCG_WEB_CONTROL_CIPHERTEXT=$CF_PCG_WEB_CONTROL_CIPHERTEXT")

tar -C "$workspace" -czf "$archive" server-bootstrap
archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
seed="${GITHUB_RUN_ID:-manual}|${GITHUB_RUN_ATTEMPT:-1}|${GITHUB_JOB:-job}|${GITHUB_SHA:-nosha}|$script_rel"
job_key="$(printf '%s' "$seed" | sha256sum | awk '{print substr($1,1,24)}')"
unit="cf-bootstrap-$job_key"
remote_root="/root/.cf-bootstrap-jobs/$job_key"

printf -v qroot '%q' "$remote_root"
printf -v qsha '%q' "$archive_sha"
upload_cmd="set -euo pipefail; mkdir -p $qroot; chmod 700 $qroot; cat > $qroot/bundle.tgz; chmod 600 $qroot/bundle.tgz; [[ \$(sha256sum $qroot/bundle.tgz | awk '{print \$1}') == $qsha ]]"
cat "$archive" | ssh_run "$upload_cmd"

remote_runner='#!/usr/bin/env bash
set -euo pipefail
root="$1"
script_rel="$2"
shift 2
log="$root/output.log"
status="$root/status"
work="$root/work"
rm -rf "$work"
mkdir -p "$work"
chmod 700 "$work"
write_status(){
  local rc="$1"
  printf "%s\n" "$rc" > "$status.tmp"
  chmod 600 "$status.tmp"
  mv -f "$status.tmp" "$status"
}
on_exit(){
  rc=$?
  trap - EXIT
  [[ -s "$status" ]] || write_status "$rc"
  exit "$rc"
}
trap on_exit EXIT
tar -xzf "$root/bundle.tgz" -C "$work"
cd "$work"
set +e
env "$@" bash "$script_rel" >"$log" 2>&1
rc=$?
set -e
write_status "$rc"
trap - EXIT
exit "$rc"
'

runner_b64="$(printf '%s' "$remote_runner" | base64 -w0)"
printf -v qunit '%q' "$unit"
printf -v qscript '%q' "$script_rel"
printf -v qruntime '%q' "$runtime_seconds"
printf -v qrunner '%q' "$runner_b64"
start_cmd="set -euo pipefail; mkdir -p $qroot; chmod 700 $qroot; if [[ -s $qroot/status ]]; then exit 0; fi; printf %s $qrunner | base64 -d > $qroot/runner.sh; chmod 700 $qroot/runner.sh; "
start_cmd+="if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print \$1}' | grep -Fxq $qunit.service || ! systemctl status $qunit.service >/dev/null 2>&1; then "
start_cmd+="systemd-run --unit=$qunit --no-block --property=Type=oneshot --property=RuntimeMaxSec=${qruntime}s --property=TimeoutStopSec=180 --property=KillMode=control-group $qroot/runner.sh $qroot $qscript"
for kv in "${remote_env[@]}"; do
  printf -v q '%q' "$kv"
  start_cmd+=" $q"
done
start_cmd+="; fi"
ssh_run "$start_cmd"

echo "CF_REMOTE_BUNDLE_EXECUTION=detached-systemd"
echo "CF_REMOTE_BUNDLE_JOB=$job_key"

deadline=$((SECONDS + wait_seconds))
poll_failures=0
injected=0
state=""
while (( SECONDS < deadline )); do
  if (( injected < inject_poll_failures )); then
    injected=$((injected + 1))
    poll_failures=$((poll_failures + 1))
    if (( poll_failures >= max_poll_failures )); then
      echo "CF_REMOTE_BUNDLE_POLL_HANDOFF=detached-unit-continues" >&2
      exit 75
    fi
    sleep "$poll_seconds"
    continue
  fi
  check_cmd="set -euo pipefail; if [[ -s $qroot/status ]]; then printf 'DONE:'; cat $qroot/status; elif systemctl is-active --quiet $qunit.service; then echo RUNNING; elif systemctl is-failed --quiet $qunit.service; then echo UNIT_FAILED; else echo UNIT_UNKNOWN; fi"
  if state="$(ssh_run "$check_cmd" 2>/dev/null)"; then
    poll_failures=0
    case "$state" in
      DONE:*)
        rc="${state#DONE:}"
        case "$rc" in ''|*[!0-9]*) rc=125 ;; esac
        log_cmd="cat $qroot/output.log 2>/dev/null || true"
        ssh_run "$log_cmd" || true
        if [[ "$rc" -eq 0 ]]; then
          cleanup_cmd="rm -rf $qroot; systemctl reset-failed $qunit.service >/dev/null 2>&1 || true"
          ssh_run "$cleanup_cmd" >/dev/null 2>&1 || true
        else
          echo "CF_REMOTE_BUNDLE_REMOTE_FAILURE=$rc" >&2
        fi
        exit "$rc"
        ;;
      RUNNING|UNIT_UNKNOWN|UNIT_FAILED) ;;
      *) ;;
    esac
  else
    poll_failures=$((poll_failures + 1))
    echo "CF_REMOTE_BUNDLE_POLL_TRANSPORT_UNAVAILABLE=$poll_failures" >&2
    if (( poll_failures >= max_poll_failures )); then
      echo "CF_REMOTE_BUNDLE_POLL_HANDOFF=detached-unit-continues" >&2
      exit 75
    fi
  fi
  sleep "$poll_seconds"
done

echo "CF_REMOTE_BUNDLE_LOCAL_DEADLINE=expired" >&2
stop_cmd="systemctl stop $qunit.service >/dev/null 2>&1 || true; for i in \$(seq 1 36); do [[ -s $qroot/status ]] && break; sleep 5; done; cat $qroot/output.log 2>/dev/null || true; if [[ -s $qroot/status ]]; then printf 'CF_REMOTE_BUNDLE_STOP_RC='; cat $qroot/status; fi"
ssh_run "$stop_cmd" || true
exit 124
