#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="$HOME/.local/share/cf-mirror-universal"
BIN="$HOME/.local/bin"
mkdir -p "$DEST" "$BIN" "$HOME/.cache/cf-mirror-universal"
install -m 0700 "$BASE/cf-mirror-universal.mjs" "$DEST/cf-mirror-universal.mjs"
install -m 0700 "$BASE/runtime.mjs" "$DEST/runtime.mjs"
install -m 0600 "$BASE/viewer.html" "$DEST/viewer.html"
install -m 0600 "$BASE/surface.html" "$DEST/surface.html"
install -m 0600 "$BASE/cf-mirror-mcp-tools.mjs" "$DEST/cf-mirror-mcp-tools.mjs"
if [ -e "$BIN/cf-mirror-any" ] && [ ! -L "$BIN/cf-mirror-any" ]; then
  echo "Refusing to overwrite a non-symlink: $BIN/cf-mirror-any" >&2
  exit 2
fi
ln -sfn "$DEST/cf-mirror-universal.mjs" "$BIN/cf-mirror-any"
printf 'Installed: %s\n' "$BIN/cf-mirror-any"
"$BIN/cf-mirror-any" status
