#!/bin/bash
# cfserver_migrate.sh - rename uid 1000 (cfop_e79aa1fde5) to cfserver and move paa_remote workloads to it.
# Modes: --dry-run (default, changes nothing) | --apply | --rollback <backup_dir>
# Options: --paa-cron=disable|merge (default disable: paa_remote crontab kept as paa_remote.disabled-by-migration;
#            merge: append it, names replaced, to the cfserver crontab)
#          --paa-remote=start|stop (default start: start paa-remote unit as cfserver after migration)
#          --skip-wait (tests only: no 60 s stability wait)
# Must run as root, ideally as its own transient unit (server_admin_request background=true),
# because it stops capability-fabric-cf-ops.
set -u -o pipefail
OLD=cfop_e79aa1fde5; NEW=cfserver; PAA=paa_remote
R="${CF_MIG_ROOT:-}"                      # test prefix; empty on the real host
PAA_UID=994; PAA_GID=980; OLD_UID=1000
if [ -n "$R" ]; then PAA_UID="${CF_MIG_PAA_UID:-994}"; PAA_GID="${CF_MIG_PAA_GID:-980}"; fi
MODE=dry; PAA_START=start; PAA_CRON=disable; WAIT=60; RB_DIR=""
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) MODE=dry;; --apply) MODE=apply;; --rollback) MODE=rollback; RB_DIR="${2:-}"; shift;;
  --paa-remote=start) PAA_START=start;; --paa-remote=stop) PAA_START=stop;;
  --paa-cron=disable) PAA_CRON=disable;; --paa-cron=merge) PAA_CRON=merge;;
  --skip-wait) WAIT=1;; *) echo "unknown arg $1"; exit 2;; esac; shift; done

UNITS_1000="capability-fabric-cf-ops capability-fabric-pcg-wechat capability-fabric-pcg-wechat-semantic capability-fabric-pcg-browser@telegram capability-fabric-pcg-browser@whatsapp capability-fabric-pcg-browser@bale capability-fabric-pcg-browser@alibaba"
UNIT_PAA=capability-fabric-paa-remote; UNIT_PUB=capability-fabric-paa-publisher
STOP_ORDER="$UNIT_PAA capability-fabric-pcg-browser@alibaba capability-fabric-pcg-browser@bale capability-fabric-pcg-browser@whatsapp capability-fabric-pcg-browser@telegram capability-fabric-pcg-wechat-semantic capability-fabric-pcg-wechat capability-fabric-cf-ops"
START_ORDER="capability-fabric-cf-ops capability-fabric-pcg-wechat capability-fabric-pcg-wechat-semantic capability-fabric-pcg-browser@telegram capability-fabric-pcg-browser@whatsapp capability-fabric-pcg-browser@bale capability-fabric-pcg-browser@alibaba"
ETC_FILES="passwd group shadow gshadow subuid subgid"
ATT="$R/usr/local/lib/capability-fabric/pcg-provider-runtime/attended_auth.sh"
TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$R/var/backups/cf-migrate-$TS"
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
die(){ log "ABORT: $*"; exit 1; }
run(){ if [ "$MODE" = dry ]; then log "DRY: $*"; else log "RUN: $*"; "$@"; fi; }

unit_files(){ # unit files + drop-ins of capability-fabric units that mention OLD or PAA
  for d in "$R/etc/systemd/system" "$R/run/systemd/system"; do [ -d "$d" ] || continue
    grep -rlE "(^|[^A-Za-z0-9_])($OLD|$PAA)([^A-Za-z0-9_]|$)" "$d" 2>/dev/null | grep 'capability-fabric' ; done | sort -u; }
exec_scripts(){ # scripts named in ExecStart*/ExecStop* of those units that mention the names (only under /usr/local or /var/lib/capability-fabric)
  for f in $(unit_files); do grep -hE '^Exec' "$f" | tr ' =' '\n\n' | grep -E '^/(usr/local|var/lib/capability-fabric)/' ; done | sort -u |
  while read -r s; do [ -f "$R$s" ] && grep -qE "($OLD|$PAA)" "$R$s" && echo "$R$s"; done; }
sudo_files(){ [ -d "$R/etc/sudoers.d" ] && grep -lE "($OLD|$PAA)" "$R"/etc/sudoers.d/* 2>/dev/null; true; }
host_pids(){ # host-namespace pids of a uid (never container processes)
  local u=$1 me; me=$(readlink "$R/proc/1/ns/pid" 2>/dev/null)
  ps -eo pid=,uid= 2>/dev/null | awk -v u="$u" '$2==u{print $1}' | while read -r p; do
    [ "$(readlink "$R/proc/$p/ns/pid" 2>/dev/null)" = "$me" ] && [ "$p" != "$$" ] && echo "$p"; done; }
fs_roots(){ for d in / /tmp /run /dev/shm /var/tmp /var/lib; do [ -d "$R$d" ] && echo "$R$d"; done; }
paa_manifest(){ # NUL-free manifest "uid:gid<TAB>path" of every path owned by PAA uid or gid
  for d in $(fs_roots); do find "$d" -xdev \( -path "$R/var/lib/docker" -o -path "$R/var/lib/containerd" -o -path "$R/proc" -o -path "$R/sys" \) -prune -o \( -uid "$PAA_UID" -o -gid "$PAA_GID" \) -printf '%U:%G\t%p\n' 2>/dev/null; done | sort -u; }
replace_names(){ # whole-word OLD->NEW and PAA->NEW in a file
  sed -i -E "s/(^|[^A-Za-z0-9_])$OLD([^A-Za-z0-9_]|$)/\1$NEW\2/g; s/(^|[^A-Za-z0-9_])$PAA([^A-Za-z0-9_]|$)/\1$NEW\2/g" "$1"; }

preflight(){
  local ok=1
  [ -n "$R" ] || [ "$(id -u)" = 0 ] || { log "FAIL not root"; ok=0; }
  [ "$(getent passwd $OLD_UID | cut -d: -f1)" = "$OLD" ] && log "ok uid 1000 is $OLD" || { log "FAIL uid 1000 is not $OLD"; ok=0; }
  getent passwd $NEW >/dev/null && { log "FAIL $NEW already exists"; ok=0; } || log "ok $NEW absent"
  getent group $NEW >/dev/null && { log "FAIL group $NEW already exists"; ok=0; }
  if getent passwd $PAA >/dev/null; then [ "$(getent passwd $PAA | cut -d: -f3,4)" = "$PAA_UID:$PAA_GID" ] && log "ok $PAA is $PAA_UID/$PAA_GID" || { log "FAIL $PAA ids differ"; ok=0; }
  else log "note $PAA absent (step 4 skipped)"; fi
  [ -e "$R/home/$NEW" ] && { log "FAIL /home/$NEW exists"; ok=0; }
  [ -d "$R/home/$OLD" ] && [ ! -L "$R/home/$OLD" ] && log "ok home /home/$OLD" || { log "FAIL /home/$OLD missing or symlink"; ok=0; }
  local free; free=$(df -Pk "$R/" | awk 'NR==2{print $4}'); [ "${free:-0}" -ge 2097152 ] && log "ok disk free ${free}k" || { log "FAIL disk free <2GB"; ok=0; }
  for u in $UNITS_1000; do systemctl cat "$u" >/dev/null 2>&1 && log "ok unit $u" || { log "FAIL unit $u missing"; ok=0; }; done
  { pgrep -x 'apt|apt-get|dpkg' || pgrep -f '/usr/bin/unattended-upgrade( |$)'; } >/dev/null 2>&1 && { log "FAIL package manager running"; ok=0; }
  for c in usermod groupmod userdel groupdel loginctl find sed xargs visudo; do command -v $c >/dev/null || { log "FAIL missing $c"; ok=0; }; done
  log "unit files to edit:"; unit_files | sed 's/^/  /'
  log "scripts to edit:"; { [ -f "$ATT" ] && echo "$ATT"; exec_scripts; } | sort -u | sed 's/^/  /'
  log "sudoers files mentioning names:"; sudo_files | sed 's/^/  /'
  log "crontabs (paa_remote crontab action: $PAA_CRON):"; for f in "$R"/var/spool/cron/crontabs/*; do [ -f "$f" ] && log "  $(basename "$f"): $(grep -cvE '^(#|$)' "$f") active lines"; done
  log "at jobs of $OLD/$PAA:"; atq 2>/dev/null | awk -v a=$OLD -v b=$PAA '$NF==a||$NF==b' | sed 's/^/  /'
  log "host processes: uid1000=$(host_pids $OLD_UID | wc -l) uid$PAA_UID=$(host_pids $PAA_UID | wc -l)"
  log "paths owned by $PAA (count): $(paa_manifest | wc -l)"
  [ $ok = 1 ] || die "preflight failed"; log "preflight OK"; }

backup(){
  umask 077; mkdir -p "$BK/etc" "$BK/units" "$BK/files" || die "backup dir"
  for f in $ETC_FILES; do cp -a "$R/etc/$f" "$BK/etc/$f" 2>/dev/null; done
  for d in etc run; do [ -d "$R/$d/systemd/system" ] && mkdir -p "$BK/units/$d" && cp -a "$R/$d/systemd/system/." "$BK/units/$d/" 2>/dev/null; done
  { [ -f "$ATT" ] && echo "$ATT"; exec_scripts; sudo_files; } | sort -u > "$BK/files.list"
  while read -r f; do [ -n "$f" ] && mkdir -p "$BK/files$(dirname "${f#$R}")" && cp -a "$f" "$BK/files${f#$R}"; done < "$BK/files.list"
  for s in crontabs; do [ -d "$R/var/spool/cron/$s" ] && cp -a "$R/var/spool/cron/$s" "$BK/$s"; done
  [ -d "$R/var/spool/cron/atjobs" ] && cp -a "$R/var/spool/cron/atjobs" "$BK/atjobs"
  [ -d "$R/var/lib/AccountsService/users" ] && cp -a "$R/var/lib/AccountsService/users" "$BK/accounts"
  paa_manifest > "$BK/paa_owner.manifest"
  echo "$TS" > "$BK/STAMP"; log "backup in $BK ($(wc -l < "$BK/paa_owner.manifest") paa paths)"; }

stop_all(){
  for u in $STOP_ORDER; do run systemctl stop "$u"; done
  for j in $(atq 2>/dev/null | awk -v a=$OLD -v b=$PAA '$NF==a||$NF==b{print $1}'); do run atrm "$j"; done
  run loginctl terminate-user "$OLD"; getent passwd $PAA >/dev/null && run loginctl terminate-user "$PAA"
  [ "$MODE" = dry ] && return
  sleep 3
  for sig in TERM KILL; do for u in $OLD_UID $PAA_UID; do for p in $(host_pids $u); do kill -$sig "$p" 2>/dev/null; done; done; sleep 5; done
  local left; left=$(( $(host_pids $OLD_UID | wc -l) + $(host_pids $PAA_UID | wc -l) )); [ "$left" = 0 ] || log "warn $left host processes still alive"; }

rename_user(){
  run usermod -l "$NEW" -d "/home/$NEW" -m "$OLD" || return 1
  run groupmod -n "$NEW" "$OLD" || return 1
  run ln -s "/home/$NEW" "$R/home/$OLD" || return 1
  [ "$MODE" = dry ] && return 0
  for f in subuid subgid; do [ -f "$R/etc/$f" ] && sed -i -E "s/^$OLD:/$NEW:/" "$R/etc/$f"; done
  local C="$R/var/spool/cron/crontabs"
  [ -f "$C/$OLD" ] && mv "$C/$OLD" "$C/$NEW"
  if [ -f "$C/$PAA" ]; then
    if [ "$PAA_CRON" = merge ]; then sed -E "s/(^|[^A-Za-z0-9_])$PAA([^A-Za-z0-9_]|$)/\1$NEW\2/g" "$C/$PAA" | grep -vE '^# (DO NOT EDIT|\(.* installed on|\(Cron version)' >> "$C/$NEW"
      chown "$NEW:crontab" "$C/$NEW" 2>/dev/null; chmod 600 "$C/$NEW"; log "merged $PAA crontab into $NEW"; fi
    mv "$C/$PAA" "$C/$PAA.disabled-by-migration"; fi
  [ -f "$R/var/lib/AccountsService/users/$OLD" ] && mv "$R/var/lib/AccountsService/users/$OLD" "$R/var/lib/AccountsService/users/$NEW"
  return 0; }

move_paa(){
  getent passwd $PAA >/dev/null || { log "skip: $PAA absent"; return 0; }
  if [ "$MODE" = dry ]; then log "DRY: chown $(wc -l < <(paa_manifest)) paths $PAA_UID/$PAA_GID -> 1000/1000"; return 0; fi
  [ -f "$BK/paa_owner.manifest" ] || return 1
  awk -F'\t' -v u="$PAA_UID" '{split($1,a,":"); if (a[1]==u) print $2}' "$BK/paa_owner.manifest" | xargs -r -d '\n' chown -h "$OLD_UID" || return 1
  awk -F'\t' -v g="$PAA_GID" '{split($1,a,":"); if (a[2]==g) print $2}' "$BK/paa_owner.manifest" | xargs -r -d '\n' chgrp -h "$OLD_UID" || return 1
  log "ownership moved for $(wc -l < "$BK/paa_owner.manifest") paths"
  return 0; }

edit_configs(){
  local files; files=$( { unit_files; [ -f "$ATT" ] && echo "$ATT"; exec_scripts; sudo_files; } | sort -u)
  for f in $files; do run replace_names "$f" || return 1; done
  [ "$MODE" = dry ] && return 0
  if [ -z "$R" ]; then visudo -c >/dev/null 2>&1 || { log "sudoers check failed"; return 1; }; fi
  return 0; }

start_all(){
  run systemctl daemon-reload
  systemctl cat $UNIT_PUB >/dev/null 2>&1 && run systemctl restart $UNIT_PUB
  for u in $START_ORDER; do run systemctl start "$u"; done
  [ "$PAA_START" = start ] && systemctl cat $UNIT_PAA >/dev/null 2>&1 && run systemctl start $UNIT_PAA
  return 0; }

verify(){
  local ok=1 units="$START_ORDER"; [ "$PAA_START" = start ] && systemctl cat $UNIT_PAA >/dev/null 2>&1 && units="$units $UNIT_PAA"
  [ "$(id -u $NEW 2>/dev/null)" = 1000 ] || { log "VFAIL id $NEW"; ok=0; }
  getent passwd $OLD >/dev/null && { log "VFAIL $OLD still in passwd"; ok=0; }
  grep -qE "^$OLD:" "$R/etc/shadow" "$R/etc/group" 2>/dev/null && { log "VFAIL $OLD in shadow/group"; ok=0; }
  [ -n "$(unit_files)" ] && { log "VFAIL units still mention old names: $(unit_files)"; ok=0; }
  [ -d "$R/home/$NEW" ] && [ -L "$R/home/$OLD" ] || { log "VFAIL home/symlink"; ok=0; }
  log "waiting ${WAIT}s for stability"; sleep "$WAIT"
  for u in $units; do [ "$(systemctl is-active "$u" 2>/dev/null)" = active ] || { log "VFAIL $u not active"; ok=0; }
    local usr; usr=$(systemctl show -p User --value "$u" 2>/dev/null); [ "$usr" = "$NEW" ] || { log "VFAIL $u User=$usr"; ok=0; }; done
  [ $ok = 1 ]; }

rollback(){ # $1 backup dir
  local b="$1"; [ -f "$b/STAMP" ] || die "no backup at $b"
  log "ROLLBACK from $b"
  for u in $STOP_ORDER; do systemctl stop "$u" 2>/dev/null; done
  for sig in TERM KILL; do for u in $OLD_UID; do for p in $(host_pids $u); do kill -$sig "$p" 2>/dev/null; done; done; sleep 3; done
  for f in $ETC_FILES; do [ -f "$b/etc/$f" ] && cp -a "$b/etc/$f" "$R/etc/$f"; done
  for d in etc run; do [ -d "$b/units/$d" ] && cp -a "$b/units/$d/." "$R/$d/systemd/system/"; done
  while read -r f; do [ -n "$f" ] && [ -f "$b/files${f#$R}" ] && cp -a "$b/files${f#$R}" "$f"; done < "$b/files.list"
  [ -d "$b/crontabs" ] && rm -rf "$R/var/spool/cron/crontabs" && cp -a "$b/crontabs" "$R/var/spool/cron/crontabs"
  [ -d "$b/atjobs" ] && rm -rf "$R/var/spool/cron/atjobs" && cp -a "$b/atjobs" "$R/var/spool/cron/atjobs"
  [ -d "$b/accounts" ] && rm -rf "$R/var/lib/AccountsService/users" && cp -a "$b/accounts" "$R/var/lib/AccountsService/users"
  if [ -L "$R/home/$OLD" ] && [ -d "$R/home/$NEW" ]; then rm "$R/home/$OLD" && mv "$R/home/$NEW" "$R/home/$OLD"; fi
  cut -f1 "$b/paa_owner.manifest" | sort -u | while read -r ug; do
    awk -F'\t' -v k="$ug" '$1==k{print $2}' "$b/paa_owner.manifest" | xargs -r -d '\n' chown -h "$ug" 2>/dev/null; done
  systemctl daemon-reload
  systemctl cat $UNIT_PUB >/dev/null 2>&1 && systemctl restart $UNIT_PUB
  for u in $START_ORDER $UNIT_PAA; do systemctl start "$u"; done
  [ "$(getent passwd 1000 | cut -d: -f1)" = "$OLD" ] && log "rollback: uid 1000 is $OLD again" || log "rollback: WARNING uid 1000 name check failed"
  for u in $START_ORDER; do log "  $u $(systemctl is-active "$u")"; done; }

finish_paa(){ # only after successful verify
  getent passwd $PAA >/dev/null || return 0
  userdel "$PAA" && log "deleted user $PAA (files kept)"
  getent group $PAA >/dev/null && { groupdel "$PAA" && log "deleted group $PAA" || log "warn: group $PAA kept"; }; return 0; }

case "$MODE" in
  rollback) rollback "$RB_DIR"; exit 0;;
  dry) log "DRY RUN - nothing will change"; preflight; stop_all; rename_user; move_paa; edit_configs; start_all; log "DRY RUN done";;
  apply) log "APPLY start"; preflight; backup
    step(){ "$@" || { log "step $1 failed"; rollback "$BK"; log "RESULT=ROLLED_BACK"; exit 1; }; }
    step stop_all; step rename_user; step move_paa; step edit_configs; step start_all; step verify
    finish_paa; log "RESULT=MIGRATED backup=$BK";;
esac
