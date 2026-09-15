#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${IDA_DRIVER_INSTALL_DIR:-/opt/ida-print-driver}"
DATA_DIR="${IDA_DRIVER_DATA_DIR:-/var/lib/ida-print-driver}"
SERVICE_NAME="ida-print-driver"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este instalador como root: sudo bash scripts/install-linux.sh" >&2
  exit 1
fi

install -d -m 0755 "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/logs_impresion"
cp -R "$ROOT_DIR/agente.js" "$ROOT_DIR/lib" "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$INSTALL_DIR/"
cp -R "$ROOT_DIR/certs" "$INSTALL_DIR/"
cd "$INSTALL_DIR"
npm ci --omit=dev --ignore-scripts
chown -R root:root "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR/agente.js"
chmod 0700 "$DATA_DIR"

cat > "/etc/${SERVICE_NAME}.env" <<'EOF'
# Configuracion local del driver. No compartir este archivo.
IDA_DRIVER_DATA_DIR=/var/lib/ida-print-driver
# IDA_PRINT_DRIVER_TOKEN=configure-el-mismo-secreto-del-backend
EOF
chmod 0600 "/etc/${SERVICE_NAME}.env"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=IDA Print Driver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DATA_DIR}
EnvironmentFile=-/etc/${SERVICE_NAME}.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/agente.js
Restart=always
RestartSec=10
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "Instalacion preparada. Configura ${DATA_DIR}/config_ida.json y ejecuta: systemctl start ${SERVICE_NAME}"
