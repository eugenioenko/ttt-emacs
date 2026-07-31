#!/usr/bin/env bash
# Ensure a ttt binary exists at .ttt-bin/ttt for the test harness.
#
# Resolution order:
#   1. TTT_BIN=<path>       — use an existing binary as-is.
#   2. ../ttt (sibling)     — a local ttt checkout: build it in place.
#   3. clone ttt @ TTT_REF  — clone the repo and build (TTT_REF default: main).
#
# The Vim plugin requires ttt with plugin API v2 (the 1.1.0 line). Building from
# source guarantees the binary matches whatever ttt ref you point at, with no
# dependency on a published release.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/.ttt-bin"
BIN="$BIN_DIR/ttt"
TTT_REF="${TTT_REF:-main}"
TTT_URL="${TTT_URL:-https://github.com/eugenioenko/ttt.git}"

mkdir -p "$BIN_DIR"

build_into() {
  # $1 = source dir with a Makefile producing bin/ttt
  ( cd "$1" && make build )
  cp "$1/bin/ttt" "$BIN"
  chmod +x "$BIN"
}

if [[ -n "${TTT_BIN:-}" ]]; then
  echo "prepare-ttt: using TTT_BIN=$TTT_BIN"
  cp "$TTT_BIN" "$BIN"
  chmod +x "$BIN"
elif [[ -d "$REPO_ROOT/../ttt/.git" ]]; then
  echo "prepare-ttt: building sibling ../ttt"
  build_into "$REPO_ROOT/../ttt"
else
  SRC="$REPO_ROOT/.ttt-src"
  if [[ -d "$SRC/.git" ]]; then
    echo "prepare-ttt: updating $SRC to $TTT_REF"
    git -C "$SRC" fetch --depth 1 origin "$TTT_REF"
    git -C "$SRC" checkout -q FETCH_HEAD
  else
    echo "prepare-ttt: cloning $TTT_URL @ $TTT_REF"
    git clone --depth 1 --branch "$TTT_REF" "$TTT_URL" "$SRC" 2>/dev/null \
      || git clone --depth 1 "$TTT_URL" "$SRC"
  fi
  build_into "$SRC"
fi

echo "prepare-ttt: ready -> $BIN ($("$BIN" --version 2>/dev/null || echo '??'))"
