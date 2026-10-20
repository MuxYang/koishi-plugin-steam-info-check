#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
readonly INSTALL_DIR=/opt/steam-speed
readonly CONFIG_DIR=/etc/steam-speed
readonly UNIT_FILE=/etc/systemd/system/steam-speed.service

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Remove steam-speed service, binary, config, and key? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 0
fi

systemctl disable --now steam-speed.service >/dev/null 2>&1 || true
rm -f "$UNIT_FILE"
systemctl daemon-reload

rm -rf "$INSTALL_DIR"
rm -rf "$CONFIG_DIR"
rm -f /root/steam-speed-client.txt

if id -u steam-speed >/dev/null 2>&1; then
  userdel steam-speed >/dev/null 2>&1 || true
fi
if grep -q '^steam-speed:' /etc/group 2>/dev/null; then
  if command -v groupdel >/dev/null 2>&1; then
    groupdel steam-speed >/dev/null 2>&1 || true
  elif command -v delgroup >/dev/null 2>&1; then
    delgroup steam-speed >/dev/null 2>&1 || true
  fi
fi

echo "steam-speed removed."
