#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

profile_parent=/var/lib/capability-fabric/onshape
profile=/var/lib/capability-fabric/onshape/browser-profile
active=/opt/capability-fabric/current
previous=/opt/capability-fabric/previous
state=/var/lib/capability-fabric/state
detail=/var/log/capability-fabric/pull-agent-detail.log

safe_base() { local p="$1"; if [[ -L "$p" ]]; then basename "$(readlink -f "$p")"; else printf none; fi; }
read_state() { local p="$1"; [[ -r "$p" ]] && cat "$p" || printf none; }

echo CF_ONSHAPE_DIAG_BEGIN
echo "ACTIVE_RELEASE=$(safe_base "$active")"
echo "PREVIOUS_RELEASE=$(safe_base "$previous")"
echo "LAST_GOOD_SEQUENCE=$(read_state "$state/last-good-sequence")"
echo "LAST_GOOD_RELEASE=$(read_state "$state/last-good-release")"
echo "LAST_FAILED_COMMIT=$(read_state "$state/last-failed-commit")"

if [[ -d "$profile_parent" ]]; then echo "PROFILE_PARENT=$(stat -c '%a %u:%g' "$profile_parent")"; else echo PROFILE_PARENT=missing; fi
if [[ -d "$profile" ]]; then echo "PROFILE=$(stat -c '%a %u:%g' "$profile")"; else echo PROFILE=missing; fi
if getent passwd 19191 >/dev/null 2>&1; then echo HOST_UID_19191=assigned; else echo HOST_UID_19191=free; fi
if [[ -d "$profile" && "$(stat -c '%a %u:%g' "$profile")" == "700 19191:19191" ]]; then echo NEW_PROFILE_EXPECTATION=pass; else echo NEW_PROFILE_EXPECTATION=fail; fi
if [[ -d "$profile" && "$(stat -c '%a %U:%G' "$profile")" == "700 root:root" ]]; then echo OLD_PROFILE_EXPECTATION=pass; else echo OLD_PROFILE_EXPECTATION=fail; fi

interactive_root=/var/lib/capability-fabric/onshape/interactive-browser
interactive_config="$interactive_root/config"
interactive_sentinel="$interactive_root/.backup-exclusion-sentinel"
exclude_file=/etc/capability-fabric/backup.exclude
if [[ -d "$interactive_root" ]]; then echo "INTERACTIVE_ROOT=$(stat -c '%a %u:%g' "$interactive_root")"; else echo INTERACTIVE_ROOT=missing; fi
if [[ -d "$interactive_config" ]]; then echo "INTERACTIVE_CONFIG=$(stat -c '%a %u:%g' "$interactive_config")"; else echo INTERACTIVE_CONFIG=missing; fi
if [[ -e "$interactive_sentinel" ]]; then echo "INTERACTIVE_SENTINEL=$(stat -c '%a %u:%g' "$interactive_sentinel")"; else echo INTERACTIVE_SENTINEL=missing; fi
if [[ -f "$exclude_file" ]] && grep -Fxq "$interactive_root" "$exclude_file"; then echo INTERACTIVE_EXCLUDE=pass; else echo INTERACTIVE_EXCLUDE=fail; fi

echo CF_INTERACTIVE_LOGS_BEGIN
if [[ -d "$interactive_config/log" ]]; then
  find "$interactive_config/log" -xdev -maxdepth 3 -type f -print0 | while IFS= read -r -d '' logf; do
    rel="${logf#"$interactive_config/"}"
    echo "LOG_FILE=$rel"
    tail -n 80 "$logf" 2>/dev/null | sed -E 's#https?://[^[:space:]"]+#<url>#g; s#([0-9]{1,3}\.){3}[0-9]{1,3}#<ipv4>#g; s#([A-Za-z0-9_-]{24,})#<long-token>#g' || true
  done
else
  echo no-interactive-log-directory
fi
echo CF_INTERACTIVE_LOGS_END

if [[ -d "$profile" ]]; then
  bad_dirs="$(find "$profile" -xdev -type d ! -perm 0700 -print | wc -l | tr -d '[:space:]')"
  bad_files="$(find "$profile" -xdev -type f -perm /077 -print | wc -l | tr -d '[:space:]')"
  echo "PROFILE_BAD_DIR_MODES=$bad_dirs"
  echo "PROFILE_BAD_FILE_MODES=$bad_files"
  first_bad_dir="$(find "$profile" -xdev -type d ! -perm 0700 -printf '%P\n' -quit)"
  first_bad_file="$(find "$profile" -xdev -type f -perm /077 -printf '%P\n' -quit)"
  [[ -n "$first_bad_dir" ]] && echo "PROFILE_FIRST_BAD_DIR=$first_bad_dir" || echo "PROFILE_FIRST_BAD_DIR=none"
  [[ -n "$first_bad_file" ]] && echo "PROFILE_FIRST_BAD_FILE=$first_bad_file" || echo "PROFILE_FIRST_BAD_FILE=none"
fi

if docker inspect capability-fabric-onshape-chromium >/dev/null 2>&1; then echo "CONTAINER_CHROMIUM=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}' capability-fabric-onshape-chromium)"; else echo CONTAINER_CHROMIUM=missing; fi
if docker inspect capability-fabric-onshape-server >/dev/null 2>&1; then echo "CONTAINER_SERVER=$(docker inspect -f '{{.State.Status}}/{{.State.Running}}' capability-fabric-onshape-server)"; else echo CONTAINER_SERVER=missing; fi

for p in 5800 8787 9222; do
  if ss -lnt | awk -v x="127.0.0.1:$p" '$4 == x {f=1} END {exit f?0:1}'; then echo "LOOPBACK_$p=pass"; else echo "LOOPBACK_$p=fail"; fi
  if ss -lnt | awk -v x="$p" '$4 == "0.0.0.0:"x || $4 == "[::]:"x || $4 == "*:"x {f=1} END {exit f?0:1}'; then echo "WILDCARD_$p=present"; else echo "WILDCARD_$p=absent"; fi
done

root_body="$(curl -fsS --max-time 3 http://127.0.0.1:8787/ 2>/dev/null || true)"
[[ "$root_body" == "cf-onshape-single ok" ]] && echo MCP_ROOT=pass || echo MCP_ROOT=fail
curl -fsS --max-time 3 http://127.0.0.1:5800/ >/dev/null 2>&1 && echo DESKTOP_HTTP=pass || echo DESKTOP_HTTP=fail
curl -fsS --max-time 3 http://127.0.0.1:9222/json/version 2>/dev/null | grep -q '"Browser"' && echo CDP_HTTP=pass || echo CDP_HTTP=fail
invalid_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/mcp/desktop/invalid-token/ 2>/dev/null || true)"
echo "DESKTOP_INVALID_CODE=$invalid_code"
echo "BOOT_UNIT_ENABLED=$(systemctl is-enabled capability-fabric-onshape-server.service 2>/dev/null || true)"
echo "BOOT_UNIT_ACTIVE=$(systemctl is-active capability-fabric-onshape-server.service 2>/dev/null || true)"

echo CF_PULL_DETAIL_TAIL_BEGIN
if [[ -r "$detail" ]]; then
  tail -n 180 "$detail" | sed -E 's#https?://[^[:space:]]+#<url>#g; s#([0-9]{1,3}\.){3}[0-9]{1,3}#<ipv4>#g'
else
  echo detail-log-missing
fi
echo CF_PULL_DETAIL_TAIL_END

echo CF_ONSHAPE_STORAGE_FS_DIAG_BEGIN
if [[ -d "$profile" ]]; then
  echo "PROFILE_FS=$(stat -f -c '%T' "$profile")"
  echo "PROFILE_SIZE_KB=$(du -sk "$profile" | awk '{print $1}')"
  echo "PROFILE_MOUNT=$(findmnt -T "$profile" -n -o FSTYPE,OPTIONS 2>/dev/null | tr ' ' '_' || true)"
  df -Pk "$profile" | awk 'NR==2{printf "PROFILE_DISK_KB_TOTAL=%s\\nPROFILE_DISK_KB_USED=%s\\nPROFILE_DISK_KB_AVAIL=%s\\nPROFILE_DISK_PCT=%s\\n",$2,$3,$4,$5}'
  df -Pi "$profile" | awk 'NR==2{printf "PROFILE_INODES_TOTAL=%s\\nPROFILE_INODES_USED=%s\\nPROFILE_INODES_AVAIL=%s\\nPROFILE_INODES_PCT=%s\\n",$2,$3,$4,$5}'
  for p in \
    "$profile/Default" \
    "$profile/Default/IndexedDB" \
    "$profile/Default/Local Storage" \
    "$profile/Default/Storage" \
    "$profile/Default/Service Worker"; do
    rel="${p#"$profile"/}"
    if [[ -e "$p" || -L "$p" ]]; then
      echo "PROFILE_NODE=$(stat -Lc '%F %a %u:%g %s' "$p" 2>/dev/null || stat -c '%F %a %u:%g %s' "$p") rel=$rel"
    else
      echo "PROFILE_NODE=missing rel=$rel"
    fi
  done
  find "$profile" -xdev -maxdepth 6 \( -iname '*indexeddb*' -o -iname '*quota*' -o -iname '*storage*' -o -name 'Singleton*' -o -name 'LOCK' \) \
    -printf 'PROFILE_RELEVANT=%y %m %u:%g %s %P\\n' 2>/dev/null | head -n 160
else
  echo PROFILE_STORAGE_DIAG=profile-missing
fi
if docker inspect capability-fabric-onshape-server >/dev/null 2>&1; then
  docker top capability-fabric-onshape-server -eo pid,ppid,user,stat,comm 2>/dev/null \
    | sed -n '1,80p' | sed 's/^/PROFILE_PROCESS=/'
fi
echo CF_ONSHAPE_STORAGE_FS_DIAG_END


echo CF_ONSHAPE_STORAGE_ISOLATION_DIAG_BEGIN
quota_db="$profile/Default/WebStorage/QuotaManager"
quota_journal="$profile/Default/WebStorage/QuotaManager-journal"
qtmp="$(mktemp -d /root/.cf-onshape-quota-copy.XXXXXX)"
trap 'rm -rf "$qtmp"' EXIT
if [[ -f "$quota_db" ]]; then
  cp -a "$quota_db" "$qtmp/QuotaManager"
  [[ -f "$quota_journal" ]] && cp -a "$quota_journal" "$qtmp/QuotaManager-journal" || true
  python3 - "$qtmp/QuotaManager" <<'PY'
import sqlite3,sys
p=sys.argv[1]
try:
    con=sqlite3.connect(p)
    rows=con.execute("PRAGMA integrity_check").fetchall()
    ok=(rows==[("ok",)])
    print("QUOTA_COPY_INTEGRITY="+("ok" if ok else "fail"))
    print("QUOTA_COPY_INTEGRITY_ROWS="+str(len(rows)))
    con.close()
except Exception as e:
    print("QUOTA_COPY_INTEGRITY=error")
    print("QUOTA_COPY_ERROR="+type(e).__name__+":"+str(e)[:300].replace("\n"," "))
PY
else
  echo QUOTA_COPY_INTEGRITY=missing
fi

if docker inspect capability-fabric-onshape-server >/dev/null 2>&1; then
  docker exec -i capability-fabric-onshape-server sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import { chromium } from "playwright";
import fs from "node:fs";
const dir="/tmp/cf-clean-storage-probe-"+process.pid;
const shape=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,400),code:e?.code==null?null:String(e.code).slice(0,80)});
let context=null;
try {
  context=await chromium.launchPersistentContext(dir,{headless:true,chromiumSandbox:false,args:["--no-sandbox","--disable-dev-shm-usage"]});
  const page=context.pages()[0] || await context.newPage();
  await page.goto("https://cad.onshape.com/documents",{waitUntil:"domcontentloaded",timeout:45000}).catch(()=>null);
  const out=await page.evaluate(async()=>{
    const shape=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,400),code:e?.code==null?null:String(e.code).slice(0,80)});
    const r={origin:location.origin,estimate:null,indexeddb:null};
    try { const e=await navigator.storage.estimate(); r.estimate={ok:true,usage:Number(e.usage||0),quota:Number(e.quota||0)}; }
    catch(e){ r.estimate={ok:false,error:shape(e)}; }
    try { const d=await indexedDB.databases(); r.indexeddb={ok:true,count:d.length}; }
    catch(e){ r.indexeddb={ok:false,error:shape(e)}; }
    return r;
  });
  console.log("CLEAN_TEMP_PROFILE_STORAGE="+JSON.stringify(out));
} catch(e) {
  console.log("CLEAN_TEMP_PROFILE_STORAGE="+JSON.stringify({outer_error:shape(e)}));
} finally {
  if(context) await context.close().catch(()=>{});
  fs.rmSync(dir,{recursive:true,force:true});
}
NODE
else
  echo 'CLEAN_TEMP_PROFILE_STORAGE={"outer_error":{"name":"ContainerMissing"}}'
fi
echo CF_ONSHAPE_STORAGE_ISOLATION_DIAG_END

echo CF_ONSHAPE_DIAG_END
