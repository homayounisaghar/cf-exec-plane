#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${CF_REPO_READ_TOKEN:?CF_REPO_READ_TOKEN is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
: "${CF_DEPLOY_SIGNING_PRIVATE_KEY:?CF_DEPLOY_SIGNING_PRIVATE_KEY is required}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"
port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
for cmd in git ssh-keygen python3 sha256sum ssh tar; do command -v "$cmd" >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 2; }; done

repo_url=https://github.com/homayounisaghar/capability-fabric.git
deploy_dir=server-deploy/current
sign_id=capability-fabric-deploy
sign_namespace=capability-fabric-deploy
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-stage2-precheck.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

pub_line="$(printf '%s' "$CF_DEPLOY_SIGNING_PUBLIC_KEY" | tr -d '\r\n')"
read -r pub_type pub_data pub_extra <<< "$pub_line"
[[ "$pub_type" == ssh-ed25519 && -n "$pub_data" && -z "${pub_extra:-}" ]] || { echo "deployment public key format invalid" >&2; exit 2; }
case "$pub_data" in *[!A-Za-z0-9+/=]*) echo "deployment public key data malformed" >&2; exit 2 ;; esac
printf '%s %s\n' "$sign_id" "$pub_line" > "$tmp/allowed-main"

cat > "$tmp/askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$CF_REPO_READ_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 0700 "$tmp/askpass"
git init --bare "$tmp/repo.git" >/dev/null
GIT_ASKPASS="$tmp/askpass" GIT_TERMINAL_PROMPT=0 git --git-dir="$tmp/repo.git" fetch --quiet --depth=1 "$repo_url" refs/heads/main:refs/heads/source-main
commit="$(git --git-dir="$tmp/repo.git" rev-parse refs/heads/source-main)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || exit 3
git --git-dir="$tmp/repo.git" show "$commit:$deploy_dir/manifest.json" > "$tmp/manifest.json"

python3 - "$tmp/manifest.json" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
if m.get('schema')!='capability-fabric.deploy.v1': raise SystemExit('schema mismatch')
if not isinstance(m.get('sequence'),int) or m['sequence'] < 1: raise SystemExit('bad sequence')
if not isinstance(m.get('release_id'),str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',m['release_id']): raise SystemExit('bad release_id')
PY

key_file="$tmp/deploy-signing-key"
printf '%s\n' "$CF_DEPLOY_SIGNING_PRIVATE_KEY" | tr -d '\r' > "$key_file"
chmod 0600 "$key_file"
derived="$(ssh-keygen -y -f "$key_file")"
read -r dkt dkd dkx <<< "$derived"
[[ "$dkt" == "$pub_type" && "$dkd" == "$pub_data" && -z "${dkx:-}" ]] || { echo "deployment signing keypair mismatch" >&2; exit 4; }

(
  cd "$tmp"
  ssh-keygen -Y sign -f "$key_file" -n "$sign_namespace" manifest.json >/dev/null
)
[[ -s "$tmp/manifest.json.sig" ]] || exit 5
ssh-keygen -Y verify -f "$tmp/allowed-main" -I "$sign_id" -n "$sign_namespace" -s "$tmp/manifest.json.sig" < "$tmp/manifest.json" >/dev/null
echo "CF_STAGE2_MAIN_LOCAL_SIGN_VERIFY=pass"

vps_key="$tmp/vps-key"
known_hosts="$tmp/known-hosts"
printf '%s\n' "$VPS_SSH_KEY" > "$vps_key"
chmod 0600 "$vps_key"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
[[ "$host_key_line" != *$'\n'* ]] || exit 6
read -r hkt hkd hkx <<< "$host_key_line"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 6
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$known_hosts"
chmod 0600 "$known_hosts"

tar -C "$tmp" -czf - manifest.json manifest.json.sig | ssh \
  -i "$vps_key" \
  -p "$port" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts" \
  -o ConnectTimeout=15 \
  "${VPS_SSH_USER}@${VPS_HOST}" 'set -euo pipefail; umask 077
    work="$(mktemp -d /tmp/cf-stage2-precheck.XXXXXX)"
    trap '\''rm -rf "$work"'\'' EXIT
    tar -xzf - -C "$work"
    current="$(readlink -f /opt/capability-fabric/current)"
    [[ "$current" == /var/lib/capability-fabric/releases/* ]] || exit 10
    [[ -s "$current/manifest.json" && -x "$current/health.sh" ]] || exit 10
    [[ "$(sha256sum "$current/manifest.json" | cut -d " " -f1)" == "$(sha256sum "$work/manifest.json" | cut -d " " -f1)" ]] || {
      echo "CF_STAGE2_MAIN_CURRENT_MATCH=fail" >&2
      exit 11
    }
    new_trust=/etc/capability-fabric/trust/deploy-signing-next.pub
    old_trust=/etc/capability-fabric/trust/deploy-signing.pub
    [[ -s "$old_trust" && -s "$new_trust" ]] || exit 12
    [[ "$(cat "$old_trust")" != "$(cat "$new_trust")" ]] || exit 12
    printf "capability-fabric-deploy %s\n" "$(cat "$new_trust")" > "$work/allowed-new"
    ssh-keygen -Y verify -f "$work/allowed-new" -I capability-fabric-deploy -n capability-fabric-deploy -s "$work/manifest.json.sig" < "$work/manifest.json" >/dev/null
    timeout 300 env CF_RELEASE_DIR="$current" CF_COMPOSE_PROJECT=capability-fabric bash "$current/health.sh" >/dev/null
    printf "CF_STAGE2_MAIN_SERVER_NEW_TRUST_VERIFY=pass\n"
    printf "CF_STAGE2_MAIN_CURRENT_HEALTH=pass\n"
    printf "CF_STAGE2_OLD_TRUST_STILL_PRESENT=yes\n"
    printf "CF_STAGE2_NO_OLD_MATERIAL_REMOVED=yes\n"'
