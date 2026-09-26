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

if '"display.present_image"' in block and 'image artifact id' in block:
    open(dst,"w",encoding="utf-8").write(text)
    raise SystemExit(0)

admit_old='''        "app.open",
        "url.open",
    }'''
admit_new='''        "app.open",
        "url.open",
        "display.present_image",
    }'''
if admit_old not in block:
    raise SystemExit("publisher image admitted-set baseline mismatch")
block=block.replace(admit_old,admit_new,1)

branch='''    elif action == "url.open":
        if set(p) != {"url"}:
            fail("url open parameters")
        url=p["url"]
        if url != "https://example.com/":
            fail("url not admitted")

    ttl=req["ttl_seconds"]'''
replacement='''    elif action == "url.open":
        if set(p) != {"url"}:
            fail("url open parameters")
        url=p["url"]
        if url != "https://example.com/":
            fail("url not admitted")
    elif action == "display.present_image":
        if set(p) != {"artifact_id","mime"}:
            fail("image parameters")
        artifact_id=p["artifact_id"]
        mime=p["mime"]
        if not isinstance(artifact_id,str) or not re.fullmatch(r"[0-9a-f]{64}", artifact_id):
            fail("image artifact id")
        if mime not in {"image/png","image/jpeg"}:
            fail("image mime not admitted")

    ttl=req["ttl_seconds"]'''
if branch not in block:
    raise SystemExit("publisher image branch baseline mismatch")
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
def fail(msg):
    raise ValueError(msg)
ns["fail"]=fail
exec(text[start:end],ns)
validate=ns["validate"]
base={"schema":"personal-android-agent.remote-request.v1","ttl_seconds":300}
good="541a1ef5373be3dc49fc542fd9a65177b664aec01c8d8608f99e6ec95577d8c1"
validate({**base,"request_id":"paa-policy-image-static-20260926-001","action":"display.present_image","parameters":{"artifact_id":good,"mime":"image/png"}})
for req,needle in [
    ({**base,"request_id":"paa-policy-image-negative-mime-20260926-001","action":"display.present_image","parameters":{"artifact_id":good,"mime":"text/html"}},"image mime not admitted"),
    ({**base,"request_id":"paa-policy-image-negative-id-20260926-001","action":"display.present_image","parameters":{"artifact_id":"bad","mime":"image/png"}},"image artifact id"),
]:
    try:
        validate(req)
        raise SystemExit("negative static image test unexpectedly admitted")
    except ValueError as e:
        if needle not in str(e):
            raise
PY

install -m 0750 -o root -g root "$tmp" "$publisher"
systemctl restart capability-fabric-paa-publisher.service

bad_image=""
for _ in $(seq 1 20); do
  if systemctl is-active --quiet capability-fabric-paa-publisher.service \
      && [[ -S /run/capability-fabric/paa-publisher.sock ]]; then
    bad_image="$(printf '%s' '{"schema":"personal-android-agent.remote-request.v1","request_id":"paa-policy-image-runtime-negative-20260926-001","action":"display.present_image","parameters":{"artifact_id":"541a1ef5373be3dc49fc542fd9a65177b664aec01c8d8608f99e6ec95577d8c1","mime":"text/html"},"ttl_seconds":300}' | runuser -u "$remote_user" -- /usr/local/bin/paa-publish-envelope 2>/dev/null || true)"
    if [[ "$bad_image" == *"image mime not admitted"* ]]; then
      break
    fi
  fi
  sleep 1
done

systemctl is-active --quiet capability-fabric-paa-publisher.service
[[ -S /run/capability-fabric/paa-publisher.sock ]]
[[ "$bad_image" == *"image mime not admitted"* ]]

if runuser -u "$remote_user" -- cat "$producer_key" >/dev/null 2>&1; then exit 20; fi
if runuser -u "$remote_user" -- cat "$binding" >/dev/null 2>&1; then exit 21; fi

printf 'CF_PAA_IMAGE_ATTENDED_POLICY_BEGIN\n'
printf 'SERVICE=%s\n' "$(systemctl is-active capability-fabric-paa-publisher.service)"
printf 'REMOTE_SECRET_ACCESS=no\n'
printf 'STATIC_IMAGE_POSITIVE=PASS\n'
printf 'STATIC_IMAGE_MIME_NEGATIVE=PASS\n'
printf 'STATIC_IMAGE_ID_NEGATIVE=PASS\n'
printf 'RUNTIME_IMAGE_MIME_NEGATIVE=PASS\n'
printf 'ADMITTED_NEW=display.present_image(sha256,image/png|image/jpeg)\n'
printf 'CF_PAA_IMAGE_ATTENDED_POLICY_END\n'
