#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist}"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|aarch64) ;;
  *) echo "Unsupported target architecture: $ARCH" >&2; exit 2 ;;
esac

command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 || {
  echo "Install g++ or clang++ in the local Linux/WSL environment." >&2
  exit 2
}
command -v pkg-config >/dev/null 2>&1 && pkg-config --exists openssl || {
  echo "Install the OpenSSL development package in the local Linux/WSL environment." >&2
  exit 2
}

if command -v g++ >/dev/null 2>&1; then CXX="${CXX:-g++}"; else CXX="${CXX:-clang++}"; fi
STAGE="$OUT_DIR/steam-speed"
mkdir -p "$STAGE"
rm -f "$STAGE/steam-speed"

"$CXX" -O2 -std=c++17 -Wall -Wextra -Wpedantic \
  -ffunction-sections -fdata-sections \
  -o "$STAGE/steam-speed" "$ROOT_DIR/src/main.cpp" \
  -Wl,--gc-sections -s -pthread $(pkg-config --cflags --libs openssl)

"$STAGE/steam-speed" --self-test
install -m 0755 "$ROOT_DIR/install.sh" "$STAGE/install.sh"
install -m 0755 "$ROOT_DIR/uninstall.sh" "$STAGE/uninstall.sh"

PACKAGE="$OUT_DIR/steam-speed-linux-$ARCH.tar.gz"
tar -C "$OUT_DIR" -czf "$PACKAGE" steam-speed
chmod 0644 "$PACKAGE"
echo "Built package: $PACKAGE"
echo "Architecture: $ARCH"
ldd "$STAGE/steam-speed"
