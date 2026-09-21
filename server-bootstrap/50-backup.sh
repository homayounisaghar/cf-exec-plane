#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
mode="${1:-${CF_BACKUP_MODE:-run}}"
case "$mode" in run|prove) ;; *) echo "backup mode must be run or prove" >&2; exit 2 ;; esac

exclude_file=/etc/capability-fabric/backup.exclude
browser_profile=/var/lib/capability-fabric/onshape/browser-profile
browser_sentinel="$browser_profile/.backup-exclusion-sentinel"
interactive_browser_root=/var/lib/capability-fabric/onshape/interactive-browser
interactive_browser_sentinel="$interactive_browser_root/.backup-exclusion-sentinel"
pcg_web_profile=/var/lib/capability-fabric/pcg/telegram-web-profile
fabric_state_db=/var/lib/capability-fabric/onshape/fabric-state/execution.sqlite3
fabric_state_backup_dir=/var/lib/capability-fabric/onshape/fabric-state/backup
fabric_state_backup="$fabric_state_backup_dir/execution-consistent.sqlite3"

config=/etc/capability-fabric/backup.env
[[ -s "$config" ]] || { echo "BLOCKED: backup destination configuration is not provisioned" >&2; exit 30; }
[[ "$(stat -c '%U:%G:%a' "$config")" == root:root:600 ]] || { echo "backup configuration permissions are unsafe" >&2; exit 30; }
set -a
# shellcheck disable=SC1090
. "$config"
set +a
for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  [[ -n "${!name:-}" ]] || { echo "backup configuration missing $name" >&2; exit 30; }
done
case "$RESTIC_REPOSITORY" in s3:https://*) ;; *) echo "backup repository must be an HTTPS S3 endpoint" >&2; exit 30 ;; esac

export DEBIAN_FRONTEND=noninteractive
if ! command -v restic >/dev/null 2>&1; then apt-get update; apt-get install -y restic; fi
command -v python3 >/dev/null 2>&1 || { apt-get update; apt-get install -y python3; }
installed=/usr/local/libexec/capability-fabric-backup
self="$(readlink -f "${BASH_SOURCE[0]}")"
install -d -m 0755 /usr/local/libexec
if [[ "$self" != "$installed" ]]; then install -m 0750 -o root -g root "$self" "$installed"; fi

cat > /etc/systemd/system/capability-fabric-backup.service <<'UNIT'
[Unit]
Description=Capability Fabric encrypted external backup
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/capability-fabric-backup run
User=root
Group=root
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=/var/lib/capability-fabric /var/backups/capability-fabric /var/log/capability-fabric /run/lock
LockPersonality=yes
RestrictSUIDSGID=yes
UNIT
cat > /etc/systemd/system/capability-fabric-backup.timer <<'UNIT'
[Unit]
Description=Daily Capability Fabric encrypted external backup

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
Unit=capability-fabric-backup.service

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
if [[ "$mode" == prove ]]; then systemctl disable --now capability-fabric-backup.timer >/dev/null 2>&1 || true; fi

install -d -m 0750 -o root -g root /var/backups/capability-fabric /var/log/capability-fabric /var/lib/capability-fabric/state
log=/var/log/capability-fabric/backup-detail.log
: >> "$log"; chmod 0640 "$log"; chown root:root "$log"
exec 9>/run/lock/capability-fabric-backup.lock
if ! flock -n 9; then echo "CF_BACKUP_SKIPPED_LOCKED"; exit 0; fi

# The Onshape browser profile is disposable authenticated session state and must
# never enter restic. Provision/repair the exact exclusion only during an
# explicit prove run; routine timer runs validate it read-only and fail closed.
install -d -m 0700 -o root -g root /var/lib/capability-fabric/onshape
if [[ ! -d "$browser_profile" ]]; then
  [[ "$mode" == prove ]] || { echo "browser profile directory missing outside prove mode" >&2; exit 31; }
  install -d -m 0700 -o root -g root "$browser_profile"
fi
[[ "$(stat -c '%U:%G:%a' "$browser_profile")" == root:root:700 ]] || { echo "browser profile directory permissions are unsafe" >&2; exit 31; }

if [[ ! -e "$browser_sentinel" ]]; then
  [[ "$mode" == prove ]] || { echo "backup exclusion sentinel missing outside prove mode" >&2; exit 31; }
  printf 'capability-fabric browser backup exclusion proof\n' > "$browser_sentinel"
fi
if [[ "$mode" == prove ]]; then
  chown root:root "$browser_sentinel"
  chmod 0600 "$browser_sentinel"
fi
[[ "$(stat -c '%U:%G:%a' "$browser_sentinel")" == root:root:600 ]] || { echo "backup exclusion sentinel permissions are unsafe" >&2; exit 31; }

if [[ ! -d "$interactive_browser_root" ]]; then
  [[ "$mode" == prove ]] || { echo "interactive browser root missing outside prove mode" >&2; exit 31; }
  install -d -m 0700 -o root -g root "$interactive_browser_root"
fi
[[ "$(stat -c '%U:%G:%a' "$interactive_browser_root")" == root:root:700 ]] || { echo "interactive browser root permissions are unsafe" >&2; exit 31; }

if [[ ! -d "$pcg_web_profile" ]]; then
  [[ "$mode" == prove ]] || { echo "PCG web profile directory missing outside prove mode" >&2; exit 31; }
  install -d -m 0700 -o 65534 -g 65534 "$pcg_web_profile"
fi
[[ "$(stat -c '%u:%g:%a' "$pcg_web_profile")" == 65534:65534:700 ]] || { echo "PCG web profile directory permissions are unsafe" >&2; exit 31; }

if [[ ! -e "$interactive_browser_sentinel" ]]; then
  [[ "$mode" == prove ]] || { echo "interactive browser exclusion sentinel missing outside prove mode" >&2; exit 31; }
  printf 'capability-fabric interactive browser backup exclusion proof\n' > "$interactive_browser_sentinel"
  chown root:root "$interactive_browser_sentinel"
  chmod 0600 "$interactive_browser_sentinel"
fi
[[ "$(stat -c '%U:%G:%a' "$interactive_browser_sentinel")" == root:root:600 ]] || { echo "interactive browser exclusion sentinel permissions are unsafe" >&2; exit 31; }

if [[ ! -e "$exclude_file" ]]; then
  [[ "$mode" == prove ]] || { echo "backup exclusion file missing outside prove mode" >&2; exit 31; }
  printf '%s\n' "$browser_profile" > "$exclude_file"
  chown root:root "$exclude_file"
  chmod 0600 "$exclude_file"
fi
[[ "$(stat -c '%U:%G:%a' "$exclude_file")" == root:root:600 ]] || { echo "backup exclusion file permissions are unsafe" >&2; exit 31; }

if ! grep -Fxq "$browser_profile" "$exclude_file"; then
  [[ "$mode" == prove ]] || { echo "browser profile exclusion missing outside prove mode" >&2; exit 31; }
  tmp_exclude="$(mktemp /etc/capability-fabric/.backup.exclude.XXXXXX)"
  { cat "$exclude_file"; printf '%s\n' "$browser_profile"; } | awk 'NF && !seen[$0]++' > "$tmp_exclude"
  chown root:root "$tmp_exclude"
  chmod 0600 "$tmp_exclude"
  mv -f "$tmp_exclude" "$exclude_file"
fi

if ! grep -Fxq "$interactive_browser_root" "$exclude_file"; then
  [[ "$mode" == prove ]] || { echo "interactive browser exclusion missing outside prove mode" >&2; exit 31; }
  tmp_exclude="$(mktemp /etc/capability-fabric/.backup.exclude.XXXXXX)"
  { cat "$exclude_file"; printf '%s\n' "$interactive_browser_root"; } | awk 'NF && !seen[$0]++' > "$tmp_exclude"
  chown root:root "$tmp_exclude"
  chmod 0600 "$tmp_exclude"
  mv -f "$tmp_exclude" "$exclude_file"
fi

if ! grep -Fxq "$pcg_web_profile" "$exclude_file"; then
  [[ "$mode" == prove ]] || { echo "PCG web profile exclusion missing outside prove mode" >&2; exit 31; }
  tmp_exclude="$(mktemp /etc/capability-fabric/.backup.exclude.XXXXXX)"
  { cat "$exclude_file"; printf '%s\n' "$pcg_web_profile"; } | awk 'NF && !seen[$0]++' > "$tmp_exclude"
  chown root:root "$tmp_exclude"
  chmod 0600 "$tmp_exclude"
  mv -f "$tmp_exclude" "$exclude_file"
fi

python3 - "$exclude_file" "$browser_profile" "$interactive_browser_root" "$pcg_web_profile" <<'PY'
import os,sys
exclude_file,*required_paths=sys.argv[1:]
lines=[]
with open(exclude_file,encoding='utf-8') as f:
    for raw in f:
        p=raw.strip()
        if not p:
            continue
        if not p.startswith('/') or p == '/' or any(c in p for c in '*?['):
            raise SystemExit(f'unsafe backup exclusion path: {p!r}')
        norm=os.path.normpath(p)
        if norm != p or '/..' in p:
            raise SystemExit(f'non-canonical backup exclusion path: {p!r}')
        lines.append(p)
for required in required_paths:
    if required not in lines:
        raise SystemExit(f'required backup exclusion missing: {required}')
PY

pull_timer_was_enabled=no
if [[ "$(systemctl is-enabled capability-fabric-pull.timer 2>/dev/null || true)" == enabled ]]; then pull_timer_was_enabled=yes; systemctl stop capability-fabric-pull.timer; fi
resume_pull_timer() { if [[ "$pull_timer_was_enabled" == yes ]]; then systemctl start capability-fabric-pull.timer >/dev/null 2>&1 || true; fi; }
trap resume_pull_timer EXIT
for _ in $(seq 1 60); do systemctl is-active --quiet capability-fabric-pull.service || break; sleep 1; done
if systemctl is-active --quiet capability-fabric-pull.service; then echo "pull service did not quiesce for backup" >&2; exit 31; fi

roots=(/etc/capability-fabric /var/lib/capability-fabric /opt/capability-fabric /usr/local/libexec/capability-fabric-pull-agent /etc/systemd/system/capability-fabric-pull.service /etc/systemd/system/capability-fabric-pull.timer)
for p in "${roots[@]}"; do [[ -e "$p" || -L "$p" ]] || { echo "required backup root missing: $p" >&2; exit 31; }; done

sqlite_snapshot=not-present
if [[ -f "$fabric_state_db" ]]; then
  install -d -m 0700 -o root -g root "$fabric_state_backup_dir"
  python3 - "$fabric_state_db" "$fabric_state_backup" <<'PY'
import os,sqlite3,sys
src,dst=sys.argv[1:]
tmp=dst+".tmp"
try:
    os.unlink(tmp)
except FileNotFoundError:
    pass
source=sqlite3.connect(src, isolation_level=None, timeout=5.0)
target=sqlite3.connect(tmp, isolation_level=None, timeout=5.0)
try:
    source.backup(target)
    row=target.execute("PRAGMA integrity_check").fetchone()
    if row is None or str(row[0]).lower() != "ok":
        raise SystemExit("SQLite backup integrity check failed")
    schema=target.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()
    if schema is None or str(schema[0]) != "1":
        raise SystemExit("SQLite backup schema version mismatch")
finally:
    target.close()
    source.close()
os.chmod(tmp,0o600)
with open(tmp,'rb') as f:
    os.fsync(f.fileno())
os.replace(tmp,dst)
PY
  [[ "$(stat -c '%U:%G:%a' "$fabric_state_backup")" == root:root:600 ]] || {
    echo "consistent SQLite backup permissions are unsafe" >&2
    exit 31
  }
  sqlite_snapshot=pass
fi

if ! restic cat config >>"$log" 2>&1; then restic init >>"$log" 2>&1; fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
source_manifest="/var/backups/capability-fabric/source-${timestamp}.manifest"
python3 - "$source_manifest" / "$exclude_file" "${roots[@]}" <<'PY'
import hashlib,os,stat,sys
out,base,exclude_file,*roots=sys.argv[1:]
with open(exclude_file,encoding='utf-8') as f:
    excludes={line.strip() for line in f if line.strip()}
def excluded(label):
    return any(label == e or label.startswith(e.rstrip('/') + '/') for e in excludes)
def digest_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def emit(label,p,fh):
    if excluded(label): return
    st=os.lstat(p); mode=stat.S_IMODE(st.st_mode)
    if stat.S_ISLNK(st.st_mode): fh.write(f"L\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{os.readlink(p)}\n")
    elif stat.S_ISREG(st.st_mode): fh.write(f"F\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{st.st_size}\t{digest_file(p)}\n")
    elif stat.S_ISDIR(st.st_mode):
        fh.write(f"D\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\n")
        for name in sorted(os.listdir(p)): emit(label.rstrip('/')+'/'+name, os.path.join(p,name), fh)
    else: fh.write(f"S\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{stat.S_IFMT(st.st_mode)}\n")
with open(out,'w',encoding='utf-8') as fh:
    for r in roots: emit(r,r,fh)
PY
restic backup --tag capability-fabric-personal-server --exclude-file "$exclude_file" "${roots[@]}" >>"$log" 2>&1
snapshot_id="$(restic snapshots --json --tag capability-fabric-personal-server | python3 -c 'import json,sys; a=json.load(sys.stdin); assert a; print(max(a,key=lambda x:x["time"])["id"])')"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || { echo "could not resolve backup snapshot id" >&2; exit 32; }

if [[ "$mode" == prove ]]; then
  restic check --read-data >>"$log" 2>&1
  restore_dir="/var/backups/capability-fabric/restore-drill-${timestamp}"
  rm -rf "$restore_dir"; install -d -m 0700 "$restore_dir"
  restic restore "$snapshot_id" --target "$restore_dir" >>"$log" 2>&1
  if [[ -e "$restore_dir$browser_profile" || -L "$restore_dir$browser_profile" ]]; then
    echo "CF_BACKUP_BROWSER_PROFILE_EXCLUDE=failed" >&2
    exit 33
  fi
  if [[ -e "$restore_dir$interactive_browser_root" || -L "$restore_dir$interactive_browser_root" ]]; then
    echo "CF_BACKUP_INTERACTIVE_BROWSER_EXCLUDE=failed" >&2
    exit 33
  fi
  if [[ -e "$restore_dir$pcg_web_profile" || -L "$restore_dir$pcg_web_profile" ]]; then
    echo "CF_BACKUP_PCG_WEB_PROFILE_EXCLUDE=failed" >&2
    exit 33
  fi
  restored_manifest="/var/backups/capability-fabric/restored-${timestamp}.manifest"
  python3 - "$restored_manifest" "$restore_dir" "$exclude_file" "${roots[@]}" <<'PY'
import hashlib,os,stat,sys
out,base,exclude_file,*roots=sys.argv[1:]
with open(exclude_file,encoding='utf-8') as f:
    excludes={line.strip() for line in f if line.strip()}
def excluded(label):
    return any(label == e or label.startswith(e.rstrip('/') + '/') for e in excludes)
def digest_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def emit(label,p,fh):
    if excluded(label): return
    st=os.lstat(p); mode=stat.S_IMODE(st.st_mode)
    if stat.S_ISLNK(st.st_mode): fh.write(f"L\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{os.readlink(p)}\n")
    elif stat.S_ISREG(st.st_mode): fh.write(f"F\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{st.st_size}\t{digest_file(p)}\n")
    elif stat.S_ISDIR(st.st_mode):
        fh.write(f"D\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\n")
        for name in sorted(os.listdir(p)): emit(label.rstrip('/')+'/'+name, os.path.join(p,name), fh)
    else: fh.write(f"S\t{label}\t{mode:o}\t{st.st_uid}\t{st.st_gid}\t{stat.S_IFMT(st.st_mode)}\n")
with open(out,'w',encoding='utf-8') as fh:
    for r in roots:
        p=base+r
        if not (os.path.exists(p) or os.path.islink(p)): raise SystemExit(f'missing restored root: {r}')
        emit(r,p,fh)
PY
  cmp -s "$source_manifest" "$restored_manifest" || { echo "CF_BACKUP_RESTORE_COMPARE=failed" >&2; exit 33; }

  sqlite_restore_integrity=not-present
  sqlite_recoverable_count=0
  if [[ "$sqlite_snapshot" == pass ]]; then
    restored_sqlite="$restore_dir$fabric_state_backup"
    [[ -f "$restored_sqlite" ]] || { echo "CF_BACKUP_SQLITE_RESTORE=missing" >&2; exit 33; }
    sqlite_recoverable_count="$(python3 - "$restored_sqlite" <<'PY'
import sqlite3,sys
path=sys.argv[1]
conn=sqlite3.connect(f"file:{path}?mode=ro", uri=True, isolation_level=None, timeout=5.0)
try:
    row=conn.execute("PRAGMA integrity_check").fetchone()
    if row is None or str(row[0]).lower() != "ok":
        raise SystemExit("restored SQLite integrity check failed")
    schema=conn.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()
    if schema is None or str(schema[0]) != "1":
        raise SystemExit("restored SQLite schema version mismatch")
    count=conn.execute(
        "SELECT COUNT(*) FROM invocations WHERE phase IN ('DISPATCH_FINALIZED','DISPATCH_INTENT','OBSERVED')"
    ).fetchone()[0]
    print(int(count))
finally:
    conn.close()
PY
)"
    [[ "$sqlite_recoverable_count" =~ ^[0-9]+$ ]] || { echo "CF_BACKUP_SQLITE_RECOVERABLE_COUNT=invalid" >&2; exit 33; }
    sqlite_restore_integrity=pass
  fi

  printf 'snapshot_id=%s\nrestore_verified=yes\nverified_at=%s\nsqlite_snapshot=%s\nsqlite_restore_integrity=%s\nsqlite_recoverable_count=%s\n' "$snapshot_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sqlite_snapshot" "$sqlite_restore_integrity" "$sqlite_recoverable_count" > /var/lib/capability-fabric/state/backup-restore-proof
  chmod 0600 /var/lib/capability-fabric/state/backup-restore-proof; chown root:root /var/lib/capability-fabric/state/backup-restore-proof
  rm -rf "$restore_dir" "$source_manifest" "$restored_manifest"
  systemctl enable --now capability-fabric-backup.timer >/dev/null
  printf 'CF_BACKUP_PROOF_BEGIN\nSNAPSHOT_ID=%s\nRESTIC_CHECK=pass\nISOLATED_RESTORE=pass\nRESTORE_TREE_COMPARE=pass\nBROWSER_PROFILE_EXCLUDED=pass\nINTERACTIVE_BROWSER_PROFILE_EXCLUDED=pass\nPCG_WEB_PROFILE_EXCLUDED=pass\nBACKUP_EXCLUDE_PERMS=pass\nSQLITE_CONSISTENT_SNAPSHOT=%s\nSQLITE_RESTORE_INTEGRITY=%s\nSQLITE_RECOVERABLE_COUNT=%s\nBACKUP_TIMER_ENABLED=yes\nCF_BACKUP_PROOF_END\n' "$snapshot_id" "$sqlite_snapshot" "$sqlite_restore_integrity" "$sqlite_recoverable_count"
else
  rm -f "$source_manifest"
  restic forget --tag capability-fabric-personal-server --keep-last 3 --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >>"$log" 2>&1
  printf 'CF_BACKUP_RUN=success\nSNAPSHOT_ID=%s\n' "$snapshot_id"
fi
