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

if '"notification.snooze"' not in block:
    admit='''        "notification.inventory.metadata",
    }'''
    repl='''        "notification.inventory.metadata",
        "notification.snooze",
    }'''
    if admit not in block:
        raise SystemExit("publisher snooze admitted-set baseline mismatch")
    block=block.replace(admit,repl,1)

if 'elif action == "notification.snooze":' not in block:
    needle='''    elif action == "notification.inventory.metadata":
        if set(p) != {"limit"}:
            fail("notification inventory parameters")
        limit=p["limit"]
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1 <= limit <= 20:
            fail("notification inventory limit")

    ttl=req["ttl_seconds"]'''
    repl='''    elif action == "notification.inventory.metadata":
        if set(p) != {"limit"}:
            fail("notification inventory parameters")
        limit=p["limit"]
        if not isinstance(limit,int) or isinstance(limit,bool) or not 1 <= limit <= 20:
            fail("notification inventory limit")
    elif action == "notification.snooze":
        if set(p) != {"notification_id","expected_content_hash","duration_ms"}:
            fail("notification snooze parameters")
        nid=p["notification_id"]
        h=p["expected_content_hash"]
        d=p["duration_ms"]
        if not isinstance(nid,str) or not __import__("re").fullmatch(r"[0-9a-f]{64}",nid):
            fail("notification snooze id")
        if not isinstance(h,str) or not __import__("re").fullmatch(r"[0-9a-f]{64}",h):
            fail("notification snooze hash")
        if not isinstance(d,int) or isinstance(d,bool) or d != 60000:
            fail("notification snooze duration")

    ttl=req["ttl_seconds"]'''
    if needle not in block:
        raise SystemExit("publisher snooze branch baseline mismatch")
    block=block.replace(needle,repl,1)

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
good={**base,"request_id":"paa-policy-snooze-positive-20260926-001","action":"notification.snooze","parameters":{"notification_id":"0"*64,"expected_content_hash":"1"*64,"duration_ms":60000}}
validate(good)
for req,needle in [
    ({**base,"request_id":"paa-policy-snooze-duration-negative-20260926-001","action":"notification.snooze","parameters":{"notification_id":"0"*64,"expected_content_hash":"1"*64,"duration_ms":120000}},"notification snooze duration"),
    ({**base,"request_id":"paa-policy-snooze-extra-negative-20260926-001","action":"notification.snooze","parameters":{"notification_id":"0"*64,"expected_content_hash":"1"*64,"duration_ms":60000,"force":True}},"notification snooze parameters"),
    ({**base,"request_id":"paa-policy-dismiss-still-negative-20260926-001","action":"notification.dismiss","parameters":{"notification_id":"0"*64,"expected_content_hash":"1"*64}},"action not admitted"),
]:
    try:
        validate(req)
        raise SystemExit("negative snooze policy test unexpectedly admitted")
    except ValueError as e:
        if needle not in str(e): raise
PY

install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

good='{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-snooze-runtime-positive-20260926-001","action":"notification.snooze","parameters":{"notification_id":"0000000000000000000000000000000000000000000000000000000000000000","expected_content_hash":"1111111111111111111111111111111111111111111111111111111111111111","duration_ms":60000},"ttl_seconds":300}'
bad='{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-dismiss-runtime-negative-20260926-001","action":"notification.dismiss","parameters":{"notification_id":"0000000000000000000000000000000000000000000000000000000000000000","expected_content_hash":"1111111111111111111111111111111111111111111111111111111111111111"},"ttl_seconds":300}'
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    pos="$(printf '%s' "$good" | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    neg="$(printf '%s' "$bad" | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ "$pos" == *'"ok":true'* && "$neg" == *'action not admitted'* ]]; then break; fi
  fi
  sleep 1
done

[[ "$pos" == *'"ok":true'* ]]
[[ "$neg" == *'action not admitted'* ]]
if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

printf 'CF_PAA_NOTIFICATION_SNOOZE_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'STATIC_SNOOZE_POSITIVE=PASS\n'
printf 'STATIC_SNOOZE_DURATION_NEGATIVE=PASS\n'
printf 'STATIC_SNOOZE_EXTRA_PARAM_NEGATIVE=PASS\n'
printf 'STATIC_DISMISS_REMOTE_NEGATIVE=PASS\n'
printf 'RUNTIME_SNOOZE_POSITIVE=PASS\n'
printf 'RUNTIME_DISMISS_REMOTE_NEGATIVE=PASS\n'
printf 'ADMITTED_NEW=notification.snooze(notification_id:hex64,expected_content_hash:hex64,duration_ms:60000)\n'
printf 'CF_PAA_NOTIFICATION_SNOOZE_POLICY_END\n'
