const WebSocket = require('ws');
const net = require('net');

// 1. Simular Impresora de COCINA (Puerto 9101)
const cocinaPrinter = net.createServer((socket) => {
    console.log('🟢 [SIMULADOR] Impresora COCINA recibió conexión.');
    socket.on('data', (data) => {
        console.log('📄 [SIMULADOR] Ticket recibido en COCINA:\n' + data.toString());
    });
});
cocinaPrinter.listen(9101, '127.0.0.1');

// 2. Simular Impresora de BARRA (Puerto 9102)
const barraPrinter = net.createServer((socket) => {
    console.log('🟢 [SIMULADOR] Impresora BARRA recibió conexión.');
    socket.on('data', (data) => {
        console.log('📄 [SIMULADOR] Ticket recibido en BARRA:\n' + data.toString());
    });
});
barraPrinter.listen(9102, '127.0.0.1');

// 3. Simular Servidor WebSocket IDA (Puerto 8888)
const wss = new WebSocket.Server({ port: 8888 });
console.log('📡 [SIMULADOR] Servidor WebSocket IDA escuchando en puerto 8888');

wss.on('connection', (ws) => {
    console.log('🔗 [SIMULADOR] Un cliente se ha conectado.');

    // Relay para que el script de stress pueda mandarle cosas al driver a través de este servidor falso
    ws.on('message', (message) => {
        const data = message.toString();
        console.log('📥 [SIMULADOR] Recibido mensaje para retransmitir: ' + data.substring(0, 50) + '...');
        wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    });

    // Simular envío de comanda a COCINA después de 2 segundos
    setTimeout(() => {
        console.log('📤 [SIMULADOR] Enviando comanda de COCINA...');
        ws.send(JSON.stringify({
            destinoImpresion: 'COCINA',
            mesa: 'Terraza 4',
            productos: [
                { cantidad: 2, nombre: 'Pizza Margarita', notas: 'Sin orégano' },
                { cantidad: 1, nombre: 'Lasaña Bolonia', notas: 'Extra queso' }
            ]
        }));
    }, 2000);

    // Simular envío de comanda a BARRA después de 5 segundos
    setTimeout(() => {
        console.log('📤 [SIMULADOR] Enviando comanda de BARRA...');
        ws.send(JSON.stringify({
            destinoImpresion: 'BARRA',
            mesa: 'Terraza 4',
            productos: [
                { cantidad: 2, nombre: 'Cerveza Lager', notas: 'Bien fría' },
                { cantidad: 1, nombre: 'Clericot Jarra', notas: '' }
            ]
        }));
    }, 5000);
});
