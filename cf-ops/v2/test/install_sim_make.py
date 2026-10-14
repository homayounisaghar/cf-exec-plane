import sys, re
src = open('/data/cfops_r251/v2fix/install.sh').read()
F = '/tmp/fr/root'
rep = {
 '[[ "$(id -u)" -eq 0 ]] || { echo "FAIL root_required"; exit 30; }': ':',
 'user="$(getent passwd 1000 | cut -d: -f1)"': 'user="$(id -un)"',
 'lib=/usr/local/lib/capability-fabric/cf-ops': f'lib={F}/usr/local/lib/capability-fabric/cf-ops',
 'state=/var/lib/capability-fabric/cf-ops\n': f'state={F}/var/lib/capability-fabric/cf-ops\n',
 'run=/var/lib/capability-fabric/cf-ops-run': f'run={F}/var/lib/capability-fabric/cf-ops-run',
 'unit=/etc/systemd/system/capability-fabric-cf-ops.service': f'unit={F}/etc/systemd/system/capability-fabric-cf-ops.service',
 'envf=/etc/capability-fabric/cf-ops.env': f'envf={F}/etc/capability-fabric/cf-ops.env',
 'wrapper=/usr/local/sbin/cf-admin-exec': f'wrapper={F}/usr/local/sbin/cf-admin-exec',
 'sudoers=/etc/sudoers.d/cf-admin': f'sudoers={F}/etc/sudoers.d/cf-admin',
 'bk="/var/lib/capability-fabric/cf-ops-backup/': f'bk="{F}/var/lib/capability-fabric/cf-ops-backup/',
 '/var/lib/capability-fabric/cf-admin /var/log/cf-admin': f'{F}/var/lib/capability-fabric/cf-admin {F}/var/log/cf-admin',
 'for b in /usr/bin/systemd-run /usr/bin/systemctl /usr/bin/timeout /bin/bash;': 'for b in /bin/bash;',
}
for a, b in rep.items():
    assert a in src, a
    src = src.replace(a, b)
stubs = open('/tmp/fr/stubs.sh').read()
src = src.replace('set -euo pipefail\n', 'set -euo pipefail\n' + stubs, 1)
open('/tmp/fr/install_test.sh', 'w').write(src)
