#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -un)" == "cfserver" ]] || { echo WRONG_OWNER; exit 2; }
export XDG_RUNTIME_DIR=/run/user/1000
SRC=/tmp/dexa-lite-pilot-20261103
TARGET=/home/cfserver/.local/share/dexa-lite-20261103
UNITS=/home/cfserver/.config/systemd/user
test -d "$SRC"
test -f /home/cfserver/.local/share/dexa-mobile-gateway-20261023/credentials.json
test -f /var/lib/capability-fabric/paa-remote/dexa-mvp/index.html
[[ "$(sha256sum /var/lib/capability-fabric/paa-remote/dexa-mvp/index.html | cut -d' ' -f1)" == "e765a4bffac6eda525d2b06bbe19cba0426ed837bb9b02c2894264677bdc859c" ]] || { echo CORE_HTML_CHANGED; exit 3; }
cd "$SRC"
printf '%s  %s\n' \
 'f672e0ad4e7b109f0b3d03cfc9ba762efc990b5fa55448de42a5d82592fb2e3c' lite-gateway.mjs \
 '1e4b4777b63b4bcf3812760a4ee3475ea73dfd601276b2cbcfeda752502179de' lite.css \
 '166a0c50ff7bcd4bdb4e0859e8fe0513a926f382c85ec1a08bc56fe0994d7070' ensure_lite_route.py | sha256sum -c -
node --check lite-gateway.mjs
python3 -m py_compile ensure_lite_route.py
python3 ensure_lite_route.py --check
systemctl --user is-active --quiet dexa-main.service
systemctl --user is-active --quiet dexa-mobile-gateway.service
[[ ! -L "$TARGET" ]] || { echo TARGET_SYMLINK_NOT_ALLOWED; exit 2; }
mkdir -p -m 700 "$TARGET" "$UNITS"
for f in lite-gateway.mjs lite.css ensure_lite_route.py; do
  if [[ -e "$TARGET/$f" ]] && ! cmp -s "$f" "$TARGET/$f"; then
    echo "EXISTING_PILOT_FILE_DIFFERS: $f"; exit 4
  fi
done
install -m 600 lite-gateway.mjs lite.css ensure_lite_route.py "$TARGET/"
cat > "$UNITS/dexa-lite.service" <<'UNIT'
[Unit]
Description=Dexa Lite isolated mobile presentation gateway
After=network-online.target dexa-main.service
[Service]
Type=simple
WorkingDirectory=/home/cfserver/.local/share/dexa-lite-20261103
ExecStart=/usr/bin/node /home/cfserver/.local/share/dexa-lite-20261103/lite-gateway.mjs
Restart=on-failure
RestartSec=4
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=default.target
UNIT
cat > "$UNITS/dexa-lite-route-keeper.service" <<'UNIT'
[Unit]
Description=Keep the scoped Dexa Lite Caddy route after config reloads
After=network-online.target dexa-lite.service
[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/cfserver/.local/share/dexa-lite-20261103/ensure_lite_route.py --watch
Restart=on-failure
RestartSec=6
NoNewPrivileges=true
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now dexa-lite.service
for attempt in $(seq 1 20); do
  status="$(curl --silent --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9518/_local-health || true)"
  [[ "$status" == "200" ]] && break
  sleep 0.4
done
[[ "$status" == "200" ]] || { echo LITE_LOCAL_SERVICE_FAILED; exit 5; }
python3 "$TARGET/ensure_lite_route.py"
systemctl --user enable --now dexa-lite-route-keeper.service
for attempt in $(seq 1 10); do
  public="$(curl --silent --max-time 5 -o /dev/null -w '%{http_code}' https://cf-onshape.duckdns.org/dexa-lite/check || true)"
  [[ "$public" == "200" ]] && break
  sleep 0.5
done
[[ "$public" == "200" ]] || { echo LITE_HTTPS_CHECK_FAILED; exit 6; }
auth="$(curl --silent --max-time 5 -o /dev/null -w '%{http_code}' https://cf-onshape.duckdns.org/dexa-lite/ || true)"
main="$(curl --silent --max-time 5 -o /dev/null -w '%{http_code}' https://cf-onshape.duckdns.org/dexa-mobile/ || true)"
core="$(curl --silent --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:9471/healthz || true)"
[[ "$auth" == "401" && "$main" == "401" && "$core" == "200" ]] || { echo SECURITY_OR_EXISTING_SERVICE_REGRESSION; exit 7; }
systemctl --user is-active --quiet dexa-main.service
systemctl --user is-active --quiet dexa-mobile-gateway.service
systemctl --user is-active --quiet dexa-lite.service
systemctl --user is-active --quiet dexa-lite-route-keeper.service
echo "DEXA_LITE_PUBLIC_PILOT_VERIFIED check_200=yes lite_auth_401=yes existing_auth_401=yes core_health_200=yes main_untouched=yes"
