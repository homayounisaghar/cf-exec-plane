#!/usr/bin/env bash
set -euo pipefail

emit_result() {
  printf 'CF_ONSHAPE_CREDENTIAL_RESULT=%s\n' "$1"
}

fail() {
  local code="$1"; shift
  emit_result FAILED
  printf '%s\n' "$*" >&2
  exit "$code"
}

[[ "$(id -u)" -eq 0 ]] || fail 1 "must run as uid 0"

account_src="server-bootstrap/.onshape-account"
password_src="server-bootstrap/.onshape-password"
overwrite_src="server-bootstrap/.onshape-overwrite"
secret_dir="/etc/capability-fabric/secrets/onshape"
account_dst="$secret_dir/account"
password_dst="$secret_dir/password"
account_new="$secret_dir/.account.new"
password_new="$secret_dir/.password.new"

[[ -f "$account_src" && -f "$password_src" && -f "$overwrite_src" ]] || fail 20 "Onshape credential material or overwrite flag missing from bundle"
overwrite="$(cat "$overwrite_src")"
[[ "$overwrite" == "0" || "$overwrite" == "1" ]] || fail 20 "invalid overwrite flag"

account_size="$(wc -c < "$account_src" | tr -d '[:space:]')"
password_size="$(wc -c < "$password_src" | tr -d '[:space:]')"
case "$account_size" in ''|*[!0-9]*) fail 20 "invalid account size" ;; esac
case "$password_size" in ''|*[!0-9]*) fail 20 "invalid password size" ;; esac
(( account_size >= 1 && account_size <= 320 )) || fail 20 "Onshape account length is outside policy"
(( password_size >= 8 && password_size <= 1024 )) || fail 20 "Onshape password length is outside policy"

account_clean_size="$(LC_ALL=C tr -d '\r\n' < "$account_src" | wc -c | tr -d '[:space:]')"
password_clean_size="$(LC_ALL=C tr -d '\r\n' < "$password_src" | wc -c | tr -d '[:space:]')"
[[ "$account_clean_size" == "$account_size" ]] || fail 20 "Onshape account contains a line break"
[[ "$password_clean_size" == "$password_size" ]] || fail 20 "Onshape password contains a line break"

umask 077
install -d -m 0700 -o root -g root "$secret_dir"
for f in "$account_dst" "$password_dst"; do
  if [[ ! -e "$f" ]]; then install -m 0600 -o root -g root /dev/null "$f"; fi
  [[ "$(stat -c '%a %U:%G' "$f")" == "600 root:root" ]] || fail 21 "Onshape destination permissions are unsafe"
done
[[ "$(stat -c '%a %U:%G' "$secret_dir")" == "700 root:root" ]] || fail 21 "Onshape credential directory permissions are unsafe"

account_existing="$(stat -c '%s' "$account_dst")"
password_existing="$(stat -c '%s' "$password_dst")"

if (( account_existing > 0 && password_existing > 0 )); then
  if cmp -s "$account_src" "$account_dst" && cmp -s "$password_src" "$password_dst"; then
    printf 'CF_ONSHAPE_CREDENTIAL_INSTALL=pass\n'
    printf 'CF_ONSHAPE_CREDENTIAL_DIR_PERMS=pass\n'
    printf 'CF_ONSHAPE_CREDENTIAL_FILE_PERMS=pass\n'
    printf 'CF_ONSHAPE_CREDENTIAL_STATE=PROVISIONED\n'
    emit_result UNCHANGED
    exit 0
  fi
  [[ "$overwrite" == "1" ]] || fail 22 "Onshape credentials differ from provisioned values; explicit overwrite flag required"
elif (( account_existing != 0 || password_existing != 0 )); then
  [[ "$overwrite" == "1" ]] || fail 22 "Onshape credential state is inconsistent; explicit overwrite flag required"
fi

cleanup_new() {
  rm -f "$account_new" "$password_new"
}
trap cleanup_new EXIT

install -m 0600 -o root -g root "$account_src" "$account_new"
install -m 0600 -o root -g root "$password_src" "$password_new"
cmp -s "$account_src" "$account_new" || fail 23 "Onshape account staging verification failed"
cmp -s "$password_src" "$password_new" || fail 23 "Onshape password staging verification failed"

mv "$account_new" "$account_dst"
mv "$password_new" "$password_dst"
trap - EXIT

[[ "$(stat -c '%a %U:%G' "$secret_dir")" == "700 root:root" ]] || fail 24 "Onshape credential directory permissions changed unexpectedly"
[[ "$(stat -c '%a %U:%G' "$account_dst")" == "600 root:root" ]] || fail 24 "Onshape account permissions changed unexpectedly"
[[ "$(stat -c '%a %U:%G' "$password_dst")" == "600 root:root" ]] || fail 24 "Onshape password permissions changed unexpectedly"
[[ "$(stat -c '%s' "$account_dst")" -gt 0 ]] || fail 24 "Onshape account is empty after install"
[[ "$(stat -c '%s' "$password_dst")" -gt 0 ]] || fail 24 "Onshape password is empty after install"

printf 'CF_ONSHAPE_CREDENTIAL_INSTALL=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_DIR_PERMS=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_FILE_PERMS=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_STATE=PROVISIONED\n'
emit_result CHANGED
