#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 1

remote_user=paa_remote
home=/var/lib/capability-fabric/paa-remote
config="$home/.desktop-commander-device/device.json"
service=capability-fabric-paa-remote.service

printf 'CF_PAA_RDC_DIAG_BEGIN\n'
printf 'SERVICE_ACTIVE=%s\n' "$(systemctl is-active "$service" || true)"
printf 'SERVICE_ENABLED=%s\n' "$(systemctl is-enabled "$service" 2>/dev/null || true)"
printf 'SERVICE_MAIN_PID=%s\n' "$(systemctl show "$service" -p MainPID --value)"
printf 'SERVICE_NRESTARTS=%s\n' "$(systemctl show "$service" -p NRestarts --value)"
printf 'SERVICE_STARTED_AT=%s\n' "$(systemctl show "$service" -p ExecMainStartTimestamp --value | tr ' ' '_')"

if [[ -s "$config" ]]; then
  printf 'CONFIG_PRESENT=yes\n'
  printf 'CONFIG_OWNER_MODE=%s\n' "$(stat -c '%U:%G:%a' "$config")"
else
  printf 'CONFIG_PRESENT=no\n'
fi

if [[ -s "$config" ]]; then
python3 - "$config" <<'PY'
import base64, hashlib, json, sys
p=sys.argv[1]
cfg=json.load(open(p))
device_id=cfg.get("deviceId")
session=cfg.get("session") or {}
token=session.get("access_token") or ""
sub=""
email=""
if token.count(".")>=2:
    part=token.split(".")[1]
    part += "="*((4-len(part)%4)%4)
    try:
        claims=json.loads(base64.urlsafe_b64decode(part.encode()))
        sub=str(claims.get("sub") or "")
        email=str(claims.get("email") or "")
    except Exception:
        pass
print("DEVICE_ID="+str(device_id or ""))
print("SESSION_SUB="+sub)
print("SESSION_EMAIL_SHA256="+(hashlib.sha256(email.lower().encode()).hexdigest() if email else ""))
print("SESSION_HAS_REFRESH_TOKEN="+("yes" if session.get("refresh_token") else "no"))
PY
fi

tmp_info="$(mktemp)"
tmp_rows="$(mktemp)"
trap 'rm -f "$tmp_info" "$tmp_rows"' EXIT
if [[ -s "$config" ]]; then
curl --fail --silent --show-error --max-time 15 https://mcp.desktopcommander.app/api/mcp-info > "$tmp_info"

python3 - "$config" "$tmp_info" > /tmp/paa-rdc-query.env <<'PY'
import json,shlex,sys
cfg=json.load(open(sys.argv[1]))
info=json.load(open(sys.argv[2]))
print("SUPABASE_URL="+shlex.quote(str(info.get("supabaseUrl") or "")))
print("SUPABASE_KEY="+shlex.quote(str(info.get("supabasePublishableKey") or "")))
print("ACCESS_TOKEN="+shlex.quote(str((cfg.get("session") or {}).get("access_token") or "")))
print("DEVICE_ID="+shlex.quote(str(cfg.get("deviceId") or "")))
PY
chmod 600 /tmp/paa-rdc-query.env
set -a
. /tmp/paa-rdc-query.env
set +a
rm -f /tmp/paa-rdc-query.env

[[ -n "$SUPABASE_URL" && -n "$SUPABASE_KEY" && -n "$ACCESS_TOKEN" && -n "$DEVICE_ID" ]] || exit 20
curl --fail --silent --show-error --max-time 15   -H "apikey: $SUPABASE_KEY"   -H "Authorization: Bearer $ACCESS_TOKEN"   -H "Accept: application/json"   "$SUPABASE_URL/rest/v1/mcp_devices?id=eq.$DEVICE_ID&select=id,user_id,status,last_seen,device_name,capabilities"   > "$tmp_rows"

python3 - "$tmp_rows" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
print("BACKEND_DEVICE_ROWS="+str(len(rows)))
if rows:
    row=rows[0]
    print("BACKEND_DEVICE_USER_ID="+str(row.get("user_id") or ""))
    print("BACKEND_DEVICE_STATUS="+str(row.get("status") or ""))
    print("BACKEND_DEVICE_NAME="+str(row.get("device_name") or ""))
    caps=row.get("capabilities") or {}
    if isinstance(caps,dict):
        print("BACKEND_TRANSPORT_BROADCAST_V1="+str(bool(caps.get("transport_broadcast_v1"))).lower())
PY
fi

journal="$(journalctl -u "$service" --since '-30 minutes' --no-pager -o cat 2>/dev/null || true)"
python3 - <<'PY' <<<"$journal"
import re,sys
lines=sys.stdin.read().splitlines()
url=None
code=None
for i,line in enumerate(lines):
    s=line.strip()
    m=re.fullmatch(r"https://mcp\.desktopcommander\.app/device/verify\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})",s)
    if m:
        url=s
        code=m.group(1)
    elif s in {"2. Make sure the code matches:","2. Enter this code when prompted:"} and i+1<len(lines):
        m2=re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}",lines[i+1].strip())
        if m2:
            code=m2.group(0)
print("CURRENT_PAIRING_CODE="+(code or ""))
PY
for marker in   'Device verified'   'Device ID assigned'   'Session restored'   'Device ready'   'Device registered, but NOT reachable'   'Channel subscribed'   'Realtime channel is not open'   'Device not found'   'Persisted device'   'Remote session expired' \
  'Failed to save config' \
  'Authorization failed' \
  'authorization timeout' \
  'Persisted session invalid' \
  'Device code received'; do
  key="$(printf '%s' "$marker" | tr '[:lower:] ' '[:upper:]_' | tr -cd 'A-Z0-9_')"
  if grep -Fq "$marker" <<<"$journal"; then
    printf 'JOURNAL_%s=yes\n' "$key"
  else
    printf 'JOURNAL_%s=no\n' "$key"
  fi
done

printf 'CF_PAA_RDC_DIAG_END\n'
