#!/usr/bin/env bash
# Secret-free, source-pinned reconstruction of scoped CF WeChat media r264.
# CI assembly only. No live host/service operation.
set -Eeuo pipefail
snap="${1:?candidate snapshot path required}"
out="${2:?empty output directory required}"
[[ ! -e "$out" ]] || { echo "CF_R264_OUTPUT_NOT_EMPTY"; exit 11; }
base=qualification/onshape-fast-r12/a9f36e69dfb380fbde796a8d9a2eab831152403e
patch262=qualification/pcg-telegram-bridge/629875b4b6f1a5f7bdc17011d02834d13dfb8d51/cf-r262.patch
patch263=qualification/cf-asr-unified/e9779d35e1f34211817acd3d3441f44f5b9c80bf/cf-r263-unified.patch
printf '%s  %s\n' 63512175947dfbcf51e7ecc00986d3dada797026f6749d751239e82c8a6c8c83 "$patch262" | sha256sum -c -
printf '%s  %s\n' 3cd29b27e18a04e49aeae6f837ba1b7872409cee7bf6254d68ae91a69984e019 "$patch263" | sha256sum -c -
printf '%s  %s\n' 9346bfa3fb23d4ab23c62302c520f15c54181920fb49750bde66f395934494a2 "$snap/cf-r264-wechat-media.patch" | sha256sum -c -
cp -a "$base" "$out"
python3 - "$out" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]);m=json.loads((p/"manifest.json").read_text())
assert m["sequence"]==261 and len(m["files"])==29
assert m["files"]["server.js"]=="4db4142ce31d0af224c0d426780f1b9f99ea17b16ff5592d0ae2faabe6e5c80f"
for f,h in m["files"].items():
    assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,f
PY
patch --batch --fuzz=0 -p1 -d "$out" < "$patch262"
printf '%s  %s\n' 35c7d7f9f4f43822860f00e354106692f57d5ff3e5c4a52738dad623a5216f48 "$out/telegram-ingress.mjs" | sha256sum -c -
patch --batch --fuzz=0 -p1 -d "$out" < "$patch263"
printf '%s  %s\n' f218536dbedd2163cdb54c8a0523ccd16d87a7dbbf42060dad46bc52ffed7134 "$out/telegram-ingress.mjs" | sha256sum -c -
patch --batch --fuzz=0 -p1 -d "$out" < "$snap/cf-r264-wechat-media.patch"
for f in wechat-media-tools.mjs wechat_media_cache_adapter_v1.mjs wechat-material-download-bridge.mjs; do
  cp "$snap/$f" "$out/$f"
done
cp "$snap/manifest.json" "$snap/release-closure.json" "$out/"
python3 - "$out" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]);m=json.loads((p/"manifest.json").read_text())
c=json.loads((p/"release-closure.json").read_text())
assert m["sequence"]==264 and m["release_id"]=="onshape-vps-fast-r100-direct-orbit1-paa-storage-r264-wechat-media1"
assert c["build_id"]==m["release_id"] and set(c["files"])==set(m["files"]) and len(m["files"])==32
assert set(f.name for f in p.iterdir())==set(m["files"])|{"manifest.json"}
for f,h in m["files"].items():
    file=p/f
    assert file.is_file() and not file.is_symlink()
    assert hashlib.sha256(file.read_bytes()).hexdigest()==h,f
assert m["files"]["telegram-ingress.mjs"]=="f218536dbedd2163cdb54c8a0523ccd16d87a7dbbf42060dad46bc52ffed7134"
assert b'cfAudioTraceBridge' not in (p/"server.js").read_bytes()
print("CF_R264_EXACT_32_FILES_SOURCE_HASH_PASS")
PY
for f in server.js telegram-ingress.mjs wechat-preload.mjs wechat-media-tools.mjs wechat_media_cache_adapter_v1.mjs wechat-material-download-bridge.mjs; do
  node --check "$out/$f"
done
UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 --max-old-space-size=128 --test-concurrency=1 --test "$snap/test_wechat_media_tools_r264_public.mjs"
if [[ "${CI:-}" == true ]]; then
  docker compose -f "$out/compose.yaml" config --quiet
fi
tar -czf "${out}.tgz" -C "$out" .
echo "CF_R264_SECRET_FREE_RELEASE_QUALIFIED"
