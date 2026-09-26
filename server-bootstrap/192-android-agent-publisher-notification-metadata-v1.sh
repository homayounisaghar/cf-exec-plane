#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || exit 10
publisher=/usr/local/libexec/paa-envelope-publisher.py
remote_user=paa_remote
producer_key=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
binding=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json

[[ -f "$publisher" && "$(stat -c '%U:%G:%a' "$publisher")" == "root:root:750" ]] || exit 11

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.pyc"' EXIT

python3 - "$publisher" "$tmp" <<'PY'
import sys
src,dst=sys.argv[1:]
text=open(src,encoding="utf-8").read()
start=text.index("def validate(req):")
end=text.index("\ndef load_keys():", start)
block=text[start:end]

if '"notification.inventory.metadata"' in block:
    open(dst,"w",encoding="utf-8").write(text)
    raise SystemExit(0)

admit_old='''        "notification.control.selftest",
    }'''
admit_new='''        "notification.control.selftest",
        "notification.inventory.metadata",
    }'''
if admit_old not in block:
    raise SystemExit("publisher metadata inventory admitted-set baseline mismatch")
block=block.replace(admit_old,admit_new,1)

branch='''    elif action == "notification.control.selftest":
        if set(p):
            fail("notification selftest parameters")

    ttl=req["ttl_seconds"]'''
replacement='''    elif action == "notification.control.selftest":
        if set(p):
            fail("notification selftest parameters")
    elif action == "notification.inventory.metadata":
        if set(p) != {"limit"}:
            fail("notification inventory parameters")
        limit=p["limit"]
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1 <= limit <= 20:
            fail("notification inventory limit")

    ttl=req["ttl_seconds"]'''
if branch not in block:
    raise SystemExit("publisher metadata inventory branch baseline mismatch")
block=block.replace(branch,replacement,1)
open(dst,"w",encoding="utf-8").write(text[:start]+block+text[end:])
PY

python3 -m py_compile "$tmp"

python3 - "$tmp" <<'PY'
import re,sys
text=open(sys.argv[1],encoding="utf-8").read()
start=text.index("def validate(req):")
end=text.index("\ndef load_keys():", start)
ns={"re":re}
def fail(msg): raise ValueError(msg)
ns["fail"]=fail
exec(text[start:end],ns)
validate=ns["validate"]
base={"schema":"personal-android-agent.remote-request.v1","ttl_seconds":300}

validate({**base,
    "request_id":"paa-policy-notification-metadata-positive-20260926-001",
    "action":"notification.inventory.metadata",
    "parameters":{"limit":20}})

for req,needle in [
    ({**base,"request_id":"paa-policy-notification-metadata-limit-negative-20260926-001",
      "action":"notification.inventory.metadata","parameters":{"limit":21}},
     "notification inventory limit"),
    ({**base,"request_id":"paa-policy-notification-metadata-content-negative-20260926-001",
      "action":"notification.inventory.metadata","parameters":{"limit":20,"include_content":True}},
     "notification inventory parameters"),
    ({**base,"request_id":"paa-policy-notification-list-remote-negative-20260926-001",
      "action":"notification.list","parameters":{"limit":20,"active_only":True,"include_content":False}},
     "action not admitted"),
    ({**base,"request_id":"paa-policy-n2-dismiss-negative-20260926-002",
      "action":"notification.dismiss","parameters":{"notification_id":"0"*64,"expected_content_hash":"0"*64}},
     "action not admitted"),
    ({**base,"request_id":"paa-policy-n2-snooze-negative-20260926-002",
      "action":"notification.snooze","parameters":{"notification_id":"0"*64,"expected_content_hash":"0"*64,"duration_ms":60000}},
     "action not admitted"),
]:
    try:
        validate(req)
        raise SystemExit("negative metadata-inventory policy test unexpectedly admitted")
    except ValueError as e:
        if needle not in str(e):
            raise
PY

install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

bad_limit=""
bad_content=""
bad_list=""
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    bad_limit="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-notification-metadata-runtime-limit-negative-20260926-001","action":"notification.inventory.metadata","parameters":{"limit":21},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    bad_content="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-notification-metadata-runtime-content-negative-20260926-001","action":"notification.inventory.metadata","parameters":{"limit":20,"include_content":true},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    bad_list="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-notification-list-runtime-negative-20260926-001","action":"notification.list","parameters":{"limit":20,"active_only":true,"include_content":false},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ "$bad_limit" == *"notification inventory limit"* \
       && "$bad_content" == *"notification inventory parameters"* \
       && "$bad_list" == *"action not admitted"* ]]; then
      break
    fi
  fi
  sleep 1
done

systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ "$bad_limit" == *"notification inventory limit"* ]]
[[ "$bad_content" == *"notification inventory parameters"* ]]
[[ "$bad_list" == *"action not admitted"* ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

printf 'CF_PAA_NOTIFICATION_METADATA_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'STATIC_METADATA_POSITIVE=PASS\n'
printf 'STATIC_LIMIT_NEGATIVE=PASS\n'
printf 'STATIC_CONTENT_PARAM_NEGATIVE=PASS\n'
printf 'STATIC_NOTIFICATION_LIST_REMOTE_NEGATIVE=PASS\n'
printf 'STATIC_DISMISS_REMOTE_NEGATIVE=PASS\n'
printf 'STATIC_SNOOZE_REMOTE_NEGATIVE=PASS\n'
printf 'RUNTIME_LIMIT_NEGATIVE=PASS\n'
printf 'RUNTIME_CONTENT_PARAM_NEGATIVE=PASS\n'
printf 'RUNTIME_NOTIFICATION_LIST_REMOTE_NEGATIVE=PASS\n'
printf 'ADMITTED_NEW=notification.inventory.metadata(limit:1..20,active-only,content-excluded)\n'
printf 'CF_PAA_NOTIFICATION_METADATA_POLICY_END\n'
