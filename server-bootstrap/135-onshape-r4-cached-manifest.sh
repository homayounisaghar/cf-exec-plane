#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" -eq 0 ]] || exit 2
cache=/var/lib/capability-fabric/repo.git
candidate_dir=server-deploy/candidates/onshape-vps-hardened-production-r4
expected_head=d109fd506af171a4829fdff5bbd1a3b1de07c5e9
[[ -d "$cache" ]] || exit 20
cache_head="$(git --git-dir="$cache" rev-parse refs/remotes/origin/main 2>/dev/null || true)"
echo CF_R4_CACHE_HEAD="$cache_head"
[[ "$cache_head" == "$expected_head" ]] || { echo CF_R4_CACHE_STALE=1 >&2; exit 21; }
tmp="$(mktemp -d /var/lib/capability-fabric/r4-freeze-cache.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/release"
git --git-dir="$cache" archive "$cache_head" "$candidate_dir"   | tar -x -C "$tmp/release" --strip-components=3
python3 - "$tmp/release" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
old=json.loads((root/"manifest.json").read_text())
files={}
for rel in old["files"]:
    p=root/rel
    if not p.is_file():
        raise SystemExit("missing:"+rel)
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
pretty=json.dumps(out,indent=2)+"\n"
print("CF_R4_MANIFEST_FILE_COUNT="+str(len(files)))
print("CF_R4_MANIFEST_SHA256="+hashlib.sha256(pretty.encode()).hexdigest())
print("CF_R4_MANIFEST_JSON="+json.dumps(out,separators=(",",":")))
print("CF_R4_MANIFEST_FREEZE=pass")
PY
