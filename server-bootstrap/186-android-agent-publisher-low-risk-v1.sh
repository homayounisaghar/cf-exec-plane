#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "root required" >&2; exit 10; }

publisher=/usr/local/libexec/paa-envelope-publisher.py
remote_user=paa_remote
producer_key=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
binding=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json

[[ -f "$publisher" && "$(stat -c '%U:%G:%a' "$publisher")" == "root:root:750" ]] || exit 11
id "$remote_user" >/dev/null 2>&1 || exit 12
[[ -f "$producer_key" && -f "$binding" ]] || exit 13

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.pyc"' EXIT

python3 - "$publisher" "$tmp" <<'PY'
import sys
src,dst=sys.argv[1:]
text=open(src,encoding="utf-8").read()
start=text.index("def validate(req):")
end=text.index("\ndef load_keys():", start)
old=text[start:end]
already_extended = (
    '"system.health"' in old
    and '"capability.inventory"' in old
    and '"device.state.get"' in old
    and '"artifact.fetch_verify_cache"' in old
    and '"volume.get_set"' in old
    and 'volume mutation not admitted' in old
)
if 'req["action"] != "notification.post"' not in old and not already_extended:
    raise SystemExit("unexpected publisher validate baseline")
new=r'''def validate(req):
    if not isinstance(req, dict):
        fail("request must be object")
    if set(req) != {"schema","request_id","action","parameters","ttl_seconds"}:
        fail("request fields")
    if req["schema"] != "personal-android-agent.remote-request.v1":
        fail("request schema")
    rid=req["request_id"]
    if not isinstance(rid,str) or not re.fullmatch(r"[A-Za-z0-9_.-]{8,96}",rid):
        fail("request_id")

    action=req["action"]
    admitted={
        "notification.post",
        "system.health",
        "capability.inventory",
        "device.state.get",
        "artifact.fetch_verify_cache",
        "volume.get_set",
    }
    if action not in admitted:
        fail("action not admitted by restricted publisher")

    p=req["parameters"]
    if not isinstance(p,dict):
        fail("parameters")

    if action == "notification.post":
        if set(p) != {"title","text"}:
            fail("notification parameters")
        title,text=p["title"],p["text"]
        if not isinstance(title,str) or not 1 <= len(title) <= 120 or any(c in title for c in "\r\n\0"):
            fail("notification title")
        if not isinstance(text,str) or not 1 <= len(text) <= 500 or "\0" in text:
            fail("notification text")
    elif action in {"system.health","capability.inventory","device.state.get"}:
        if p:
            fail("read-only parameters")
    elif action == "artifact.fetch_verify_cache":
        if set(p) != {"url","sha256","mime","max_bytes"}:
            fail("artifact parameters")
        url=p["url"]
        digest=p["sha256"]
        mime=p["mime"]
        max_bytes=p["max_bytes"]
        if not isinstance(url,str) or not url.startswith("https://") or len(url) > 2048 or any(c in url for c in "\r\n\0"):
            fail("artifact url")
        if not isinstance(digest,str) or not re.fullmatch(r"[0-9a-f]{64}",digest):
            fail("artifact sha256")
        if not isinstance(mime,str) or not 1 <= len(mime) <= 160 or any(c in mime for c in "\r\n\0"):
            fail("artifact mime")
        if not isinstance(max_bytes,int) or isinstance(max_bytes,bool) or not 1 <= max_bytes <= 1048576:
            fail("artifact max_bytes")
    elif action == "volume.get_set":
        if set(p) != {"stream","operation"}:
            fail("volume read parameters")
        if p["operation"] != "get":
            fail("volume mutation not admitted")
        if p["stream"] not in {"music","alarm","ring","notification"}:
            fail("volume stream")

    ttl=req["ttl_seconds"]
    if not isinstance(ttl,int) or isinstance(ttl,bool) or ttl < 30 or ttl > 3600:
        fail("ttl_seconds")
    return rid
'''
if already_extended:
    open(dst,"w",encoding="utf-8").write(text)
else:
    open(dst,"w",encoding="utf-8").write(text[:start]+new+text[end:])
PY

python3 -m py_compile "$tmp"
install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    probe="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-system-health-selftest-20260926-001","action":"system.health","parameters":{},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ -n "$probe" ]]; then
      break
    fi
  fi
  sleep 1
done
systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ -S /run/capability-fabric/paa-publisher.sock ]]
[[ -n "${probe:-}" ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then
  echo "restricted user can read producer key" >&2
  exit 20
fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then
  echo "restricted user can read binding" >&2
  exit 21
fi

positive="$probe"
negative="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-volume-set-negative-20260926-001","action":"volume.get_set","parameters":{"stream":"music","operation":"set","percent":50},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope)"

POSITIVE="$positive" NEGATIVE="$negative" python3 - <<'PY'
import json,os
p=json.loads(os.environ["POSITIVE"])
n=json.loads(os.environ["NEGATIVE"])
assert p.get("ok") is True and p.get("request_id")=="paa-policy-system-health-selftest-20260926-001"
assert n.get("ok") is False and "mutation not admitted" in n.get("error","")
PY

printf 'CF_PAA_PUBLISHER_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'SYSTEM_HEALTH_ENVELOPE_SELFTEST=PASS\n'
printf 'VOLUME_SET_NEGATIVE_SELFTEST=PASS\n'
printf 'ADMITTED=notification.post,system.health,capability.inventory,device.state.get,artifact.fetch_verify_cache,volume.get_only\n'
printf 'CF_PAA_PUBLISHER_POLICY_END\n'
