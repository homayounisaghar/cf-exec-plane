#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

base="https://cad.onshape.com"
bad_css="/woolsthorpe.7f95d72295eac931d1a1.css"
good_css="/css/woolsthorpe.13481957980a2224d15a.css"
loader_js="/js/css/woolsthorpe.c854d13adb30d3f56bff.js"
main_js="/js/woolsthorpe.9d9c76e77e0b13fc5145.js"

tmp="$(mktemp -d /root/.cf-onshape-static-proof.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

probe_headers() {
  local label="$1" path="$2"
  local headers="$tmp/$label.headers"
  curl -sS --max-time 20 -D "$headers" -o /dev/null "$base$path"
  local status content_type location etag
  status="$(awk 'toupper($1) ~ /^HTTP\// {s=$2} END{print s}' "$headers")"
  content_type="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {sub(/^[^:]*:[[:space:]]*/,""); gsub(/\r/,""); v=$0} END{print v}' "$headers")"
  location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/^[^:]*:[[:space:]]*/,""); gsub(/\r/,""); v=$0} END{print v}' "$headers")"
  etag="$(awk 'BEGIN{IGNORECASE=1} /^etag:/ {sub(/^[^:]*:[[:space:]]*/,""); gsub(/\r/,""); v=$0} END{print v}' "$headers")"
  printf 'CF_ONSHAPE_STATIC_%s_STATUS=%s\n' "$label" "$status"
  printf 'CF_ONSHAPE_STATIC_%s_CONTENT_TYPE=%s\n' "$label" "$content_type"
  printf 'CF_ONSHAPE_STATIC_%s_LOCATION=%s\n' "$label" "$location"
  printf 'CF_ONSHAPE_STATIC_%s_ETAG=%s\n' "$label" "$etag"
}

probe_headers BAD_CSS "$bad_css"
probe_headers GOOD_CSS "$good_css"

curl -sS --fail --max-time 30 "$base/documents" -o "$tmp/documents.html"
curl -sS --fail --max-time 30 "$base$loader_js" -o "$tmp/loader.js"
curl -sS --fail --max-time 30 "$base$main_js" -o "$tmp/main.js"

if grep -Fq '7f95d72295eac931d1a1' "$tmp/documents.html"; then
  echo 'CF_ONSHAPE_STATIC_DOCUMENTS_REFERENCES_BAD_HASH=yes'
else
  echo 'CF_ONSHAPE_STATIC_DOCUMENTS_REFERENCES_BAD_HASH=no'
fi
if grep -Fq '/woolsthorpe.7f95d72295eac931d1a1.css' "$tmp/documents.html"; then
  echo 'CF_ONSHAPE_STATIC_DOCUMENTS_REFERENCES_BAD_PATH=yes'
else
  echo 'CF_ONSHAPE_STATIC_DOCUMENTS_REFERENCES_BAD_PATH=no'
fi
printf 'CF_ONSHAPE_STATIC_DOCUMENTS_SHA256=%s\n' "$(sha256sum "$tmp/documents.html" | awk '{print $1}')"

if grep -Fq '7f95d72295eac931d1a1' "$tmp/loader.js"; then
  echo 'CF_ONSHAPE_STATIC_LOADER_REFERENCES_BAD_HASH=yes'
else
  echo 'CF_ONSHAPE_STATIC_LOADER_REFERENCES_BAD_HASH=no'
fi
if grep -Fq '7f95d72295eac931d1a1' "$tmp/main.js"; then
  echo 'CF_ONSHAPE_STATIC_MAIN_REFERENCES_BAD_HASH=yes'
else
  echo 'CF_ONSHAPE_STATIC_MAIN_REFERENCES_BAD_HASH=no'
fi
if grep -Fq '13481957980a2224d15a' "$tmp/loader.js"; then
  echo 'CF_ONSHAPE_STATIC_LOADER_REFERENCES_GOOD_HASH=yes'
else
  echo 'CF_ONSHAPE_STATIC_LOADER_REFERENCES_GOOD_HASH=no'
fi
printf 'CF_ONSHAPE_STATIC_LOADER_SHA256=%s\n' "$(sha256sum "$tmp/loader.js" | awk '{print $1}')"
printf 'CF_ONSHAPE_STATIC_MAIN_SHA256=%s\n' "$(sha256sum "$tmp/main.js" | awk '{print $1}')"


python3 - "$tmp/main.js" <<'PY'
import json,sys
p=sys.argv[1]
data=open(p,"r",encoding="utf-8",errors="replace").read()
pos=4605173
lo=max(0,pos-1200)
hi=min(len(data),pos+1200)
print("CF_ONSHAPE_STATIC_MAIN_LENGTH="+str(len(data)))
print("CF_ONSHAPE_STATIC_ERROR_OFFSET_IN_RANGE="+("yes" if pos < len(data) else "no"))
print("CF_ONSHAPE_STATIC_ERROR_CONTEXT="+json.dumps(data[lo:hi],ensure_ascii=True,separators=(",",":")))
tail=data[-1000:]
print("CF_ONSHAPE_STATIC_MAIN_HAS_SOURCEMAP="+("yes" if "sourceMappingURL=" in tail else "no"))
PY
