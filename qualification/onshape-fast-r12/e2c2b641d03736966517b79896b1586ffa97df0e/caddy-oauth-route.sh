#!/usr/bin/env bash
set -euo pipefail

# Only modifies OAuth routing for the existing CF-server host.
action=""; file="/etc/caddy/Caddyfile"; target=""
if [[ $# -gt 0 ]]; then action="$1"; fi
if [[ $# -gt 1 ]]; then file="$2"; fi
if [[ $# -gt 2 ]]; then target="$3"; fi
if [[ "$action" != preview && "$action" != install ]]; then echo "USAGE: caddy-oauth-route.sh preview input output | install [input]" >&2; exit 2; fi
[[ -f "$file" ]] || { echo "CADDY_INPUT_MISSING" >&2; exit 3; }
if [[ "$action" == preview ]]; then
  [[ -n "$target" ]] || exit 4
else
  [[ "$(id -u)" == 0 ]] || { echo "CADDY_INSTALL_REQUIRES_ROOT" >&2; exit 5; }
  command -v caddy >/dev/null
  command -v systemctl >/dev/null
  target="$(mktemp "$file.oauth.XXXXXX")"
  trap 'rm -f "$target"' EXIT
fi

python3 - "$file" "$target" <<'PY'
import pathlib,sys
src=pathlib.Path(sys.argv[1]).read_text()
marker="\thandle /mcp/* {"
if src.count(marker)!=1 or src.count("cf-onshape.duckdns.org {")!=1:
    raise SystemExit("CADDY_SITE_OR_GATEWAY_MARKER_MISSING")
if "\t\treverse_proxy 127.0.0.1:8787" not in src:
    raise SystemExit("CADDY_GATEWAY_UPSTREAM_UNEXPECTED")
prefix=src.split(marker,1)[0]
if "cf-onshape.duckdns.org {" not in prefix:
    raise SystemExit("CADDY_MCP_ROUTE_OUTSIDE_CF_SITE")
routes=(
    "\thandle /.well-known/oauth-authorization-server {\n"
    "\t\treverse_proxy 127.0.0.1:8787\n"
    "\t}\n"
    "\thandle /.well-known/oauth-protected-resource* {\n"
    "\t\treverse_proxy 127.0.0.1:8787\n"
    "\t}\n"
)
a="\thandle /.well-known/oauth-authorization-server {"
b="\thandle /.well-known/oauth-protected-resource* {"
if (a in src) != (b in src):
    raise SystemExit("CADDY_PARTIAL_OAUTH_ROUTE_REFUSED")
if a in src:
    if src.count(a)!=1 or src.count(b)!=1:raise SystemExit("CADDY_OAUTH_ROUTE_DUPLICATED")
    updated=src
else:
    updated=src.replace(marker,routes+marker,1)
pathlib.Path(sys.argv[2]).write_text(updated)
PY

if [[ "$action" == preview ]]; then
  echo "CF_OAUTH_CADDY_PREVIEW=ready"
  exit 0
fi

chown --reference="$file" "$target"
chmod --reference="$file" "$target"
caddy validate --adapter caddyfile --config "$target" >/dev/null
if cmp -s "$file" "$target"; then
  echo "CF_OAUTH_CADDY=already-installed"
  exit 0
fi

backup="$file.pre-cf-oauth-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$file" "$backup"
mv -f "$target" "$file"
if ! systemctl reload caddy; then
  cp -a "$backup" "$file"
  systemctl reload caddy || true
  echo "CF_OAUTH_CADDY_RELOAD_ROLLED_BACK" >&2
  exit 10
fi
if ! curl --silent --show-error --fail --max-time 12 --resolve cf-onshape.duckdns.org:443:127.0.0.1 \
  https://cf-onshape.duckdns.org/.well-known/oauth-authorization-server | grep -Fq '"issuer":"https://cf-onshape.duckdns.org"'; then
  cp -a "$backup" "$file"
  systemctl reload caddy || true
  echo "CF_OAUTH_CADDY_DISCOVERY_ROLLED_BACK" >&2
  exit 11
fi
echo "CF_OAUTH_CADDY=installed-and-probed"
