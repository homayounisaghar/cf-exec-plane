# ---- test stubs ----
install() { local a=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; command install "${a[@]}"; }
visudo() { [[ -f /tmp/fr/visudo_fail ]] && return 1; return 0; }
command() { if [[ "$1" == -v && "$2" == visudo ]]; then return 0; fi; builtin command "$@"; }
systemctl() {
  echo "STUB systemctl $*" >> /tmp/fr/calls.log
  case "$1" in
    show) echo 4242;;
    restart) for p in $(ps -eo pid,args | awk '$2=="python3" && $3 ~ /fr\/root.*cf_ops_agent.py$/ {print $1}'); do kill "$p"; done; sleep 0.3
      rm -f /tmp/fr/root/var/lib/capability-fabric/cf-ops-run/agent.sock
      [[ -f /tmp/fr/agent_fail ]] && return 0
      (CF_OPS_STATE=/tmp/fr/root/var/lib/capability-fabric/cf-ops CF_OPS_SOCKET=/tmp/fr/root/var/lib/capability-fabric/cf-ops-run/agent.sock CF_OPS_ALLOWED_UIDS=$(id -u) setsid python3 /tmp/fr/root/usr/local/lib/capability-fabric/cf-ops/cf_ops_agent.py >> /tmp/fr/agent.log 2>&1 &);;
    *) :;;
  esac; return 0; }
# ---- end stubs ----
