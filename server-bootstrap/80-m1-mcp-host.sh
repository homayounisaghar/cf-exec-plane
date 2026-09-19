#!/usr/bin/env bash
set -euo pipefail

# M1: prepare the public MCP host surface on the personal VPS.
# Idempotent and fail-closed. Does not deploy application code; the MCP
# workload itself arrives through the signed release pull pipeline.

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

CF_MCP_HOST="cf-onshape.duckdns.org"
CF_MCP_UPSTREAM_PORT="8787"
scheme="https"
base="${scheme}://${CF_MCP_HOST}"

token_src="server-bootstrap/.m1-mcp-token"
secrets_dir="/etc/capability-fabric/secrets"
token_dst="${secrets_dir}/mcp-token"

# ---------------------------------------------------------------- token
[[ -f "$token_src" ]] || { echo "M1 token material missing from bundle" >&2; exit 20; }
token="$(tr -d '[:space:]' < "$token_src")"
[[ -n "$token" ]] || { echo "M1 token material is empty" >&2; exit 20; }
case "$token" in
  *[!A-Za-z0-9_-]*) echo "M1 token contains unsupported characters" >&2; exit 20 ;;
esac
(( ${#token} >= 32 )) || { echo "M1 token is shorter than policy minimum" >&2; exit 20; }

umask 077
install -d -m 0700 -o root -g root "$secrets_dir"
printf '%s\n' "$token" > "${token_dst}.new"
chown root:root "${token_dst}.new"
chmod 0600 "${token_dst}.new"
if [[ -f "$token_dst" ]] && cmp -s "${token_dst}.new" "$token_dst"; then
  rm -f "${token_dst}.new"
  token_state=already-current
else
  mv "${token_dst}.new" "$token_dst"
  token_state=installed
fi
token_mode="$(stat -c '%a %U:%G' "$token_dst")"
[[ "$token_mode" == "600 root:root" ]] || { echo "token permissions are not root-only" >&2; exit 20; }

# ------------------------------------------------------------- firewall
command -v ufw >/dev/null 2>&1 || { echo "ufw is unavailable; refusing" >&2; exit 21; }
[[ "$(ufw status | awk 'NR==1 {print $2}')" == "active" ]] || { echo "ufw is not active; refusing" >&2; exit 21; }
if ufw status | grep -Eq '(^|[[:space:]])443/tcp([[:space:]]|$)'; then
  firewall_state=already-present
else
  ufw allow 443/tcp
  firewall_state=added
fi
ufw status | grep -Eq '(^|[[:space:]])443/tcp([[:space:]]|$)' || { echo "443/tcp rule did not materialize" >&2; exit 21; }
if ufw status | grep -Eq '(^|[[:space:]])80/tcp([[:space:]]|$)'; then
  echo "80/tcp is open but M1 policy forbids it" >&2
  exit 21
fi

# ---------------------------------------------------------------- caddy
export DEBIAN_FRONTEND=noninteractive
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  if [[ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -1sLf "${scheme}://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  fi
  curl -1sLf "${scheme}://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
command -v caddy >/dev/null 2>&1 || { echo "caddy is unavailable after install attempt" >&2; exit 22; }

install -d -m 0755 /etc/caddy
cat > /etc/caddy/Caddyfile.new <<CFG
{
	auto_https disable_redirects
}

${CF_MCP_HOST} {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	handle /mcp/* {
		reverse_proxy 127.0.0.1:${CF_MCP_UPSTREAM_PORT}
	}
	handle / {
		respond "cf-mcp-host ok" 200
	}
	handle {
		respond 404
	}
}
CFG
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null
if [[ -f /etc/caddy/Caddyfile ]] && cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  rm -f /etc/caddy/Caddyfile.new
  caddy_state=already-current
else
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  caddy_state=updated
fi
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
[[ "$(systemctl is-enabled caddy 2>/dev/null)" == "enabled" ]] || { echo "caddy is not enabled at boot" >&2; exit 22; }

# --------------------------------------------------------------- verify
# Verification runs from the server itself: DNS, certificate and proxy are
# proven together over the public name.
tls_ok=no
for _ in $(seq 1 36); do
  body="$(curl -fsS --max-time 10 "${base}/" 2>/dev/null || true)"
  if [[ "$body" == "cf-mcp-host ok" ]]; then tls_ok=yes; break; fi
  sleep 5
done

cert_end="unknown"
if [[ "$tls_ok" == "yes" ]]; then
  cert_end="$(echo | openssl s_client -servername "$CF_MCP_HOST" -connect "${CF_MCP_HOST}:443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 | tr -d '\n')"
  [[ -n "$cert_end" ]] || cert_end="unknown"
fi

notfound_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${base}/definitely-not-a-route" 2>/dev/null || true)"

mcp_state=pending
if curl -fsS --max-time 5 "http://127.0.0.1:${CF_MCP_UPSTREAM_PORT}/" >/dev/null 2>&1; then
  mcp_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${base}/mcp/${token}" 2>/dev/null || true)"
  case "$mcp_code" in
    200|400|405|406) mcp_state=reachable ;;
    *) mcp_state="proxy-error-${mcp_code}" ;;
  esac
fi

printf 'CF_M1_REPORT_BEGIN\n'
printf 'CF_M1_TOKEN=%s\n' "$([[ "$token_state" == installed || "$token_state" == already-current ]] && printf pass || printf fail)"
printf 'CF_M1_TOKEN_STATE=%s\n' "$token_state"
printf 'CF_M1_TOKEN_PERMS=%s\n' "$([[ "$token_mode" == "600 root:root" ]] && printf pass || printf fail)"
printf 'CF_M1_FIREWALL=%s\n' pass
printf 'CF_M1_FIREWALL_STATE=%s\n' "$firewall_state"
printf 'CF_M1_CADDY_STATE=%s\n' "$caddy_state"
printf 'CF_M1_TLS=%s\n' "$([[ "$tls_ok" == yes ]] && printf pass || printf fail)"
printf 'CF_M1_CERT_NOT_AFTER=%s\n' "$cert_end"
printf 'CF_M1_CERT_RENEWAL=%s\n' "$([[ "$(systemctl is-enabled caddy 2>/dev/null)" == enabled ]] && printf pass || printf fail)"
printf 'CF_M1_HEALTH=%s\n' "$([[ "$tls_ok" == yes ]] && printf pass || printf fail)"
printf 'CF_M1_UNKNOWN_ROUTE_CODE=%s\n' "${notfound_code:-none}"
printf 'CF_M1_MCP_ENDPOINT=%s\n' "$mcp_state"
printf 'CF_M1_REPORT_END\n'

[[ "$tls_ok" == "yes" ]] || { echo "public HTTPS surface did not become healthy" >&2; exit 23; }
