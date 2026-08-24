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
