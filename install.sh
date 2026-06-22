#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="md2-hub"
NODE_MAJOR="20"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
SERVER_DIR="$PROJECT_ROOT/Server"
RUN_USER="${SUDO_USER:-$USER}"

log() { printf '\n[installer] %s\n' "$*"; }
fail() { printf '\n[installer] ERROR: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }

confirm() {
  local prompt="$1"
  local default="${2:-n}"
  local suffix="[y/N]"
  [[ "$default" == "y" ]] && suffix="[Y/n]"
  printf "%s %s " "$prompt" "$suffix"
  read -r answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
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
  --core      Install the hub service, Node.js, npm packages, and Mosquitto.
  --full      Run --core and guided setup for Zigbee2MQTT, OLA/DMX, and audio.
  --doctor    Run diagnostics only. Does not change system state.
  --help      Show this help.

The full setup asks before binding detected USB devices to /dev/zigbee or /dev/dmx.
EOF
}

validate_project() {
  [[ -f "$SERVER_DIR/server.js" ]] || fail "Cannot find Server/server.js. Run this script from the EscapeHub repository."
  [[ -f "$SERVER_DIR/package.json" ]] || fail "Cannot find Server/package.json."
}

ensure_root_for_install() {
  if [[ "$(id -u)" -ne 0 ]]; then
    log "Installation needs root privileges. Re-running through sudo."
    exec sudo bash "$0" "$1"
  fi
}

install_core() {
  validate_project
  ensure_root_for_install --core

  log "Project root: $PROJECT_ROOT"
  log "Install user: $RUN_USER"

  log "Installing base packages"
  apt-get update
  apt-get install -y git curl ca-certificates python3 make g++ build-essential mosquitto mosquitto-clients lsof

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
  install -d /etc/mosquitto/conf.d
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

  log "Core install complete"
}

list_serial_devices() {
  [[ -d /dev/serial/by-id ]] || return 0
  for link in /dev/serial/by-id/*; do
    [[ -e "$link" ]] || continue
    printf '%s -> %s\n' "$(basename "$link")" "$(readlink -f "$link")"
  done
}

find_serial_device() {
  local pattern="$1"
  [[ -d /dev/serial/by-id ]] || return 1
  for link in /dev/serial/by-id/*; do
    [[ -e "$link" ]] || continue
    if basename "$link" | grep -Eiq "$pattern"; then
      readlink -f "$link"
      return 0
    fi
  done
  return 1
}

write_tty_udev_rule() {
  local alias="$1"
  local dev="$2"
  local rule_file="/etc/udev/rules.d/99-escapehub-usb.rules"
  local serial_short serial vendor model

  [[ -e "$dev" ]] || fail "Device does not exist: $dev"
  serial_short="$(udevadm info -q property -n "$dev" | awk -F= '/^ID_SERIAL_SHORT=/{print $2; exit}')"
  serial="$(udevadm info -q property -n "$dev" | awk -F= '/^ID_SERIAL=/{print $2; exit}')"
  vendor="$(udevadm info -q property -n "$dev" | awk -F= '/^ID_VENDOR_ID=/{print $2; exit}')"
  model="$(udevadm info -q property -n "$dev" | awk -F= '/^ID_MODEL_ID=/{print $2; exit}')"

  install -d "$(dirname "$rule_file")"
  touch "$rule_file"
  sed -i "/SYMLINK+=\"$alias\"/d" "$rule_file"

  if [[ -n "$serial_short" ]]; then
    printf 'SUBSYSTEM=="tty", ENV{ID_SERIAL_SHORT}=="%s", SYMLINK+="%s"\n' "$serial_short" "$alias" >> "$rule_file"
  elif [[ -n "$serial" ]]; then
    printf 'SUBSYSTEM=="tty", ENV{ID_SERIAL}=="%s", SYMLINK+="%s"\n' "$serial" "$alias" >> "$rule_file"
  elif [[ -n "$vendor" && -n "$model" ]]; then
    printf 'SUBSYSTEM=="tty", ATTRS{idVendor}=="%s", ATTRS{idProduct}=="%s", SYMLINK+="%s"\n' "$vendor" "$model" "$alias" >> "$rule_file"
  else
    fail "Could not derive a stable udev rule for $dev"
  fi

  udevadm control --reload-rules
  udevadm trigger
  sleep 1
}

install_zigbee() {
  section "Zigbee2MQTT setup"
  apt-get install -y git curl ca-certificates

  local zigbee_dev
  zigbee_dev="$(find_serial_device 'Sonoff|Itead|Zigbee|CP210|Silicon_Labs' || true)"
  if [[ -z "$zigbee_dev" ]]; then
    echo "No likely Zigbee serial dongle found. Installing Zigbee2MQTT service without a /dev/zigbee rule."
    echo "Connect the adapter and rerun --full to create the stable /dev/zigbee mapping."
    echo "Detected serial devices:"
    list_serial_devices || true
  else
    echo "Detected likely Zigbee dongle: $zigbee_dev"
    if confirm "Use this device as /dev/zigbee?" "y"; then
      write_tty_udev_rule "zigbee" "$zigbee_dev"
    else
      echo "Continuing without creating a /dev/zigbee rule."
    fi
  fi

  if [[ ! -d /opt/zigbee2mqtt ]]; then
    log "Cloning Zigbee2MQTT to /opt/zigbee2mqtt"
    git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git /opt/zigbee2mqtt
  else
    log "/opt/zigbee2mqtt already exists; keeping existing checkout"
  fi
  chown -R "$RUN_USER:$RUN_USER" /opt/zigbee2mqtt

  log "Installing Zigbee2MQTT dependencies"
  if [[ -f /opt/zigbee2mqtt/pnpm-lock.yaml ]]; then
    corepack enable || true
    sudo -u "$RUN_USER" bash -lc "cd /opt/zigbee2mqtt && corepack enable || true && pnpm install --frozen-lockfile"
  else
    sudo -u "$RUN_USER" bash -lc "cd /opt/zigbee2mqtt && npm ci"
  fi

  install -d -o "$RUN_USER" -g "$RUN_USER" /opt/zigbee2mqtt/data
  local adapter="ember"
  printf "Zigbee adapter type [ember]: "
  read -r adapter_input
  adapter="${adapter_input:-ember}"

  if [[ -f /opt/zigbee2mqtt/data/configuration.yaml ]]; then
    cp -a /opt/zigbee2mqtt/data/configuration.yaml "/opt/zigbee2mqtt/data/configuration.yaml.bak.$(date +%Y%m%d-%H%M%S)"
  fi

  cat >/opt/zigbee2mqtt/data/configuration.yaml <<EOF
version: 5
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://localhost:1883
serial:
  port: /dev/zigbee
  adapter: ${adapter}
  baudrate: 115200
  rtscts: false
advanced:
  log_level: info
frontend:
  enabled: true
  port: 8080
EOF
  chown "$RUN_USER:$RUN_USER" /opt/zigbee2mqtt/data/configuration.yaml

  cat >/etc/systemd/system/zigbee2mqtt.service <<EOF
[Unit]
Description=Zigbee2MQTT
After=network-online.target mosquitto.service dev-zigbee.device
Wants=network-online.target mosquitto.service
Requires=dev-zigbee.device

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=/opt/zigbee2mqtt
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable zigbee2mqtt
  if ! systemctl restart zigbee2mqtt; then
    echo "Zigbee2MQTT service is installed but did not start. This is expected if /dev/zigbee is missing or the dongle is not ready."
  fi
}

configure_ola_plugins() {
  local conf_dir="/etc/ola"
  [[ -d "$conf_dir" ]] || return 0
  for conf in "$conf_dir"/ola-*.conf; do
    [[ -f "$conf" ]] || continue
    if [[ "$(basename "$conf")" == "ola-usbserial.conf" ]]; then
      sed -i 's/^enabled = .*/enabled = true/' "$conf" || true
    else
      sed -i 's/^enabled = .*/enabled = false/' "$conf" || true
    fi
  done
  cat >"$conf_dir/ola-usbserial.conf" <<EOF
enabled = true
device = /dev/dmx
device_dir = /dev
device_prefix = dmx
ignore_device = /dev/zigbee
EOF
}

install_dmx() {
  section "DMX / OLA setup"
  apt-get install -y ola

  local dmx_dev
  dmx_dev="$(find_serial_device 'DMXking|DMX|FT232|FTDI' || true)"
  if [[ -z "$dmx_dev" ]]; then
    echo "No likely USB-DMX serial adapter found. Installing OLA without a /dev/dmx rule."
    echo "Connect the adapter and rerun --full to create the stable /dev/dmx mapping."
    echo "Detected serial devices:"
    list_serial_devices || true
  else
    echo "Detected likely DMX adapter: $dmx_dev"
    if confirm "Use this device as /dev/dmx?" "y"; then
      write_tty_udev_rule "dmx" "$dmx_dev"
    else
      echo "Continuing without creating a /dev/dmx rule."
    fi
  fi

  configure_ola_plugins
  systemctl enable olad
  if ! systemctl restart olad; then
    echo "OLA service is installed but did not start. Check /dev/dmx and olad logs after connecting the adapter."
  fi
}

install_audio() {
  section "Audio setup"
  apt-get install -y alsa-utils ffmpeg mpg123

  if [[ ! -f /proc/asound/cards ]]; then
    echo "No ALSA sound card list found. Skipping audio setup."
    return 0
  fi
  cat /proc/asound/cards

  local card_id
  card_id="$(awk -F'[][]' '/USB-Audio|UC02|USB Audio/{print $2; exit}' /proc/asound/cards)"
  if [[ -z "$card_id" ]]; then
    echo "No USB audio card auto-detected. Skipping default audio setup."
    return 0
  fi

  echo "Detected likely USB audio card: $card_id"
  if confirm "Use this card as default audio output?" "y"; then
    cat >/etc/asound.conf <<EOF
pcm.!default {
  type plug
  slave.pcm "hw:CARD=${card_id},DEV=0"
}

ctl.!default {
  type hw
  card ${card_id}
}
EOF
    amixer -c "$card_id" set PCM 100% unmute || true
  fi
}

install_full() {
  validate_project
  ensure_root_for_install --full
  install_core
  install_zigbee
  install_dmx
  install_audio
  run_doctor
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
- --full now performs guided setup for Zigbee2MQTT, OLA/DMX, and audio.
- Keep the Zigbee dongle, DMX adapter, and USB audio adapter connected before running --full.
- The installer asks before binding detected serial devices to /dev/zigbee or /dev/dmx.

Use diagnostics:
  bash install.sh --doctor

EOF
}

run_menu() {
  cat <<EOF
EscapeHub Installer

1. Install core hub
2. Install full setup
3. Run diagnostics
4. Show hardware setup notes
5. Exit
EOF
  printf "\nSelect option [1-5]: "
  read -r choice
  case "$choice" in
    1) install_core ;;
    2) install_full ;;
    3) run_doctor ;;
    4) show_hardware_notes ;;
    5) exit 0 ;;
    *) echo "Invalid option: $choice" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  --core) install_core ;;
  --full) install_full ;;
  --doctor) run_doctor ;;
  --help|-h) print_help ;;
  "") run_menu ;;
  *)
    echo "Unknown option: $1" >&2
    print_help
    exit 1
    ;;
esac
