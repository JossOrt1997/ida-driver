#!/usr/bin/env bash
set -e
echo "Instalando Certificado Raíz de IDA en el sistema Linux..."
if [ "$EUID" -ne 0 ]; then
    echo "Por favor ejecuta con sudo: sudo bash instalar_en_linux.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "/usr/local/share/ca-certificates" ]; then
    cp "${SCRIPT_DIR}/ida_ca_root.crt" /usr/local/share/ca-certificates/ida_ca_root.crt
    update-ca-certificates
    echo "✓ Certificado instalado en /usr/local/share/ca-certificates y actualizado con éxito."
elif [ -d "/etc/pki/ca-trust/source/anchors" ]; then
    cp "${SCRIPT_DIR}/ida_ca_root.crt" /etc/pki/ca-trust/source/anchors/ida_ca_root.crt
    update-ca-trust extract
    echo "✓ Certificado instalado en /etc/pki/ca-trust/source/anchors y actualizado con éxito."
else
    echo "⚠️ Directorio de certificados no reconocido. Instala ida_ca_root.crt manualmente."
fi
