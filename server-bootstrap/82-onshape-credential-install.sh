#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

account_src="server-bootstrap/.onshape-account"
password_src="server-bootstrap/.onshape-password"
secret_dir="/etc/capability-fabric/secrets/onshape"
account_dst="$secret_dir/account"
password_dst="$secret_dir/password"
account_new="$secret_dir/.account.new"
password_new="$secret_dir/.password.new"

[[ -f "$account_src" && -f "$password_src" ]] || { echo "Onshape credential material missing from bundle" >&2; exit 20; }

account_size="$(wc -c < "$account_src" | tr -d '[:space:]')"
password_size="$(wc -c < "$password_src" | tr -d '[:space:]')"
case "$account_size" in ''|*[!0-9]*) exit 20 ;; esac
case "$password_size" in ''|*[!0-9]*) exit 20 ;; esac
(( account_size >= 1 && account_size <= 320 )) || { echo "Onshape account length is outside policy" >&2; exit 20; }
(( password_size >= 8 && password_size <= 1024 )) || { echo "Onshape password length is outside policy" >&2; exit 20; }

if LC_ALL=C grep -q $'\r' "$account_src" || LC_ALL=C grep -q $'\n' "$account_src"; then
  echo "Onshape account contains a line break" >&2
  exit 20
fi
if LC_ALL=C grep -q $'\r' "$password_src" || LC_ALL=C grep -q $'\n' "$password_src"; then
  echo "Onshape password contains a line break" >&2
  exit 20
fi

umask 077
install -d -m 0700 -o root -g root "$secret_dir"
for f in "$account_dst" "$password_dst"; do
  if [[ ! -e "$f" ]]; then install -m 0600 -o root -g root /dev/null "$f"; fi
  [[ "$(stat -c '%a %U:%G' "$f")" == "600 root:root" ]] || { echo "Onshape destination permissions are unsafe" >&2; exit 21; }
done

account_existing="$(stat -c '%s' "$account_dst")"
password_existing="$(stat -c '%s' "$password_dst")"
if (( account_existing != 0 || password_existing != 0 )); then
  if (( account_existing > 0 && password_existing > 0 )); then
    echo "Onshape credentials are already provisioned; refusing overwrite" >&2
  else
    echo "Onshape credential state is inconsistent; refusing write" >&2
  fi
  exit 22
fi

cleanup_new() {
  rm -f "$account_new" "$password_new"
}
trap cleanup_new EXIT

install -m 0600 -o root -g root "$account_src" "$account_new"
install -m 0600 -o root -g root "$password_src" "$password_new"
cmp -s "$account_src" "$account_new"
cmp -s "$password_src" "$password_new"

mv "$account_new" "$account_dst"
mv "$password_new" "$password_dst"
trap - EXIT

[[ "$(stat -c '%a %U:%G' "$secret_dir")" == "700 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$account_dst")" == "600 root:root" ]]
[[ "$(stat -c '%a %U:%G' "$password_dst")" == "600 root:root" ]]
[[ "$(stat -c '%s' "$account_dst")" -gt 0 ]]
[[ "$(stat -c '%s' "$password_dst")" -gt 0 ]]

printf 'CF_ONSHAPE_CREDENTIAL_INSTALL=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_DIR_PERMS=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_FILE_PERMS=pass\n'
printf 'CF_ONSHAPE_CREDENTIAL_STATE=PROVISIONED\n'
