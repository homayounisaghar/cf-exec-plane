#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

alias_name=personal_android_agent_line3
secret_dir=/etc/capability-fabric/secrets/android-agent/line3
trust_dir=/etc/capability-fabric/trust/android-agent
keystore="$secret_dir/personal-android-agent-line3.p12"
password_file="$secret_dir/personal-android-agent-line3.pass"
cert_file="$trust_dir/personal-android-agent-line3-cert.pem"
backup=/usr/local/libexec/capability-fabric-backup
backup_config=/etc/capability-fabric/backup.env

install -d -m 0700 -o root -g root "$secret_dir"
install -d -m 0755 -o root -g root "$trust_dir"

if [[ ! -s "$keystore" || ! -s "$password_file" ]]; then
  [[ ! -e "$keystore" && ! -e "$password_file" ]] || {
    echo "partial signer state exists; refusing to overwrite" >&2
    exit 10
  }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  openssl rand -base64 48 | tr -d '\n' > "$tmp/password"
  [[ "$(wc -c < "$tmp/password" | tr -d ' ')" -ge 48 ]] || exit 11

  openssl genpkey -algorithm RSA     -pkeyopt rsa_keygen_bits:3072     -out "$tmp/private.pem" >/dev/null 2>&1

  openssl req -new -x509 -sha256 -days 10950     -key "$tmp/private.pem"     -subj "/CN=Personal Android Agent line3/O=Capability Fabric/OU=Android Signing"     -out "$tmp/cert.pem"

  openssl pkcs12 -export     -name "$alias_name"     -inkey "$tmp/private.pem"     -in "$tmp/cert.pem"     -out "$tmp/signer.p12"     -passout "file:$tmp/password"

  install -m 0600 -o root -g root "$tmp/signer.p12" "$keystore"
  install -m 0600 -o root -g root "$tmp/password" "$password_file"
  install -m 0644 -o root -g root "$tmp/cert.pem" "$cert_file"
fi

[[ "$(stat -c '%U:%G:%a' "$keystore")" == root:root:600 ]] || exit 20
[[ "$(stat -c '%U:%G:%a' "$password_file")" == root:root:600 ]] || exit 21
[[ -s "$cert_file" ]] || exit 22

tmp_cert="$(mktemp)"
trap 'rm -f "$tmp_cert"' EXIT
openssl pkcs12 -in "$keystore" -passin "file:$password_file" -clcerts -nokeys -out "$tmp_cert" >/dev/null 2>&1
openssl x509 -in "$tmp_cert" -noout -checkend 31536000 >/dev/null

fingerprint="$(openssl x509 -in "$tmp_cert" -noout -fingerprint -sha256 | awk -F= '{print $2}' | tr -d ':' | tr 'A-F' 'a-f')"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || exit 23

stored_fingerprint="$(openssl x509 -in "$cert_file" -noout -fingerprint -sha256 | awk -F= '{print $2}' | tr -d ':' | tr 'A-F' 'a-f')"
[[ "$stored_fingerprint" == "$fingerprint" ]] || exit 24

keystore_sha="$(sha256sum "$keystore" | awk '{print $1}')"

[[ -x "$backup" ]] || { echo "backup executable missing" >&2; exit 30; }
[[ -s "$backup_config" ]] || { echo "backup config missing" >&2; exit 31; }

backup_out="$("$backup" run)"
snapshot_id="$(printf '%s\n' "$backup_out" | awk -F= '$1=="SNAPSHOT_ID"{print $2}' | tail -n1)"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || { echo "snapshot id missing" >&2; exit 32; }

set -a
# shellcheck disable=SC1090
. "$backup_config"
set +a

listing="$(restic ls "$snapshot_id" --json)"
python3 - "$keystore" "$password_file" "$cert_file" <<'PY' <<<"$listing"
import json,sys
required=set(sys.argv[1:])
found=set()
for line in sys.stdin:
    try:
        obj=json.loads(line)
    except Exception:
        continue
    path=obj.get("path")
    if obj.get("struct_type")=="node" and path in required:
        found.add(path)
missing=required-found
if missing:
    raise SystemExit("signer files absent from snapshot: "+",".join(sorted(missing)))
PY

printf 'CF_PAA_SIGNER_LINE=line3\n'
printf 'CF_PAA_SIGNER_ALIAS=%s\n' "$alias_name"
printf 'CF_PAA_SIGNER_CERT_SHA256=%s\n' "$fingerprint"
printf 'CF_PAA_SIGNER_KEYSTORE_SHA256=%s\n' "$keystore_sha"
printf 'CF_PAA_SIGNER_BACKUP=pass\n'
printf 'CF_PAA_SIGNER_BACKUP_SNAPSHOT=%s\n' "$snapshot_id"
