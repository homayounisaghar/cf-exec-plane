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

if '"notification.control.selftest"' in block:
    open(dst,"w",encoding="utf-8").write(text)
    raise SystemExit(0)

admit_old='''        "notification.inbox.status",
    }'''
admit_new='''        "notification.inbox.status",
        "notification.control.selftest",
    }'''
if admit_old not in block:
    raise SystemExit("publisher N2 admitted-set baseline mismatch")
block=block.replace(admit_old,admit_new,1)

branch='''    elif action in {"notification.access.status","notification.inbox.status"}:
        if set(p):
            fail("notification status parameters")

    ttl=req["ttl_seconds"]'''
replacement='''    elif action in {"notification.access.status","notification.inbox.status"}:
        if set(p):
            fail("notification status parameters")
    elif action == "notification.control.selftest":
        if set(p):
            fail("notification selftest parameters")

    ttl=req["ttl_seconds"]'''
if branch not in block:
    raise SystemExit("publisher N2 branch baseline mismatch")
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
validate({**base,"request_id":"paa-policy-n2-selftest-positive-20260926-001","action":"notification.control.selftest","parameters":{}})
for req,needle in [
    ({**base,"request_id":"paa-policy-n2-selftest-param-negative-20260926-001","action":"notification.control.selftest","parameters":{"x":1}},"notification selftest parameters"),
    ({**base,"request_id":"paa-policy-n2-dismiss-negative-20260926-001","action":"notification.dismiss","parameters":{"notification_id":"0"*64,"expected_content_hash":"0"*64}},"action not admitted"),
    ({**base,"request_id":"paa-policy-n2-snooze-negative-20260926-001","action":"notification.snooze","parameters":{"notification_id":"0"*64,"expected_content_hash":"0"*64,"duration_ms":60000}},"action not admitted"),
]:
    try:
        validate(req)
        raise SystemExit("negative N2 policy test unexpectedly admitted")
    except ValueError as e:
        if needle not in str(e):
            raise
PY

install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

bad_param=""
bad_dismiss=""
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    bad_param="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-n2-runtime-param-negative-20260926-001","action":"notification.control.selftest","parameters":{"x":1},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    bad_dismiss="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-n2-runtime-dismiss-negative-20260926-001","action":"notification.dismiss","parameters":{"notification_id":"0000000000000000000000000000000000000000000000000000000000000000","expected_content_hash":"0000000000000000000000000000000000000000000000000000000000000000"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ "$bad_param" == *"notification selftest parameters"* && "$bad_dismiss" == *"action not admitted"* ]]; then
      break
    fi
  fi
  sleep 1
done

systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ "$bad_param" == *"notification selftest parameters"* ]]
[[ "$bad_dismiss" == *"action not admitted"* ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

printf 'CF_PAA_NOTIFICATION_N2_SELFTEST_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'STATIC_SELFTEST_POSITIVE=PASS\n'
printf 'STATIC_SELFTEST_PARAM_NEGATIVE=PASS\n'
printf 'STATIC_DISMISS_REMOTE_NEGATIVE=PASS\n'
printf 'STATIC_SNOOZE_REMOTE_NEGATIVE=PASS\n'
printf 'RUNTIME_SELFTEST_PARAM_NEGATIVE=PASS\n'
printf 'RUNTIME_DISMISS_REMOTE_NEGATIVE=PASS\n'
printf 'ADMITTED_NEW=notification.control.selftest(fixed-empty-params)\n'
printf 'CF_PAA_NOTIFICATION_N2_SELFTEST_POLICY_END\n'
