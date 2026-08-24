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
