#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || { echo CF_INDOUBT_LOG_REQUIRES_ROOT >&2; exit 2; }

control=/var/lib/capability-fabric/onshape/runtime-control/ONSHAPE_RUNTIME_CONTROL.json
python3 - "$control" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); a=r["authority"]
assert r["controlRevision"]==529
assert a["productionEpoch"]==1
assert a["mode"]=="ANDROID_PRODUCTION"
assert a["materialAuthority"]=="android-v1"
assert a["planes"]["vps-fabric"]["materialEffectsAllowed"] is False
print("CF_INDOUBT_LOG_AUTHORITY=android-epoch1")
PY

attempt='attempt:f6d80f46-b4ff-4798-9848-9b0b28bca1b8'
operation='operation:3cbb9823-a285-4d55-9cdc-cf57a2cb0cd2'
since='2026-09-20T19:04:48Z'
until='2026-09-20T19:05:11Z'

tmp="$(mktemp -d /var/lib/capability-fabric/.indoubt-log.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

for c in capability-fabric-onshape-server capability-fabric-onshape-fabric capability-fabric-onshape-gateway; do
  if docker inspect "$c" >/dev/null 2>&1; then
    docker logs --timestamps --since "$since" --until "$until" "$c" >"$tmp/$c.log" 2>&1 || true
    n="$(wc -l <"$tmp/$c.log" | tr -d ' ')"
    echo "CF_INDOUBT_LOG_CONTAINER_LINES=$c:$n"
    python3 - "$tmp/$c.log" "$attempt" "$operation" "$c" <<'PY'
import re,sys
path,attempt,operation,container=sys.argv[1:]
lines=open(path,errors="replace").read().splitlines()
terms=[attempt,operation,"TimeoutError","locator.fill","locator.press","sequence","input"]
hits=[]
for line in lines:
    if any(t in line for t in terms):
        safe=line
        safe=re.sub(r'(?i)(selector|text|value|password|email)=\S+',r'\1=<redacted>',safe)
        safe=re.sub(r'https?://\S+','<url>',safe)
        hits.append(safe[:1200])
print(f"CF_INDOUBT_LOG_RELEVANT_COUNT={container}:{len(hits)}")
for i,line in enumerate(hits[:80],1):
    print(f"CF_INDOUBT_LOG_HIT={container}:{i}:{line}")
PY
  fi
done

journalctl --utc --since "$since" --until "$until"   -u capability-fabric-onshape-server.service --no-pager -o short-iso-precise   >"$tmp/journal.log" 2>&1 || true
echo "CF_INDOUBT_LOG_JOURNAL_LINES=$(wc -l <"$tmp/journal.log" | tr -d ' ')"
python3 - "$tmp/journal.log" "$attempt" "$operation" <<'PY'
import re,sys
path,attempt,operation=sys.argv[1:]
lines=open(path,errors="replace").read().splitlines()
terms=[attempt,operation,"TimeoutError","locator.fill","locator.press","sequence","input"]
hits=[]
for line in lines:
    if any(t in line for t in terms):
        safe=re.sub(r'https?://\S+','<url>',line)[:1200]
        hits.append(safe)
print("CF_INDOUBT_LOG_JOURNAL_RELEVANT_COUNT="+str(len(hits)))
for i,line in enumerate(hits[:80],1):
    print(f"CF_INDOUBT_LOG_JOURNAL_HIT={i}:{line}")
PY

echo CF_INDOUBT_LOG_WINDOW=pass
