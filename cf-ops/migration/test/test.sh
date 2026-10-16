#!/bin/bash
export CF_MIGRATE_FORCE_OBSOLETE=1
cd /data/mig; export PATH=/data/mig/stubs:$PATH CF_MIG_PAA_UID=1000 CF_MIG_PAA_GID=1000
snap(){ (cd $1 && find . -path ./var/backups -prune -o -path ./state -prune -o -name stub.log -prune -o -print | sort | while read f; do if [ -L "$f" ]; then echo "$f -> $(readlink $f)"; elif [ -f "$f" ]; then echo "$f $(md5sum < $f)"; else echo "$f/"; fi; done); }
pass=0; fail=0; chk(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
F=/data/mig/fx; export CF_MIG_ROOT=$F
# 1 dry run changes nothing
./mkfix.sh $F; snap $F > /tmp/a; ./cfserver_migrate.sh > /tmp/dry.log 2>&1; rc=$?; snap $F > /tmp/b
chk "dry rc0" "[ $rc = 0 ]"; chk "dry no change" "cmp -s /tmp/a /tmp/b"; chk "dry lists units" "grep -q 'paa-remote.service.d/override.conf' /tmp/dry.log"; chk "dry no backup" "[ ! -d $F/var/backups ]"
chk "dry finds atjobs" "grep -c 'a cfop_e79aa1fde5\|a paa_remote' /tmp/dry.log | grep -q 2"
# 2 apply success
./mkfix.sh $F; snap $F > /tmp/orig; ./cfserver_migrate.sh --apply --skip-wait > /tmp/apply.log 2>&1; rc=$?
chk "apply rc0" "[ $rc = 0 ]"; chk "apply result" "grep -q RESULT=MIGRATED /tmp/apply.log"
chk "passwd renamed" "grep -q '^cfserver:x:1000:1000::/home/cfserver:' $F/etc/passwd && ! grep -q cfop_e79aa1fde5 $F/etc/passwd"
chk "paa deleted" "! grep -q paa_remote $F/etc/passwd $F/etc/group $F/etc/shadow"
chk "group/shadow/sub" "grep -q '^cfserver:x:1000' $F/etc/group && grep -q '^cfserver:' $F/etc/shadow && grep -q '^cfserver:' $F/etc/subuid $F/etc/subgid && grep -q 'sudo:x:27:cfop' $F/etc/group"
chk "home+symlink" "[ -f $F/home/cfserver/.config/a ] && [ \"\$(readlink $F/home/cfop_e79aa1fde5)\" = /home/cfserver ]"
chk "units edited" "! grep -rq 'cfop_e79aa1fde5\|paa_remote' $F/etc/systemd/system $F/run/systemd/system && grep -q 'User=cfserver' $F/etc/systemd/system/capability-fabric-paa-remote.service && grep -q '\-g cfserver' $F/etc/systemd/system/capability-fabric-paa-publisher.service"
chk "paths kept" "grep -q 'WorkingDirectory=/var/lib/capability-fabric/paa-remote' $F/etc/systemd/system/capability-fabric-paa-remote.service"
chk "other unit untouched" "grep -q www-data $F/etc/systemd/system/other.service"
chk "attended_auth" "grep -q '^owner=cfserver$' $F/usr/local/lib/capability-fabric/pcg-provider-runtime/attended_auth.sh && grep -q cfop_e79aa1fde5x $F/usr/local/lib/capability-fabric/pcg-provider-runtime/attended_auth.sh"
chk "exec script edited" "grep -q 'run as cfserver' $F/var/lib/capability-fabric/paa-remote/run.sh"
chk "cron+accounts" "[ -f $F/var/spool/cron/crontabs/cfserver ] && [ -f $F/var/lib/AccountsService/users/cfserver ]"
chk "atrm only user jobs" "grep -q '^atrm 5' $F/stub.log && grep -q '^atrm 7' $F/stub.log && ! grep -q '^atrm 9' $F/stub.log"
chk "units running" "ls $F/state | grep -q paa-remote && [ \$(ls $F/state | wc -l) = 9 ]"
chk "chown done" "grep -q '^chown -h 1000' $F/stub.log"
B=$(ls -d $F/var/backups/cf-migrate-*); chk "backup perms" "[ \"\$(stat -c %a $B)\" = 700 ]"
# 3 re-run refuses
./cfserver_migrate.sh --apply --skip-wait > /tmp/rerun.log 2>&1; rc=$?
chk "rerun refuses" "[ $rc = 1 ] && grep -q 'preflight failed' /tmp/rerun.log && [ \$(ls -d $F/var/backups/* | wc -l) = 1 ]"
# 4 manual rollback restores original
./cfserver_migrate.sh --rollback $B > /tmp/rb.log 2>&1; snap $F > /tmp/after_rb
chk "manual rollback restores" "diff <(grep -v '^./atq.txt' /tmp/orig) <(grep -v '^./atq.txt' /tmp/after_rb) >/tmp/rbdiff; [ \$? = 0 ] || [ \"\$(grep -c '^[<>]' /tmp/rbdiff)\" = 0 ]"
cat /tmp/rbdiff | head
# 5 failure at start -> auto rollback
./mkfix.sh $F; snap $F > /tmp/orig; FAIL_START=capability-fabric-pcg-wechat ./cfserver_migrate.sh --apply --skip-wait > /tmp/fail.log 2>&1; rc=$?; snap $F > /tmp/after
chk "fail rc1" "[ $rc = 1 ] && grep -q RESULT=ROLLED_BACK /tmp/fail.log"
chk "fail restored" "diff /tmp/orig /tmp/after > /tmp/fdiff"; head /tmp/fdiff
# 6 failure in verify (unit not active) -> rollback
./mkfix.sh $F; snap $F > /tmp/orig; cat > /tmp/sys_wrap <<'W'
W
FAIL_START=capability-fabric-paa-remote ./cfserver_migrate.sh --apply --skip-wait > /tmp/fail2.log 2>&1; rc=$?; snap $F > /tmp/after
chk "paa start fail -> rollback" "[ $rc = 1 ] && diff -q /tmp/orig /tmp/after >/dev/null"
# 7 --paa-remote=stop leaves paa-remote stopped
./mkfix.sh $F; ./cfserver_migrate.sh --apply --skip-wait --paa-remote=stop > /tmp/s.log 2>&1; rc=$?
chk "paa stop option" "[ $rc = 0 ] && ! ls $F/state | grep -q paa-remote"
echo "pass=$pass fail=$fail"
