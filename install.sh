#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="md2-hub"
NODE_MAJOR="20"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
SERVER_DIR="$PROJECT_ROOT/Server"
RUN_USER="${SUDO_USER:-$USER}"

log() {
  printf '\n[installer] %s\n' "$*"
}

fail() {
  printf '\n[installer] ERROR: %s\n' "$*" >&2
  exit 1
}

section() {
  printf '\n== %s ==\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

print_help() {
  cat <<EOF
EscapeHub Installer

Usage:
  sudo bash install.sh
  sudo bash install.sh --core
  sudo bash install.sh --full
  bash install.sh --doctor

Options:
  --core      Install the core hub service, Node.js, npm packages, and Mosquitto.
  --full      Install everything currently automated. At the moment this is the
              same as --core; hardware setup is still intentionally manual.
  --doctor    Run diagnostics only. Does not change system state.
  --help      Show this help.

Hardware-specific setup for Zigbee, DMX/OLA, and audio is intentionally not
fully automated yet because it depends on the connected USB devices.
EOF
}

validate_project() {
  [[ -f "$SERVER_DIR/server.js" ]] || fail "Cannot find Server/server.js. Run this script from the EscapeHub repository."
  [[ -f "$SERVER_DIR/package.json" ]] || fail "Cannot find Server/package.json."
}

install_core() {
  validate_project

  if [[ "$(id -u)" -ne 0 ]]; then
    log "Core installation needs root privileges. Re-running through sudo."
    exec sudo bash "$0" --core
  fi

  log "Project root: $PROJECT_ROOT"
  log "Install user: $RUN_USER"

  log "Installing base packages"
  apt-get update
  apt-get install -y git curl ca-certificates python3 make g++ build-essential mosquitto mosquitto-clients

  local needs_node=1
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "$current_major" -ge "$NODE_MAJOR" ]]; then
      needs_node=0
    fi
  fi

  if [[ "$needs_node" -eq 1 ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    log "Node.js $(node -v) is already installed"
  fi

  require_command node
  require_command npm

  log "Node version: $(node -v)"
  log "npm version: $(npm -v)"

  log "Installing EscapeHub Node.js dependencies"
  cd "$SERVER_DIR"
  npm install

  log "Creating runtime directories"
  install -d -o "$RUN_USER" -g "$RUN_USER" "$PROJECT_ROOT/MediaStorage" "$PROJECT_ROOT/SoundStorage" "$PROJECT_ROOT/public/uploads"

  log "Configuring Mosquitto MQTT broker for local network puzzle clients"
  cat >"/etc/mosquitto/conf.d/escapehub.conf" <<EOF
# EscapeHub local puzzle network listener.
# This allows puzzle clients on the same trusted LAN to connect to MQTT.
listener 1883 0.0.0.0
allow_anonymous true
EOF

  systemctl enable --now mosquitto
  systemctl restart mosquitto

  local node_bin
  node_bin="$(command -v node)"
  if command -v setcap >/dev/null 2>&1; then
    log "Allowing Node.js to bind to port 80 without running as root"
    setcap 'cap_net_bind_service=+ep' "$node_bin" || log "setcap failed; service will retry without User= if needed"
  fi

  log "Installing systemd service: $SERVICE_NAME"
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=EscapeHub Server
After=network-online.target mosquitto.service
Wants=network-online.target mosquitto.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${SERVER_DIR}
Environment=NODE_PATH=${SERVER_DIR}/node_modules
ExecStart=${node_bin} ${SERVER_DIR}/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"

  log "Starting $SERVICE_NAME"
  if ! systemctl restart "$SERVICE_NAME"; then
    log "Service did not start as ${RUN_USER}. Retrying as root because port 80 capabilities may be unavailable."
    sed -i '/^User=/d' "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl restart "$SERVICE_NAME"
  fi

  log "Service status"
  systemctl --no-pager --full status "$SERVICE_NAME" || true

  cat <<EOF

[installer] Done.

Open EscapeHub:
  http://localhost
  http://<raspberry-pi-ip>

Useful commands:
  sudo systemctl status ${SERVICE_NAME} --no-pager
  sudo journalctl -u ${SERVICE_NAME} -f
  sudo systemctl restart ${SERVICE_NAME}
  systemctl status mosquitto --no-pager
  bash install.sh --doctor

Hardware-specific services such as Zigbee2MQTT and OLA/DMX still need device-specific configuration.
EOF
}

show_command() {
  local label="$1"
  shift
  printf '%-28s' "$label"
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>/dev/null || true
  else
    echo "not installed"
  fi
}

run_doctor() {
  validate_project

  section "Project"
  echo "Project root: $PROJECT_ROOT"
  echo "Server dir:   $SERVER_DIR"
  [[ -f "$SERVER_DIR/server.js" ]] && echo "Server file:  ok" || echo "Server file:  missing"
  [[ -f "$SERVER_DIR/package.json" ]] && echo "package.json: ok" || echo "package.json: missing"
  [[ -d "$SERVER_DIR/node_modules" ]] && echo "node_modules: ok" || echo "node_modules: missing"

  section "Node.js"
  show_command "node:" node -v
  show_command "npm:" npm -v

  section "Services"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active md2-hub >/dev/null 2>&1 && echo "md2-hub:   active" || echo "md2-hub:   inactive/not installed"
    systemctl is-active mosquitto >/dev/null 2>&1 && echo "mosquitto: active" || echo "mosquitto: inactive/not installed"
    systemctl is-active zigbee2mqtt >/dev/null 2>&1 && echo "zigbee2mqtt: active" || echo "zigbee2mqtt: inactive/not installed"
    systemctl is-active olad >/dev/null 2>&1 && echo "olad:      active" || echo "olad:      inactive/not installed"
  else
    echo "systemctl: not available"
  fi

  section "Network Ports"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E '(:80|:1883|:9010)\b' || echo "No listeners on 80, 1883, or 9010 found"
  else
    echo "ss: not installed"
  fi

  section "MQTT"
  if command -v mosquitto_sub >/dev/null 2>&1; then
    timeout 2 mosquitto_sub -h localhost -t '$SYS/broker/version' -C 1 -v 2>/dev/null || echo "MQTT localhost test failed or timed out"
  else
    echo "mosquitto_sub: not installed"
  fi

  section "USB Symlinks"
  for dev in zigbee dmx; do
    if [[ -e "/dev/$dev" ]]; then
      printf '/dev/%s -> %s\n' "$dev" "$(readlink -f "/dev/$dev")"
    else
      echo "/dev/$dev: missing"
    fi
  done

  section "Serial Devices"
  if [[ -d /dev/serial/by-id ]]; then
    ls -l /dev/serial/by-id || true
  else
    echo "/dev/serial/by-id: missing"
  fi

  section "Port Ownership"
  if command -v lsof >/dev/null 2>&1; then
    for dev in /dev/zigbee /dev/dmx; do
      [[ -e "$dev" ]] && sudo lsof "$dev" 2>/dev/null || true
    done
  else
    echo "lsof: not installed"
  fi

  section "Audio"
  if [[ -f /proc/asound/cards ]]; then
    cat /proc/asound/cards
  else
    echo "/proc/asound/cards: missing"
  fi

  section "Recent Logs"
  if command -v journalctl >/dev/null 2>&1; then
    echo "-- md2-hub --"
    journalctl -u md2-hub -n 15 --no-pager 2>/dev/null || true
    echo "-- mosquitto --"
    journalctl -u mosquitto -n 15 --no-pager 2>/dev/null || true
  else
    echo "journalctl: not available"
  fi
}

show_hardware_notes() {
  cat <<EOF

Hardware setup notes:
- Zigbee2MQTT requires a configured Zigbee dongle and a stable /dev/zigbee symlink.
- OLA/DMX requires a configured DMX adapter and a stable /dev/dmx symlink.
- Audio output depends on the selected ALSA/PulseAudio device.

Use diagnostics first:
  bash install.sh --doctor

EOF
}

run_menu() {
  cat <<EOF
EscapeHub Installer

1. Install core hub
2. Run diagnostics
3. Show hardware setup notes
4. Exit
EOF

  printf "\nSelect option [1-4]: "
  read -r choice
  case "$choice" in
    1) install_core ;;
    2) run_doctor ;;
    3) show_hardware_notes ;;
    4) exit 0 ;;
    *) echo "Invalid option: $choice" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  --core) install_core ;;
  --full) install_core ;;
  --doctor) run_doctor ;;
  --help|-h) print_help ;;
  "") run_menu ;;
  *)
    echo "Unknown option: $1" >&2
    print_help
    exit 1
    ;;
esac
