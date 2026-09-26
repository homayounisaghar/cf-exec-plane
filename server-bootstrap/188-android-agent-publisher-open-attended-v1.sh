#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || exit 10
publisher=/usr/local/libexec/paa-envelope-publisher.py
remote_user=paa_remote
producer_key=/etc/capability-fabric/secrets/android-agent/producer-p256-v1.pem
binding=/etc/capability-fabric/secrets/android-agent/device-binding-alpha10-line3.json

[[ -f "$publisher" && "$(stat -c '%U:%G:%a' "$publisher")" == "root:root:750" ]] || exit 11
id "$remote_user" >/dev/null 2>&1 || exit 12

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.pyc"' EXIT

python3 - "$publisher" "$tmp" <<'PY'
import sys
src,dst=sys.argv[1:]
text=open(src,encoding="utf-8").read()
start=text.index("def validate(req):")
end=text.index("\ndef load_keys():", start)
block=text[start:end]

if '"app.open"' in block and '"url.open"' in block and 'Personal Android Agent package' in block:
    open(dst,"w",encoding="utf-8").write(text)
    raise SystemExit(0)

if 'Personal Android Agent package only' in block:
    block=block.replace(
        'if package != "com.homayounisaghar.androidagent":\n            fail("app package not admitted")  # Samsung Internet package only',
        'if package != "com.homayounisaghar.androidagent":\n            fail("app package not admitted")  # Personal Android Agent package only',
        1,
    )
    open(dst,"w",encoding="utf-8").write(text[:start]+block+text[end:])
    raise SystemExit(0)

admit_old='''        "tts.speak",
        "display.present_text",
    }'''
admit_new='''        "tts.speak",
        "display.present_text",
        "app.open",
        "url.open",
    }'''
if admit_old not in block:
    raise SystemExit("publisher attended admitted-set baseline mismatch")
block=block.replace(admit_old,admit_new,1)

branch='''    elif action == "display.present_text":
        if set(p) != {"text"}:
            fail("display text parameters")
        text_value=p["text"]
        if not isinstance(text_value,str) or not 1 <= len(text_value) <= 1000 or "\\0" in text_value:
            fail("display text")

    ttl=req["ttl_seconds"]'''
replacement='''    elif action == "display.present_text":
        if set(p) != {"text"}:
            fail("display text parameters")
        text_value=p["text"]
        if not isinstance(text_value,str) or not 1 <= len(text_value) <= 1000 or "\\0" in text_value:
            fail("display text")
    elif action == "app.open":
        if set(p) != {"package"}:
            fail("app open parameters")
        package=p["package"]
        if package != "com.homayounisaghar.androidagent":
            fail("app package not admitted")  # Samsung Internet package only
    elif action == "url.open":
        if set(p) != {"url"}:
            fail("url open parameters")
        url=p["url"]
        if url != "https://example.com/":
            fail("url not admitted")

    ttl=req["ttl_seconds"]'''
if branch not in block:
    raise SystemExit("publisher display branch baseline mismatch")
block=block.replace(branch,replacement,1)
open(dst,"w",encoding="utf-8").write(text[:start]+block+text[end:])
PY

python3 -m py_compile "$tmp"

# Validate the patched schema in isolation so no admitted positive test is published to the phone.
python3 - "$tmp" <<'PY'
import re,sys
text=open(sys.argv[1],encoding="utf-8").read()
start=text.index("def validate(req):")
end=text.index("\ndef load_keys():", start)
ns={"re":re}
def fail(msg):
    raise ValueError(msg)
ns["fail"]=fail
exec(text[start:end],ns)
validate=ns["validate"]
base={"schema":"personal-android-agent.remote-request.v1","ttl_seconds":300}
validate({**base,"request_id":"paa-policy-app-open-static-20260926-001","action":"app.open","parameters":{"package":"com.homayounisaghar.androidagent"}})
validate({**base,"request_id":"paa-policy-url-open-static-20260926-001","action":"url.open","parameters":{"url":"https://example.com/"}})
for req,needle in [
    ({**base,"request_id":"paa-policy-app-open-negative-20260926-001","action":"app.open","parameters":{"package":"com.android.settings"}},"app package not admitted"),
    ({**base,"request_id":"paa-policy-url-open-negative-20260926-001","action":"url.open","parameters":{"url":"https://openai.com/"}},"url not admitted"),
    ({**base,"request_id":"paa-policy-volume-set-negative-20260926-002","action":"volume.get_set","parameters":{"stream":"music","operation":"set"}},"volume mutation not admitted"),
]:
    try:
        validate(req)
        raise SystemExit("negative static test unexpectedly admitted")
    except ValueError as e:
        if needle not in str(e):
            raise
PY

install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

bad_app=""
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    bad_app="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-app-open-negative-20260926-003","action":"app.open","parameters":{"package":"com.android.settings"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ "$bad_app" == *"app package not admitted"* ]]; then
      break
    fi
  fi
  sleep 1
done
systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ -S /run/capability-fabric/paa-publisher.sock ]]
[[ "$bad_app" == *"app package not admitted"* ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

# Runtime negative tests verify fail-closed behavior without publishing any phone-visible effect.
bad_url="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-url-open-negative-20260926-003","action":"url.open","parameters":{"url":"https://openai.com/"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope)"

BAD_APP="$bad_app" BAD_URL="$bad_url" python3 - <<'PY'
import json,os
a=json.loads(os.environ["BAD_APP"])
u=json.loads(os.environ["BAD_URL"])
assert a.get("ok") is False and "app package not admitted" in a.get("error","")
assert u.get("ok") is False and "url not admitted" in u.get("error","")
PY

printf 'CF_PAA_OPEN_ATTENDED_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'STATIC_APP_OPEN_POSITIVE=PASS\n'
printf 'STATIC_URL_OPEN_POSITIVE=PASS\n'
printf 'RUNTIME_APP_OPEN_NEGATIVE=PASS\n'
printf 'RUNTIME_URL_OPEN_NEGATIVE=PASS\n'
printf 'VOLUME_SET_NEGATIVE=PASS\n'
printf 'ADMITTED_NEW=app.open(com.homayounisaghar.androidagent),url.open(https://example.com/)\n'
printf 'CF_PAA_OPEN_ATTENDED_POLICY_END\n'
