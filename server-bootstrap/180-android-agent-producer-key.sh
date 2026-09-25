#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

secret_dir=/etc/capability-fabric/secrets/android-agent
trust_dir=/etc/capability-fabric/trust/android-agent
private_key="$secret_dir/producer-p256-v1.pem"
public_key="$trust_dir/producer-p256-v1.pub.pem"
key_id=personal-android-agent-producer-v1

command -v openssl >/dev/null 2>&1 || { echo "openssl missing" >&2; exit 2; }
install -d -m 0700 -o root -g root "$secret_dir"
install -d -m 0755 -o root -g root "$trust_dir"

if [[ ! -s "$private_key" ]]; then
  tmp="$(mktemp "$secret_dir/.producer.XXXXXX")"
  trap 'rm -f "${tmp:-}"' EXIT
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$tmp"
  chown root:root "$tmp"
  chmod 0600 "$tmp"
  openssl pkey -in "$tmp" -check -noout >/dev/null
  mv -f "$tmp" "$private_key"
  trap - EXIT
fi

[[ "$(stat -c '%U:%G:%a' "$private_key")" == root:root:600 ]] || {
  echo "producer private key permissions unsafe" >&2
  exit 3
}
openssl pkey -in "$private_key" -check -noout >/dev/null

pub_tmp="$(mktemp "$trust_dir/.producer-pub.XXXXXX")"
trap 'rm -f "$pub_tmp" /tmp/paa-producer-spki.der' EXIT
openssl pkey -in "$private_key" -pubout -out "$pub_tmp"
chown root:root "$pub_tmp"
chmod 0644 "$pub_tmp"
mv -f "$pub_tmp" "$public_key"

openssl pkey -pubin -in "$public_key" -text_pub -noout | grep -Eq 'ASN1 OID: (prime256v1|secp256r1)'
openssl pkey -pubin -in "$public_key" -outform DER -out /tmp/paa-producer-spki.der

fingerprint="$(sha256sum /tmp/paa-producer-spki.der | awk '{print $1}')"
spki_b64="$(base64 -w 0 /tmp/paa-producer-spki.der)"

[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]]
[[ -n "$spki_b64" ]]

# Producer private key is intentionally inside /etc/capability-fabric and not
# in the explicit backup exclusion set, so the existing encrypted restic job
# captures it. Verify that the parent path itself is not excluded.
exclude=/etc/capability-fabric/backup.exclude
[[ -f "$exclude" ]] || { echo "backup exclusion file missing" >&2; exit 4; }
if grep -Fxq "$secret_dir" "$exclude" || grep -Fxq /etc/capability-fabric "$exclude"; then
  echo "producer secret path unexpectedly excluded from backup" >&2
  exit 5
fi

printf 'CF_PAA_PRODUCER_KEY_ID=%s\n' "$key_id"
printf 'CF_PAA_PRODUCER_SHA256=%s\n' "$fingerprint"
printf 'CF_PAA_PRODUCER_SPKI_B64=%s\n' "$spki_b64"
printf 'CF_PAA_PRODUCER_PRIVATE_PERMS=pass\n'
printf 'CF_PAA_PRODUCER_BACKUP_SCOPE=pass\n'
