#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) distro="$ID" ;;
  *) echo "unsupported distribution for Docker repository: ${ID:-unknown}" >&2; exit 2 ;;
esac

if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "cgroup v2 is not active; refusing runtime installation until corrected" >&2
  exit 3
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL "https://download.docker.com/linux/${distro}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
arch="$(dpkg --print-architecture)"
codename="${VERSION_CODENAME:-}"
[[ -n "$codename" ]] || { echo "VERSION_CODENAME missing" >&2; exit 4; }
repo_line="deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} ${codename} stable"
if [[ ! -f /etc/apt/sources.list.d/docker.list ]] || [[ "$(cat /etc/apt/sources.list.d/docker.list)" != "$repo_line" ]]; then
  printf '%s\n' "$repo_line" > /etc/apt/sources.list.d/docker.list
fi
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json.new <<'JSON'
{
  "log-driver": "local"
}
JSON
if [[ ! -f /etc/docker/daemon.json ]] || ! cmp -s /etc/docker/daemon.json.new /etc/docker/daemon.json; then
  mv /etc/docker/daemon.json.new /etc/docker/daemon.json
  systemctl restart docker
else
  rm -f /etc/docker/daemon.json.new
fi
systemctl enable --now docker

install -d -m 0755 /opt/capability-fabric
install -d -m 0755 /var/lib/capability-fabric
install -d -m 0755 /var/lib/capability-fabric/releases
install -d -m 0755 /var/backups/capability-fabric
install -d -m 0755 /etc/capability-fabric
install -d -m 0700 /etc/capability-fabric/secrets
install -d -m 0755 /etc/capability-fabric/trust
chown -R 0:0 /opt/capability-fabric /var/lib/capability-fabric /var/backups/capability-fabric /etc/capability-fabric

cgroup_version="$(docker info --format '{{.CgroupVersion}}')"
[[ "$cgroup_version" == "2" ]] || { echo "Docker is not using cgroup v2" >&2; exit 5; }

printf 'CF_DOCKER_BEGIN\n'
printf 'DOCKER_VERSION=%s\n' "$(docker version --format '{{.Server.Version}}')"
printf 'COMPOSE_VERSION=%s\n' "$(docker compose version --short)"
printf 'CGROUP_VERSION=%s\n' "$cgroup_version"
printf 'DOCKER_LOG_DRIVER=%s\n' "$(docker info --format '{{.LoggingDriver}}')"
printf 'CF_DOCKER_END\n'
