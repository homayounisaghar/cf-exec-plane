#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${CF_PCG_SOURCE_COMMIT:?CF_PCG_SOURCE_COMMIT is required}"
: "${CF_REPO_READ_TOKEN:?CF_REPO_READ_TOKEN is required}"
: "${CF_DEPLOY_SIGNING_PUBLIC_KEY:?CF_DEPLOY_SIGNING_PUBLIC_KEY is required}"
: "${CF_DEPLOY_SIGNING_PRIVATE_KEY:?CF_DEPLOY_SIGNING_PRIVATE_KEY is required}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required}"
: "${VPS_HOST_KEY:?VPS_HOST_KEY is required}"

source_commit="$CF_PCG_SOURCE_COMMIT"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid PCG source commit" >&2; exit 2; }

port="${VPS_PORT:-22}"
case "$port" in ''|*[!0-9]*) echo "VPS_PORT must be numeric" >&2; exit 2 ;; esac
case "$VPS_SSH_USER" in ''|*[!a-zA-Z0-9_-]*) echo "VPS_SSH_USER contains unsupported characters" >&2; exit 2 ;; esac
for cmd in git ssh-keygen python3 sha256sum docker ssh; do command -v "$cmd" >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 2; }; done
docker compose version >/dev/null 2>&1 || { echo "docker compose unavailable on signer runner" >&2; exit 2; }

repo_url=https://github.com/homayounisaghar/capability-fabric.git
deploy_dir=server-deploy/channels/pcg/current
manifest_path="$deploy_dir/manifest.json"
signature_dir=/var/lib/capability-fabric/deploy/pcg/signatures
sign_id=capability-fabric-deploy
sign_namespace=capability-fabric-deploy

tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cf-pcg-deploy-signer.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

pub_line="$(printf '%s' "$CF_DEPLOY_SIGNING_PUBLIC_KEY" | tr -d '\r\n')"
read -r pub_type pub_data pub_extra <<< "$pub_line"
[[ "$pub_type" == ssh-ed25519 && -n "$pub_data" && -z "${pub_extra:-}" ]] || { echo "deployment public key format invalid" >&2; exit 2; }
case "$pub_data" in *[!A-Za-z0-9+/=]*) echo "deployment public key data malformed" >&2; exit 2 ;; esac
printf '%s %s\n' "$sign_id" "$pub_line" > "$tmp/allowed_signers"

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
GIT_ASKPASS="$tmp/askpass" GIT_TERMINAL_PROMPT=0 git --git-dir="$tmp/repo.git" fetch --quiet --depth=1 "$repo_url" "$source_commit"
commit="$(git --git-dir="$tmp/repo.git" rev-parse FETCH_HEAD)"
[[ "$commit" == "$source_commit" ]] || { echo "source commit mismatch" >&2; exit 3; }

candidate="$tmp/candidate"
mkdir -m 0700 "$candidate"
git --git-dir="$tmp/repo.git" show "$commit:$manifest_path" > "$candidate/manifest.json"
manifest_sha="$(sha256sum "$candidate/manifest.json" | awk '{print $1}')"
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || exit 3

python3 - "$candidate/manifest.json" "$tmp/files" "$tmp/images" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
if set(m)!={'schema','sequence','release_id','compose_file','health_file','health_timeout_seconds','files','images'}: raise SystemExit('manifest keys mismatch')
if m['schema']!='capability-fabric.deploy.v1': raise SystemExit('schema mismatch')
if not isinstance(m['sequence'],int) or not 1 <= m['sequence'] <= 9223372036854775807: raise SystemExit('bad sequence')
if not isinstance(m['release_id'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',m['release_id']): raise SystemExit('bad release_id')
if m['compose_file']!='compose.yaml' or m['health_file']!='health.sh': raise SystemExit('fixed names required')
if not isinstance(m['health_timeout_seconds'],int) or not 5 <= m['health_timeout_seconds'] <= 300: raise SystemExit('bad timeout')
files=m['files']; images=m['images']
if not isinstance(files,dict) or not files or not {'compose.yaml','health.sh'} <= set(files): raise SystemExit('bad files')
for p,h in files.items():
    if not isinstance(p,str) or p.startswith('/') or '..' in p.split('/') or not re.fullmatch(r'[A-Za-z0-9._/-]+',p): raise SystemExit('unsafe path')
    if not isinstance(h,str) or not re.fullmatch(r'[0-9a-f]{64}',h): raise SystemExit('bad hash')
if not isinstance(images,list) or not images or len(set(images))!=len(images): raise SystemExit('bad images')
for i in images:
    if not isinstance(i,str) or not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}',i): raise SystemExit('image not digest pinned')
with open(sys.argv[2],'w',encoding='utf-8') as f:
    for p in sorted(files): f.write(f'{p}\t{files[p]}\n')
with open(sys.argv[3],'w',encoding='utf-8') as f:
    for i in sorted(images): f.write(i+'\n')
PY

while IFS=$'\t' read -r rel expected_hash; do
  [[ -n "$rel" ]] || continue
  install -d -m 0700 "$(dirname "$candidate/$rel")"
  git --git-dir="$tmp/repo.git" show "$commit:$deploy_dir/$rel" > "$candidate/$rel"
  [[ "$(sha256sum "$candidate/$rel" | awk '{print $1}')" == "$expected_hash" ]] || { echo "candidate file hash mismatch: $rel" >&2; exit 4; }
done < "$tmp/files"

docker compose -f "$candidate/compose.yaml" config --format json > "$tmp/compose.json"
python3 - "$tmp/compose.json" "$tmp/images" <<'PY'
import json,sys
c=json.load(open(sys.argv[1],encoding='utf-8')); s=c.get('services')
if not isinstance(s,dict) or not s: raise SystemExit('no services')
actual=[]
for n,v in s.items():
    if 'build' in v: raise SystemExit(f'build forbidden: {n}')
    i=v.get('image')
    if not isinstance(i,str) or not i: raise SystemExit(f'image required: {n}')
    actual.append(i)
expected=[x.strip() for x in open(sys.argv[2],encoding='utf-8') if x.strip()]
if sorted(set(actual))!=sorted(expected): raise SystemExit('image set mismatch')
if set(s) != {'pcg_core','pcg_telegram'}:
    raise SystemExit('unexpected PCG service set')
for n,v in s.items():
    if v.get('read_only') is not True:
        raise SystemExit(f'PCG service must be read_only: {n}')
core=s['pcg_core']
telegram=s['pcg_telegram']
if core.get('network_mode') != 'none':
    raise SystemExit('pcg_core must remain network_mode none')
if core.get('ports') not in (None, []):
    raise SystemExit('pcg_core must not publish ports')
if telegram.get('network_mode') != 'bridge':
    raise SystemExit('pcg_telegram provisioning runtime must use bridge network')
ports=telegram.get('ports')
if not isinstance(ports,list) or len(ports)!=1:
    raise SystemExit('pcg_telegram must publish exactly one provisioning port')
p=ports[0]
if not isinstance(p,dict):
    raise SystemExit('pcg_telegram provisioning port must be structured')
if p.get('host_ip') != '127.0.0.1' or int(p.get('target',0)) != 8766 or int(p.get('published',0)) != 8766 or p.get('protocol','tcp') != 'tcp':
    raise SystemExit('pcg_telegram provisioning port must be 127.0.0.1:8766->8766/tcp')
PY

vps_key="$tmp/vps-key"; known_hosts="$tmp/known-hosts"
printf '%s\n' "$VPS_SSH_KEY" > "$vps_key"; chmod 0600 "$vps_key"
host_key_line="${VPS_HOST_KEY//$'\r'/}"
read -r hkt hkd hkx <<< "$host_key_line"
[[ "$hkt" == ssh-ed25519 && -n "$hkd" && -z "${hkx:-}" ]] || exit 6
printf '%s %s %s\n' "$VPS_HOST" "$hkt" "$hkd" > "$known_hosts"
printf '[%s]:%s %s %s\n' "$VPS_HOST" "$port" "$hkt" "$hkd" >> "$known_hosts"
chmod 0600 "$known_hosts"
ssh_base=(ssh -i "$vps_key" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15 "${VPS_SSH_USER}@${VPS_HOST}")

existing="$tmp/existing.sig"
set +e
printf '%s\n' "$manifest_sha" | "${ssh_base[@]}" 'set -euo pipefail; read -r h; [[ "$h" =~ ^[0-9a-f]{64}$ ]] || exit 2; p="/var/lib/capability-fabric/deploy/pcg/signatures/${h}.sig"; [[ -s "$p" ]] && cat "$p" || exit 44' > "$existing"
rc=$?
set -e
if [[ "$rc" -eq 0 && -s "$existing" ]] && ssh-keygen -Y verify -f "$tmp/allowed_signers" -I "$sign_id" -n "$sign_namespace" -s "$existing" < "$candidate/manifest.json" >/dev/null 2>&1; then
  echo "CF_PCG_SIGNER_SIGNATURE=already-valid"
  exit 0
fi

key_file="$tmp/deploy-signing-key"
printf '%s\n' "$CF_DEPLOY_SIGNING_PRIVATE_KEY" | tr -d '\r' > "$key_file"
chmod 0600 "$key_file"
derived="$(ssh-keygen -y -f "$key_file")"
read -r dkt dkd dkx <<< "$derived"
[[ "$dkt" == "$pub_type" && "$dkd" == "$pub_data" && -z "${dkx:-}" ]] || { echo "deployment signing keypair mismatch" >&2; exit 5; }

(cd "$candidate" && ssh-keygen -Y sign -f "$key_file" -n "$sign_namespace" manifest.json >/dev/null)
[[ -s "$candidate/manifest.json.sig" ]] || exit 7
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I "$sign_id" -n "$sign_namespace" -s "$candidate/manifest.json.sig" < "$candidate/manifest.json" >/dev/null

{
  printf '%s\n' "$manifest_sha"
  cat "$candidate/manifest.json.sig"
} | "${ssh_base[@]}" 'set -euo pipefail; umask 077; read -r h; [[ "$h" =~ ^[0-9a-f]{64}$ ]] || exit 2; d=/var/lib/capability-fabric/deploy/pcg/signatures; install -d -m 0750 -o root -g root "$d"; t=$(mktemp "$d/.signature.XXXXXX"); trap '\''rm -f "$t"'\'' EXIT; cat > "$t"; grep -q "BEGIN SSH SIGNATURE" "$t"; grep -q "END SSH SIGNATURE" "$t"; chown root:root "$t"; chmod 0640 "$t"; mv -f "$t" "$d/${h}.sig"; trap - EXIT; ls -1t "$d"/*.sig 2>/dev/null | tail -n +33 | xargs -r rm -f'

release_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_id"])' "$candidate/manifest.json")"
sequence="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "$candidate/manifest.json")"
echo "CF_PCG_SIGNER_SOURCE_COMMIT=$commit"
echo "CF_PCG_SIGNER_SEQUENCE=$sequence"
echo "CF_PCG_SIGNER_RELEASE_ID=$release_id"
echo "CF_PCG_SIGNER_MANIFEST_SHA256=$manifest_sha"
echo "CF_PCG_SIGNER_SIGNATURE=installed"
