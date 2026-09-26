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
if '"tts.speak"' in text and '"display.present_text"' in text:
    open(dst,"w",encoding="utf-8").write(text)
    raise SystemExit(0)

admit_old='''        "artifact.fetch_verify_cache",
        "volume.get_set",
    }'''
admit_new='''        "artifact.fetch_verify_cache",
        "volume.get_set",
        "tts.speak",
        "display.present_text",
    }'''
if admit_old not in text:
    raise SystemExit("publisher admitted-set baseline mismatch")
text=text.replace(admit_old,admit_new,1)

branch='''    elif action == "volume.get_set":
        if set(p) != {"stream","operation"}:
            fail("volume read parameters")
        if p["operation"] != "get":
            fail("volume mutation not admitted")
        if p["stream"] not in {"music","alarm","ring","notification"}:
            fail("volume stream")

    ttl=req["ttl_seconds"]'''
replacement='''    elif action == "volume.get_set":
        if set(p) != {"stream","operation"}:
            fail("volume read parameters")
        if p["operation"] != "get":
            fail("volume mutation not admitted")
        if p["stream"] not in {"music","alarm","ring","notification"}:
            fail("volume stream")
    elif action == "tts.speak":
        if set(p) != {"text","language"}:
            fail("tts parameters")
        text_value=p["text"]
        language=p["language"]
        if not isinstance(text_value,str) or not 1 <= len(text_value) <= 240 or any(c in text_value for c in "\\r\\n\\0"):
            fail("tts text")
        if language not in {"en-US","fa-IR"}:
            fail("tts language")
    elif action == "display.present_text":
        if set(p) != {"text"}:
            fail("display text parameters")
        text_value=p["text"]
        if not isinstance(text_value,str) or not 1 <= len(text_value) <= 1000 or "\\0" in text_value:
            fail("display text")

    ttl=req["ttl_seconds"]'''
if branch not in text:
    raise SystemExit("publisher volume branch baseline mismatch")
text=text.replace(branch,replacement,1)
open(dst,"w",encoding="utf-8").write(text)
PY

python3 -m py_compile "$tmp"
install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

probe=""
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    probe="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-attended-health-selftest-20260926-001","action":"system.health","parameters":{},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    [[ -n "$probe" ]] && break
  fi
  sleep 1
done
systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ -n "$probe" ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

tts="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-tts-envelope-selftest-20260926-001","action":"tts.speak","parameters":{"text":"Android Agent test","language":"en-US"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope)"
display="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-display-envelope-selftest-20260926-001","action":"display.present_text","parameters":{"text":"Android Agent test"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope)"
negative="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-tts-language-negative-20260926-001","action":"tts.speak","parameters":{"text":"Android Agent test","language":"xx-XX"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope)"

TTS="$tts" DISPLAY="$display" NEGATIVE="$negative" python3 - <<'PY'
import json,os
t=json.loads(os.environ["TTS"])
d=json.loads(os.environ["DISPLAY"])
n=json.loads(os.environ["NEGATIVE"])
assert t.get("ok") is True
assert d.get("ok") is True
assert n.get("ok") is False and "tts language" in n.get("error","")
PY

printf 'CF_PAA_ATTENDED_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'TTS_ENVELOPE_SELFTEST=PASS\n'
printf 'DISPLAY_ENVELOPE_SELFTEST=PASS\n'
printf 'TTS_LANGUAGE_NEGATIVE_SELFTEST=PASS\n'
printf 'ADMITTED_NEW=tts.speak,display.present_text\n'
printf 'CF_PAA_ATTENDED_POLICY_END\n'
