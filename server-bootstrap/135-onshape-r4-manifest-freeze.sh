#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
candidate_commit="243dbf162f3e20a63bef32c73263089fc29dfca9"
candidate_dir="server-deploy/candidates/onshape-vps-hardened-production-r4"
cache=/var/lib/capability-fabric/repo.git
token=/etc/capability-fabric/secrets/repo-read-token
home=/var/lib/capability-fabric/agent-home
[[ -s "$token" && -d "$cache" ]] || exit 20
tmp="$(mktemp -d /var/lib/capability-fabric/r4-manifest.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
askpass="$tmp/askpass"
cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) cat /etc/capability-fabric/secrets/repo-read-token ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 0700 "$askpass"
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 HOME="$home"   git --git-dir="$cache" fetch --quiet --force --depth=1 origin "$candidate_commit"
[[ "$(git --git-dir="$cache" rev-parse FETCH_HEAD)" == "$candidate_commit" ]]
mkdir "$tmp/release"
git --git-dir="$cache" archive "$candidate_commit" "$candidate_dir"   | tar -x -C "$tmp/release" --strip-components=3
python3 - "$tmp/release" <<'PY'
import base64,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
old=json.loads((root/"manifest.json").read_text())
files={}
for rel in old["files"]:
    p=root/rel
    if not p.is_file():
        raise SystemExit(f"missing closure file: {rel}")
    files[rel]=hashlib.sha256(p.read_bytes()).hexdigest()
out={
    "schema":old["schema"],
    "sequence":67,
    "release_id":"onshape-vps-hardened-production-r4",
    "compose_file":old["compose_file"],
    "health_file":old["health_file"],
    "health_timeout_seconds":old["health_timeout_seconds"],
    "files":files,
    "images":old["images"],
}
raw=(json.dumps(out,indent=2,sort_keys=False)+"\n").encode()
print("CF_R4_MANIFEST_SHA256="+hashlib.sha256(raw).hexdigest())
print("CF_R4_MANIFEST_B64="+base64.b64encode(raw).decode())
print("CF_R4_MANIFEST_FILE_COUNT="+str(len(files)))
print("CF_R4_MANIFEST_SEQUENCE=67")
print("CF_R4_MANIFEST_RELEASE_ID=onshape-vps-hardened-production-r4")
PY
echo CF_R4_MANIFEST_ACTIVE_RELEASE_UNCHANGED=yes
