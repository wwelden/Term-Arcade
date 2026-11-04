#!/usr/bin/env bash
# Build the site into web/public. Used as Vercel's build command; also works
# locally. Each game is fetched from its own repository at a pinned commit and
# compiled, unmodified, with Go's js/wasm target.
#
# If a new enough `go` is not on PATH (e.g. on Vercel), a pinned Go toolchain
# is downloaded into .go/ first.
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.26.2}"
GO_MIN_MINOR=25 # highest `go` directive among the games is 1.25

# name | repository | commit
GAMES="
tetris   https://github.com/wwelden/TermTetris   18a88a117c4bde82fc1e8c1fed825f961ed0e071
wordle   https://github.com/wwelden/TermWordle   3e450f1e4b6c83b9fa33c7a5c15af780f82ef8dd
connect4 https://github.com/wwelden/TermConnect4 f5a4d397b8a392d50609e428b14d4a16f1dfdc5d
"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/public/games"
cd "$ROOT"

go_is_new_enough() {
  command -v go >/dev/null 2>&1 || return 1
  local minor
  minor="$(go env GOVERSION | sed -E 's/^go1\.([0-9]+).*/\1/')"
  [ "${minor:-0}" -ge "$GO_MIN_MINOR" ]
}

if ! go_is_new_enough; then
  GO_DIR="$ROOT/.go"
  if [ ! -x "$GO_DIR/bin/go" ] || [ "$("$GO_DIR/bin/go" env GOVERSION)" != "go$GO_VERSION" ]; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)  platform=linux-amd64 ;;
      Linux-aarch64) platform=linux-arm64 ;;
      Darwin-arm64)  platform=darwin-arm64 ;;
      Darwin-x86_64) platform=darwin-amd64 ;;
      *) echo "error: no Go download for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
    echo "downloading go$GO_VERSION ($platform)..."
    rm -rf "$GO_DIR"
    mkdir -p "$GO_DIR"
    curl -fsSL --retry 2 "https://go.dev/dl/go$GO_VERSION.$platform.tar.gz" \
      | tar -xz -C "$GO_DIR" --strip-components=1
  fi
  export PATH="$GO_DIR/bin:$PATH"
fi

# Never let a go.mod silently switch to a different toolchain: wasm_exec.js
# below must come from the same Go that compiled the binaries.
export GOTOOLCHAIN=local
GOROOT="$(go env GOROOT)"
echo "using $(go env GOVERSION) from $GOROOT"

WASM_EXEC="$GOROOT/lib/wasm/wasm_exec.js"           # Go 1.24+
[ -f "$WASM_EXEC" ] || WASM_EXEC="$GOROOT/misc/wasm/wasm_exec.js"
cp "$WASM_EXEC" "$ROOT/web/public/wasm_exec.js"

rm -rf "$OUT"
mkdir -p "$OUT" "$ROOT/.games"

echo "$GAMES" | while read -r name repo commit; do
  [ -n "$name" ] || continue
  src="$ROOT/.games/$name"
  if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$commit" ]; then
    echo "fetching $name @ ${commit:0:7}..."
    rm -rf "$src"
    git init -q "$src"
    git -C "$src" fetch -q --depth 1 "$repo" "$commit"
    git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  echo "building $name..."
  (cd "$src" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$OUT/$name.wasm" .)
done

ls -l "$OUT"
