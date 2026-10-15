#!/bin/bash
F=$1; rm -rf $F; mkdir -p $F/etc/systemd/system $F/run/systemd/system/capability-fabric-paa-remote.service.d $F/home/cfop_e79aa1fde5/.config $F/usr/local/lib/capability-fabric/pcg-provider-runtime $F/var/spool/cron/crontabs $F/var/spool/cron/atjobs $F/var/lib/AccountsService/users $F/var/lib/capability-fabric/paa-remote $F/etc/sudoers.d $F/tmp $F/var/tmp $F/proc/1/ns
cat > $F/etc/passwd <<P
root:x:0:0:root:/root:/bin/bash
cfop_e79aa1fde5:x:1000:1000::/home/cfop_e79aa1fde5:/bin/bash
paa_remote:x:1000:1000::/var/lib/capability-fabric/paa-remote:/bin/bash
cf-rvc:x:992:992::/nonexistent:/usr/sbin/nologin
P
printf 'root:*:1::::::\ncfop_e79aa1fde5:$6$x:1::::::\npaa_remote:!:1::::::\n' > $F/etc/shadow
printf 'root:x:0:\nsudo:x:27:cfop_e79aa1fde5\ncfop_e79aa1fde5:x:1000:\npaa_remote:x:1000:\n' > $F/etc/group
printf 'cfop_e79aa1fde5:!::\npaa_remote:!::\n' > $F/etc/gshadow
echo 'cfop_e79aa1fde5:100000:65536' > $F/etc/subuid; cp $F/etc/subuid $F/etc/subgid
for u in cf-ops pcg-wechat pcg-wechat-semantic pcg-browser@; do printf '[Service]\nUser=cfop_e79aa1fde5\nGroup=cfop_e79aa1fde5\nExecStart=/usr/bin/true\n' > "$F/etc/systemd/system/capability-fabric-$u.service"; done
printf '[Service]\nUser=paa_remote\nGroup=paa_remote\nExecStart=/var/lib/capability-fabric/paa-remote/run.sh\nWorkingDirectory=/var/lib/capability-fabric/paa-remote\n' > $F/etc/systemd/system/capability-fabric-paa-remote.service
printf '#!/bin/sh\n# run as paa_remote in /var/lib/capability-fabric/paa-remote\n' > $F/var/lib/capability-fabric/paa-remote/run.sh
printf '[Service]\nExecStartPre=/bin/install -d -o root -g paa_remote -m 0750 /run/capability-fabric\n' > $F/etc/systemd/system/capability-fabric-paa-publisher.service
printf '[Service]\nEnvironment=X=1\nUser=paa_remote\n' > $F/run/systemd/system/capability-fabric-paa-remote.service.d/override.conf
printf '[Service]\nUser=www-data\n' > $F/etc/systemd/system/other.service
printf '#!/bin/sh\nowner=cfop_e79aa1fde5\n# cfop_e79aa1fde5x must stay\n' > $F/usr/local/lib/capability-fabric/pcg-provider-runtime/attended_auth.sh
echo '#1000 ALL=(root) NOPASSWD: /usr/local/sbin/cf-admin-exec' > $F/etc/sudoers.d/cf-admin
echo '* * * * * true' > $F/var/spool/cron/crontabs/cfop_e79aa1fde5
echo 'x' > $F/var/lib/AccountsService/users/cfop_e79aa1fde5
echo 'hi' > $F/home/cfop_e79aa1fde5/.config/a
printf '5\tWed Oct 15 06:00:00 2026 a cfop_e79aa1fde5\n7\tWed Oct 15 06:00:00 2026 a paa_remote\n9\tWed Oct 15 06:00:00 2026 a root\n' > $F/atq.txt
