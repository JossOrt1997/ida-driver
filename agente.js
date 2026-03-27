const WebSocket = require('ws');
const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// Usar path.join(process.cwd(), ...) para que el EXE busque archivos en la carpeta donde está guardado, no dentro del bundle virtual
const CONFIG_FILE = path.join(process.cwd(), 'config_ida.json');
const LOGS_DIR = path.join(process.cwd(), 'logs_impresion');

if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (e) {
        console.error("No se pudo crear la carpeta de logs:", e.message);
    }
}

// --- DASHBOARD DE ESTADO ---
const status = {
    connected: false,
    tenant: null,
    printers: {}, // { ip: { queue: 0, lastError: null, totalPrints: 0 } }
};

// --- GESTIÓN DE COLAS INDEPENDIENTES (AISLAMIENTO DE FALLOS) ---
const printerQueues = {};

async function addToQueue(ip, puerto, texto) {
    const key = `${ip}:${puerto}`;
    if (!printerQueues[key]) {
        printerQueues[key] = { queue: [], active: false };
        status.printers[key] = { queue: 0, totalPrints: 0, lastError: null };
    }
    printerQueues[key].queue.push(texto);
    status.printers[key].queue = printerQueues[key].queue.length;
    processQueue(key);
}

async function processQueue(key) {
    const p = printerQueues[key];
    if (p.active || p.queue.length === 0) return;

    p.active = true;
    const texto = p.queue.shift();
    status.printers[key].queue = p.queue.length;

    try {
        await executePrint(key, texto);
        status.printers[key].totalPrints++;
        status.printers[key].lastError = null;
    } catch (err) {
        status.printers[key].lastError = err.message;
        console.error(chalk.red(`\n[!] Error en impresora ${key}: ${err.message}`));
    } finally {
        p.active = false;
        setTimeout(() => processQueue(key), 300);
    }
}

async function executePrint(key, texto) {
    const logFile = path.join(LOGS_DIR, `${key.replace(/:/g, '-')}.log`);
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ---\n${texto}\n`);

    // SI ESTAMOS EN MODO SIMULACIÓN (IP LOCAL), SOLO LOGUEAMOS
    if (key.startsWith('127.0.0.1') || key.startsWith('localhost')) {
        console.log(chalk.cyan(`[SIMULACIÓN] Ticket guardado en log: ${logFile}`));
        return;
    }

    let printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: `tcp://${key}`,
        options: { timeout: 3000 }
    });

    printer.println(texto);
    printer.cut();
    await printer.execute();
}

// --- MENÚ DE CONFIGURACIÓN DINÁMICA ---
async function main() {
    console.clear();
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.white.bold("   💠 AGENTE DE IMPRESIÓN IDA v4.5 PRO       "));
    console.log(chalk.blue.bold("============================================="));

    const tieneConfig = fs.existsSync(CONFIG_FILE);
    const choices = [
        { name: '▶️  Iniciar Servicio', value: 'run', disabled: !tieneConfig },
        { name: '⚙️  Configuración Nueva (Reset)', value: 'reset' },
        { name: '➕ Añadir Impresora', value: 'add', disabled: !tieneConfig },
        { name: '🧪 Enviar Prueba (Self-Test)', value: 'test', disabled: !tieneConfig },
        { name: '❌ Salir', value: 'exit' }
    ];

    const { choice } = await inquirer.prompt([{ type: 'list', name: 'choice', message: 'Selecciona una opción:', choices }]);

    if (choice === 'exit') process.exit(0);
    
    if (choice === 'reset') {
        const { id } = await inquirer.prompt([{ name: 'id', message: 'ID de Empresa (Tenant):' }]);
        const config = { empresaId: id, impresoras: [] };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return main();
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    if (choice === 'add') {
        const nueva = await inquirer.prompt([
            { name: 'ip', message: 'IP (usa 127.0.0.1 para simular):', default: '127.0.0.1' },
            { name: 'puerto', message: 'Puerto:', default: 9100, type: 'number' },
            { name: 'tipo', message: 'Destino:', choices: ['COCINA', 'BARRA', 'CAJA'], type: 'list' }
        ]);
        config.impresoras.push(nueva);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log(chalk.green("✅ Impresora añadida."));
        return main();
    }

    if (choice === 'test') {
        console.log(chalk.yellow("\nEnviando página de prueba..."));
        for (let imp of config.impresoras) {
            await addToQueue(imp.ip, imp.puerto, "PRUEBA DE CONEXIÓN IDA\nESTADO: OK\nFECHA: " + new Date().toLocaleString());
        }
        await new Promise(r => setTimeout(r, 2000));
        return main();
    }

    startAgent(config);
}

function startAgent(config) {
    status.tenant = config.empresaId;
    const wsUrl = process.env.IDA_WS_URL || `wss://ida.analiticasoft.com/ws/impresion?tenant=${config.empresaId}`;
    
    console.log(chalk.yellow(`\n📡 Conectando a ${wsUrl}...`));
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        status.connected = true;
        console.clear();
        drawDashboard();
    });

    ws.on('message', (data) => {
        try {
            const p = JSON.parse(data);
            if (p.texto && p.ip) {
                addToQueue(p.ip, p.puerto || 9100, p.texto);
                drawDashboard();
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        status.connected = false;
        drawDashboard();
        setTimeout(() => startAgent(config), 5000);
    });
}

function drawDashboard() {
    process.stdout.write('\033[H\033[2J'); // Clear screen
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.white.bold(`   💠 AGENTE IDA - TENANT: ${status.tenant}`));
    console.log(chalk.blue.bold("============================================="));
    
    const state = status.connected ? chalk.green.bold("EN LÍNEA") : chalk.red.bold("DESCONECTADO");
    console.log(`Estado Global: ${state}`);
    console.log("---------------------------------------------");
    
    const printerKeys = Object.keys(status.printers);
    if (printerKeys.length === 0) {
        console.log(chalk.gray("Esperando primer pedido para listar impresoras..."));
    } else {
        printerKeys.forEach(k => {
            const p = status.printers[k];
            const error = p.lastError ? chalk.red(`ERR: ${p.lastError}`) : chalk.green("OK");
            console.log(`${chalk.bold(k.padEnd(20))} | Cola: ${p.queue} | Totales: ${p.totalPrints} | ${error}`);
        });
    }
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.gray("Presiona Ctrl+C para salir y volver al menú."));
}

// Envolver main para capturar errores fatales y evitar cierre instantáneo
main().catch(async (err) => {
    console.error(chalk.red("\n❌ ERROR FATAL AL INICIAR EL AGENTE:"));
    console.error(err);
    console.log(chalk.yellow("\nPresiona cualquier tecla para cerrar..."));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 1));
});
