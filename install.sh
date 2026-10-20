#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=/opt/steam-speed
CONFIG_DIR=/etc/steam-speed
ENV_FILE=$CONFIG_DIR/steam-speed.env
UNIT_FILE=/etc/systemd/system/steam-speed.service
PORT=8467
BIND_HOST=0.0.0.0
DOMAIN=
KEY=
ROTATE_KEY=0

log() { printf '[steam-speed] %s\n' "$*"; }
warn() { printf '[steam-speed] WARNING: %s\n' "$*" >&2; }
die() { printf '[steam-speed] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [options]
  --domain HOST       ESA acceleration domain, e.g. steam.example.com
  --port PORT         Local HTTP origin port (default: 8467)
  --bind ADDRESS      Listen address (default: 0.0.0.0)
  --key HEX           Use an existing 64-character hexadecimal key
  --rotate-key        Generate a new key and restart

This installer only installs a prebuilt Linux binary. Build it locally with
build-local.sh; no compiler or source download is used on the server.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) [[ $# -ge 2 ]] || die "--domain needs a value"; DOMAIN=$2; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port needs a value"; PORT=$2; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || die "--bind needs a value"; BIND_HOST=$2; shift 2 ;;
    --key) [[ $# -ge 2 ]] || die "--key needs a value"; KEY=$2; shift 2 ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root"
command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] || die "systemd is required"

if [[ -z "$DOMAIN" && -t 0 ]]; then
  read -r -p "ESA acceleration domain (leave blank to fill later): " DOMAIN
fi
DOMAIN=${DOMAIN#http://}
DOMAIN=${DOMAIN#https://}
DOMAIN=${DOMAIN%%/*}
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then die "Invalid domain"; fi
if [[ -n "$DOMAIN" && "$DOMAIN" != *.* ]]; then die "Domain must contain a dot"; fi
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Invalid port"
PORT=$((10#$PORT))
[[ $PORT -ge 1 && $PORT -le 65535 ]] || die "Invalid port"
[[ "$BIND_HOST" =~ ^[A-Za-z0-9:._-]+$ ]] || die "Invalid bind address"
[[ -z "$KEY" || "$KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "Key must be 64 hexadecimal characters"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -x "$SCRIPT_DIR/steam-speed" ]] || die "Prebuilt steam-speed binary missing; build locally and upload the release package"
[[ -f "$SCRIPT_DIR/uninstall.sh" ]] || die "uninstall.sh missing from release package"

if ! getent group steam-speed >/dev/null 2>&1; then
  groupadd --system steam-speed
fi
if ! id steam-speed >/dev/null 2>&1; then
  useradd --system --gid steam-speed --home-dir /nonexistent --shell /usr/sbin/nologin steam-speed
fi

if [[ -z "$KEY" && $ROTATE_KEY -eq 0 && -f "$ENV_FILE" ]]; then
  KEY=$(sed -n 's/^SECRET_KEY=//p' "$ENV_FILE" | head -n 1)
fi
if [[ -z "$KEY" ]]; then
  if command -v openssl >/dev/null 2>&1; then KEY=$(openssl rand -hex 32)
  else KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  fi
fi
[[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "Could not generate a valid key"
KEY=$(printf '%s' "$KEY" | tr 'A-F' 'a-f')

"$SCRIPT_DIR/steam-speed" --self-test
systemctl stop steam-speed.service >/dev/null 2>&1 || true
install -d -m 0755 "$INSTALL_DIR/bin"
install -d -m 0750 "$CONFIG_DIR"
install -m 0755 "$SCRIPT_DIR/steam-speed" "$INSTALL_DIR/bin/steam-speed"
install -m 0755 "$SCRIPT_DIR/install.sh" "$INSTALL_DIR/install.sh"
install -m 0755 "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/uninstall.sh"

if command -v timedatectl >/dev/null 2>&1; then timedatectl set-ntp true >/dev/null 2>&1 || true; fi

if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$" {found=1} END {exit !found}'; then
  die "Port $PORT is already in use"
fi

cat > "$ENV_FILE" <<EOF
SECRET_KEY=$KEY
BIND_HOST=$BIND_HOST
PORT=$PORT
PUBLIC_SCHEME=https
PUBLIC_HOST=$DOMAIN
UPSTREAM_TIMEOUT_MS=20000
TRUST_PROXY=1
LOG_REQUESTS=1
MAX_CONNECTIONS=128
RATE_LIMIT_PER_MINUTE=240
RATE_LIMIT_GLOBAL_PER_MINUTE=2400
EOF
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

cat > "$UNIT_FILE" <<'EOF'
[Unit]
Description=Steam Speed Service (authenticated reverse proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=steam-speed
Group=steam-speed
EnvironmentFile=/etc/steam-speed/steam-speed.env
ExecStart=/opt/steam-speed/bin/steam-speed
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=true
LockPersonality=true
UMask=0077
LimitNOFILE=4096
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now steam-speed.service

if [[ "$BIND_HOST" != 127.0.0.1 && "$BIND_HOST" != ::1 ]]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$PORT/tcp" >/dev/null || true; fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null || true
    firewall-cmd --reload >/dev/null || true
  fi
fi

CHECK_HOST=$BIND_HOST
[[ "$CHECK_HOST" == 0.0.0.0 ]] && CHECK_HOST=127.0.0.1
[[ "$CHECK_HOST" == :: ]] && CHECK_HOST='[::1]'
[[ "$CHECK_HOST" == *:* && "$CHECK_HOST" != \[*\] ]] && CHECK_HOST="[$CHECK_HOST]"
ready=0
for _ in $(seq 1 20); do
  code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "http://$CHECK_HOST:$PORT/" 2>/dev/null || true)
  if [[ "$code" == 500 ]]; then ready=1; break; fi
  sleep 0.25
done
if [[ $ready -ne 1 ]]; then
  warn "Service did not answer on $CHECK_HOST:$PORT"
  journalctl -u steam-speed -n 30 --no-pager >&2 || true
fi

PUBLIC_IP=$(curl --noproxy '*' -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
PUBLIC_HOST_DISPLAY=${DOMAIN:-'<your-esa-domain>'}
PUBLIC_URL="https://$PUBLIC_HOST_DISPLAY"
ORIGIN_URL="http://${PUBLIC_IP:-<server-public-ip>}:$PORT"
CLIENT_FILE=/root/steam-speed-client.txt
cat > "$CLIENT_FILE" <<EOF
加速服务域名: $PUBLIC_URL
加速服务密钥: $KEY

Koishi 插件配置:
enableSteamSpeed: true
steamSpeedDomain: $PUBLIC_URL
steamSpeedKey: $KEY

回源地址: $ORIGIN_URL
监听地址: $BIND_HOST:$PORT
EOF
chmod 0600 "$CLIENT_FILE"

cat <<EOF

Steam 加速服务已部署
回源监听:       $BIND_HOST:$PORT
回源地址:       $ORIGIN_URL
ESA 加速域名:   $PUBLIC_URL
加速服务密钥:   $KEY

Koishi 插件配置:
  enableSteamSpeed: true
  steamSpeedDomain: $PUBLIC_URL
  steamSpeedKey: $KEY

配置副本: $CLIENT_FILE (mode 600)
ESA 源站协议选 HTTP，并放行 TCP $PORT；确保透传 User-Agent。
状态: systemctl status steam-speed
日志: journalctl -u steam-speed -f
EOF

if [[ -n "$DOMAIN" ]]; then
  external=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 8 "$PUBLIC_URL/" 2>/dev/null || true)
  [[ "$external" == 500 ]] || warn "ESA check returned ${external:-000}; configure the ESA origin if not ready"
fi
