#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IDA SYSTEM — GENERADOR DE CERTIFICADOS SSL/TLS DE COMPATIBILIDAD UNIVERSAL
# (Para Impresoras Térmicas, Básculas, Periféricos y Comanderos en Tablets)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/../certs"
mkdir -p "${CERTS_DIR}"

echo "======================================================================"
echo "🔐 GENERANDO CERTIFICADOS X.509 PARA PERIFÉRICOS DE IDA SYSTEM"
echo "======================================================================"

# 1. Detectar IP local de la máquina actual
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "192.168.1.100")
if [ -z "${LOCAL_IP}" ]; then
    LOCAL_IP="192.168.1.100"
fi

echo "📍 IP Local detectada: ${LOCAL_IP}"

# 2. Generar Autoridad Certificadora Raíz (IDA Root CA)
# Compatible con Windows XP/7/10/11, Android 4.4+, iOS 9+, Linux
echo "1️⃣ Creando Autoridad Certificadora Raíz (IDA Root CA)..."
openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${CERTS_DIR}/ida_ca_root.key" \
    -out "${CERTS_DIR}/ida_ca_root.crt" \
    -days 3650 \
    -subj "/C=MX/ST=CDMX/L=Ciudad de Mexico/O=AnaliticaSoft/OU=IDA System/CN=IDA System Root CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

# 3. Generar Clave Privada para el Servidor / Driver Local
echo "2️⃣ Creando clave RSA 2048 para el Driver Local..."
openssl genrsa -out "${CERTS_DIR}/ida_peripheral.key" 2048

# 4. Crear archivo de configuración OpenSSL con Subject Alternative Names (SAN)
echo "3️⃣ Configurando SAN (Subject Alternative Names) para localhost y red LAN..."
cat > "${CERTS_DIR}/openssl_san.cnf" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn

[dn]
C = MX
ST = CDMX
L = Ciudad de Mexico
O = AnaliticaSoft
OU = IDA System Peripherals
CN = ida-peripheral.local

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.local
DNS.3 = ida.local
DNS.4 = ida-peripheral.local
IP.1 = 127.0.0.1
IP.2 = ::1
IP.3 = ${LOCAL_IP}
IP.4 = 192.168.0.1
IP.5 = 192.168.1.1
IP.6 = 10.0.0.1
IP.7 = 172.16.0.1
EOF

# 5. Generar CSR (Certificate Signing Request)
echo "4️⃣ Generando CSR firmado..."
openssl req -new \
    -key "${CERTS_DIR}/ida_peripheral.key" \
    -out "${CERTS_DIR}/ida_peripheral.csr" \
    -config "${CERTS_DIR}/openssl_san.cnf"

# 6. Firmar el certificado del driver con la CA Raíz de IDA
echo "5️⃣ Firmando certificado de servidor con IDA Root CA..."
openssl x509 -req \
    -in "${CERTS_DIR}/ida_peripheral.csr" \
    -CA "${CERTS_DIR}/ida_ca_root.crt" \
    -CAkey "${CERTS_DIR}/ida_ca_root.key" \
    -CAcreateserial \
    -out "${CERTS_DIR}/ida_peripheral.crt" \
    -days 1825 \
    -sha256 \
    -extfile "${CERTS_DIR}/openssl_san.cnf" \
    -extensions req_ext

# 7. Crear cadena completa (Fullchain)
cat "${CERTS_DIR}/ida_peripheral.crt" "${CERTS_DIR}/ida_ca_root.crt" > "${CERTS_DIR}/ida_fullchain.crt"

# 8. Generar script de instalación automática en Windows
cat > "${CERTS_DIR}/instalar_en_windows.bat" <<'EOF'
@echo off
:: ==============================================================================
:: INSTALADOR DE CERTIFICADO DE CONFIANZA IDA SYSTEM PARA WINDOWS
:: ==============================================================================
echo ======================================================================
echo Instalando Certificado Raiz de IDA System en Almacen de Confianza...
echo ======================================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Por favor ejecuta este archivo dando clic derecho y 'Ejecutar como Administrador'.
    pause
    exit /b 1
)

certutil -addstore -f "ROOT" "%~dp0ida_ca_root.crt"

if %errorLevel% equ 0 (
    echo [EXITO] Certificado Raiz instalado correctamente.
    echo Ahora todos los navegadores (Chrome, Edge, Firefox) confiaran en el Driver de IDA.
) else (
    echo [ERROR] No se pudo instalar el certificado.
)
pause
EOF

# 9. Generar script de instalación automática en Linux
cat > "${CERTS_DIR}/instalar_en_linux.sh" <<'EOF'
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
EOF
chmod +x "${CERTS_DIR}/instalar_en_linux.sh"

# 10. Crear Guía de Instalación para Tablets (Android y iPad/iOS)
cat > "${CERTS_DIR}/INSTRUCCIONES_TABLETS.md" <<'EOF'
# 📱 Guía de Instalación del Certificado de Periféricos en Tablets (Comanderos)

Para que las tablets (Android o iPad/iOS) envíen comandas e impriman en impresoras térmicas de Cocina, Barra o Caja sin bloqueos de seguridad:

---

## 🤖 En Tablets Android (Samsung, Lenovo, Xiaomi, Huawei, etc.):
1. Envía o descarga el archivo `ida_ca_root.crt` a la tablet (por correo, WhatsApp Web o red local).
2. Abre **Ajustes / Configuración** en la tablet.
3. Ve a **Seguridad y privacidad** -> **Más ajustes de seguridad** -> **Encriptación y credenciales**.
4. Toca en **Instalar un certificado** -> **Certificado de CA**.
5. Si el sistema muestra una advertencia de seguridad, selecciona **"Instalar de todos modos"**.
6. Selecciona el archivo `ida_ca_root.crt` descargado.
7. Asigna el nombre `IDA System CA` y presiona **Aceptar**.
8. ¡Listo! El navegador Chrome en la tablet ya considerará al Driver y a las impresoras como conexión 100% segura.

---

## 🍏 En iPads / iPhones (iOS):
1. Envía el archivo `ida_ca_root.crt` al iPad y ábrelo en el navegador **Safari**.
2. Safari mostrará: *"Este sitio web está intentando descargar un perfil de configuración"*. Toca **Permitir**.
3. Ve a **Ajustes** -> Toca en **Perfil descargado** (arriba) -> **Instalar** (introduce el código del iPad).
4. Luego ve a **Ajustes** -> **General** -> **Información** -> **Ajustes de confianza de certificados** (al final).
5. En la sección *"Confiar plenamente en los certificados raíz"*, activa la casilla de **IDA System Root CA**.
6. ¡Listo! Safari y Chrome en el iPad se conectarán sin advertencias ni bloqueos.
EOF

echo ""
echo "======================================================================"
echo "✅ CERTIFICADOS GENERADOS EXITOSAMENTE EN: ${CERTS_DIR}"
echo "======================================================================"
echo "  • ida_ca_root.crt           -> Certificado Raíz (Instalar en Tablets/PCs)"
echo "  • ida_peripheral.crt        -> Certificado de Servidor para el Driver"
echo "  • ida_peripheral.key        -> Clave privada del Driver"
echo "  • ida_fullchain.crt         -> Cadena completa para HTTPS/WSS"
echo "  • instalar_en_windows.bat   -> Instalador en 1 clic para Windows"
echo "  • instalar_en_linux.sh      -> Instalador en 1 clic para Linux"
echo "  • INSTRUCCIONES_TABLETS.md  -> Guía paso a paso para Android e iPad"
echo "======================================================================"
