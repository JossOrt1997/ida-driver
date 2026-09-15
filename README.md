# IDA Print Driver 2.0

Agente de impresion ESC/POS para instalaciones IDA. Mantiene una conexion WebSocket segura con el backend, sincroniza trabajos pendientes por HTTP y confirma cada trabajo despues de imprimirlo.

## Requisitos

- Windows x64 o Linux x64.
- Node.js 20, 22 o 24 LTS para la distribucion basada en Node.
- Acceso saliente HTTPS/WSS al backend IDA.
- Acceso TCP desde la computadora del driver a las impresoras en el puerto configurado, normalmente `9100`.

## Configuracion

Ejecuta `npm start`. La primera vez, el driver te guiara en pantalla para conectar tu empresa y configurar sus impresoras. No necesitas editar archivos JSON.

La pantalla te pedira el codigo de conexion que aparece en Configuracion de Empresa. El driver lo guarda de forma automatica y lo utiliza para conectarse, consultar trabajos pendientes y confirmar impresiones.

`driverAccessId` es el codigo unico de conexion de la empresa. `printDriverToken` y `IDA_PRINT_DRIVER_TOKEN` continuan soportados unicamente para instalaciones anteriores.

## Operacion

```bash
npm ci
npm run check
npm test
npm start
```

Al abrir el driver encontraras un menu sencillo para:

- Ver si la empresa esta conectada.
- Revisar si cada impresora responde.
- Cambiar el codigo de conexion sin editar archivos.
- Agregar o eliminar impresoras.
- Borrar la configuracion local del equipo, siempre con confirmacion.

El panel local de diagnostico esta disponible en `http://127.0.0.1:8787/health` y `http://127.0.0.1:8787/health/deep`.

El driver no marca un trabajo como completado hasta que la impresion termina correctamente. Si el backend no responde, conserva los ACK pendientes y los reintenta al recuperar la conexion.

## Distribucion

No distribuyas `config_ida.json`, `pending_acks.json`, logs ni metricas dentro del instalador base. Tampoco incluyas claves privadas TLS en el binario. El instalador debe crear esos archivos en el directorio de datos de la instalacion y solicitar el token durante el alta.

El archivo `Driver_ida_V1.1.exe` es un artefacto anterior y no contiene necesariamente esta version del runtime. Debe regenerarse mediante un pipeline de release para publicar la version 2.0.
