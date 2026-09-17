#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) distro="$ID" ;;
  *) echo "unsupported distribution for Docker official repository: ${ID:-unknown}" >&2; exit 2 ;;
esac

if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "cgroup v2 is not active; refusing runtime installation until corrected" >&2
  exit 3
fi

# Phase 3 must not mutate apt sources/packages until the Docker-owned repository
# proves this exact distribution codename+architecture is published with all
# required stable packages. Phase 2 installs curl+ca-certificates as prerequisites.
command -v curl >/dev/null 2>&1 || { echo "PHASE3_PREREQ_MISSING: curl is required for read-only Docker repository preflight" >&2; exit 6; }
command -v gzip >/dev/null 2>&1 || { echo "PHASE3_PREREQ_MISSING: gzip is required for read-only Docker repository preflight" >&2; exit 6; }

arch="$(dpkg --print-architecture)"
codename="${VERSION_CODENAME:-}"
[[ -n "$codename" ]] || { echo "VERSION_CODENAME missing" >&2; exit 4; }
repo_base="https://download.docker.com/linux/${distro}"
release_url="${repo_base}/dists/${codename}/Release"
packages_url="${repo_base}/dists/${codename}/stable/binary-${arch}/Packages.gz"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

if ! curl -fsSL --retry 2 --connect-timeout 10 "$release_url" -o "$tmpdir/Release"; then
  echo "DOCKER_OFFICIAL_REPO_UNAVAILABLE: no official Docker Release metadata for distro=${distro} codename=${codename}; no Docker apt/source mutation performed" >&2
  exit 20
fi
if ! curl -fsSL --retry 2 --connect-timeout 10 "$packages_url" -o "$tmpdir/Packages.gz"; then
  echo "DOCKER_OFFICIAL_REPO_UNAVAILABLE: no official Docker stable package index for distro=${distro} codename=${codename} arch=${arch}; no Docker apt/source mutation performed" >&2
  exit 20
fi

gzip -cd "$tmpdir/Packages.gz" > "$tmpdir/Packages"
for pkg in docker-ce docker-ce-cli containerd.io docker-compose-plugin; do
  if ! grep -Fxq "Package: $pkg" "$tmpdir/Packages"; then
    echo "DOCKER_OFFICIAL_REPO_INCOMPLETE: required package $pkg is absent for distro=${distro} codename=${codename} arch=${arch}; no Docker apt/source mutation performed" >&2
    exit 21
  fi
done

printf 'CF_DOCKER_PREFLIGHT_BEGIN\n'
printf 'DISTRO=%s\n' "$distro"
printf 'CODENAME=%s\n' "$codename"
printf 'ARCH=%s\n' "$arch"
printf 'OFFICIAL_DOCKER_REPO=available\n'
printf 'REQUIRED_PACKAGES=available\n'
printf 'CF_DOCKER_PREFLIGHT_END\n'

# Only the official Docker repository passed the read-only gate. Mutations start here.
export DEBIAN_FRONTEND=noninteractive
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "${repo_base}/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
repo_line="deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] ${repo_base} ${codename} stable"
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
