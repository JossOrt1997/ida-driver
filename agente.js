const WebSocket = require('ws');
const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');

// Usar path.join(process.cwd(), ...) para que el EXE busque archivos en la carpeta donde está guardado
const CONFIG_FILE = path.join(process.cwd(), 'config_ida.json');
const LOGS_DIR = path.join(process.cwd(), 'logs_impresion');

if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (e) {
        console.error("No se pudo crear la carpeta de logs:", e.message);
    }
}

// --- ESTADO GLOBAL ---
const status = {
    connected: false,
    authenticated: false,
    tenant: null,
    token: null,
    baseUrl: process.env.IDA_API_URL || 'http://localhost:8080',
    printers: {}, 
};

const printerQueues = {};

// --- AUTENTICACIÓN Y SINCRONIZACIÓN ---
async function login(config) {
    try {
        console.log(chalk.yellow("🔐 Autenticando con el servidor..."));
        const resp = await axios.post(`${status.baseUrl}/api/auth/login`, {
            email: config.email,
            password: config.password
        });
        status.token = resp.data.data.accessToken;
        status.authenticated = true;
        console.log(chalk.green("✅ Autenticación exitosa."));
        return true;
    } catch (err) {
        console.error(chalk.red("❌ Error de autenticación:"), err.response?.data?.message || err.message);
        return false;
    }
}

async function syncPendingJobs() {
    if (!status.authenticated) return;
    try {
        console.log(chalk.cyan("🔄 Sincronizando trabajos pendientes..."));
        const resp = await axios.get(`${status.baseUrl}/api/restaurante/impresion/pendientes`, {
            headers: { Authorization: `Bearer ${status.token}` }
        });
        
        const jobs = resp.data.data || [];
        console.log(chalk.gray(`📥 Se encontraron ${jobs.length} trabajos pendientes.`));
        
        for (let job of jobs) {
            addToQueue(job.ip, job.puerto || 9100, job.texto || job.contenidoTexto, job.id);
        }
    } catch (err) {
        console.error(chalk.red("❌ Error al sincronizar:"), err.message);
    }
}

async function markAsCompleted(jobId) {
    if (!jobId || !status.authenticated) return;
    try {
        await axios.post(`${status.baseUrl}/api/restaurante/impresion/${jobId}/completar`, {}, {
            headers: { Authorization: `Bearer ${status.token}` }
        });
        // console.log(chalk.gray(`✅ Trabajo #${jobId} marcado como completado en server.`));
    } catch (err) {
        console.error(chalk.red(`⚠️ No se pudo marcar el trabajo #${jobId} como completado:`), err.message);
    }
}

// --- GESTIÓN DE COLAS ---
async function addToQueue(ip, puerto, texto, jobId = null) {
    const key = `${ip}:${puerto}`;
    if (!printerQueues[key]) {
        printerQueues[key] = { queue: [], active: false };
        status.printers[key] = { queue: 0, totalPrints: 0, lastError: null };
    }
    
    // Evitar duplicados en cola si ya está el mismo JobId
    if (jobId && printerQueues[key].queue.some(q => q.jobId === jobId)) return;

    printerQueues[key].queue.push({ texto, jobId });
    status.printers[key].queue = printerQueues[key].queue.length;
    processQueue(key);
}

async function processQueue(key) {
    const p = printerQueues[key];
    if (p.active || p.queue.length === 0) return;

    p.active = true;
    const item = p.queue.shift();
    status.printers[key].queue = p.queue.length;

    try {
        await executePrint(key, item.texto);
        status.printers[key].totalPrints++;
        status.printers[key].lastError = null;
        
        // Avisar al servidor que ya se imprimió
        if (item.jobId) await markAsCompleted(item.jobId);

    } catch (err) {
        status.printers[key].lastError = err.message;
        console.error(chalk.red(`\n[!] Error en impresora ${key}: ${err.message}`));
        // Re-encolar para reintento físico si falló la impresora
        p.queue.unshift(item);
    } finally {
        p.active = false;
        setTimeout(() => processQueue(key), 500);
    }
}

async function executePrint(key, texto) {
    const logFile = path.join(LOGS_DIR, `${key.replace(/:/g, '-')}.log`);
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ---\n${texto}\n`);

    if (key.startsWith('127.0.0.1') || key.startsWith('localhost')) {
        return; 
    }

    let printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: `tcp://${key}`,
        options: { timeout: 3000 }
    });

    const lines = texto.split('\n');
    for (let line of lines) {
        if (line.trim() === '[CUT]') { printer.cut(); continue; }
        printer.alignLeft(); printer.setTextNormal(); printer.bold(false);
        let cleanLine = line;
        if (cleanLine.includes('[C]')) { printer.alignCenter(); cleanLine = cleanLine.replace(/\[C\]/g, '').replace(/\[\/C\]/g, ''); }
        if (cleanLine.includes('[R]')) { printer.alignRight(); cleanLine = cleanLine.replace(/\[R\]/g, '').replace(/\[\/R\]/g, ''); }
        if (cleanLine.includes('[B]')) { printer.bold(true); cleanLine = cleanLine.replace(/\[B\]/g, '').replace(/\[\/B\]/g, ''); }
        if (cleanLine.includes('[L]')) { printer.setTextDoubleHeight(); printer.setTextDoubleWidth(); cleanLine = cleanLine.replace(/\[L\]/g, '').replace(/\[\/L\]/g, ''); }
        printer.println(cleanLine);
    }
    await printer.execute();
}

// --- MENÚS ---
async function main() {
    console.clear();
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.white.bold("   💠 AGENTE DE IMPRESIÓN IDA v5.0 ULTRA     "));
    console.log(chalk.blue.bold("============================================="));

    const tieneConfig = fs.existsSync(CONFIG_FILE);
    const choices = [
        { name: '▶️  Iniciar Servicio', value: 'run', disabled: !tieneConfig },
        { name: '⚙️  Configuración Nueva (Reset)', value: 'reset' },
        { name: '➕ Añadir Impresora', value: 'add', disabled: !tieneConfig },
        { name: '❌ Salir', value: 'exit' }
    ];

    const { choice } = await inquirer.prompt([{ type: 'list', name: 'choice', message: 'Selecciona:', choices }]);

    if (choice === 'exit') process.exit(0);
    
    if (choice === 'reset') {
        const data = await inquirer.prompt([
            { name: 'empresaId', message: 'ID de Empresa:' },
            { name: 'email', message: 'Email del Usuario Driver:' },
            { name: 'password', message: 'Contraseña:', type: 'password' }
        ]);
        const config = { ...data, impresoras: [] };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return main();
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    if (choice === 'add') {
        const nueva = await inquirer.prompt([
            { name: 'ip', message: 'IP Impresora:', default: '127.0.0.1' },
            { name: 'puerto', message: 'Puerto:', default: 9100, type: 'number' }
        ]);
        config.impresoras.push(nueva);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return main();
    }

    startAgent(config);
}

async function startAgent(config) {
    status.tenant = config.empresaId;
    
    // 1. Intentar Login
    const ok = await login(config);
    if (!ok) {
        console.log(chalk.red("Reintentando login en 10s..."));
        setTimeout(() => startAgent(config), 10000);
        return;
    }

    // 2. Sincronizar lo perdido
    await syncPendingJobs();

    // 3. Conectar WebSocket para Real-Time
    const wsBase = status.baseUrl.replace('http', 'ws');
    const wsUrl = `${wsBase}/ws/impresion?tenant=${config.empresaId}`;
    
    console.log(chalk.yellow(`📡 Conectando WebSocket: ${wsUrl}...`));
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        status.connected = true;
        drawDashboard();
    });

    ws.on('message', (data) => {
        try {
            const p = JSON.parse(data);
            if (p.texto && p.ip) {
                addToQueue(p.ip, p.puerto || 9100, p.texto, p.id);
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
    process.stdout.write('\033[H\033[2J');
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.white.bold(`   💠 AGENTE IDA v5.0 - TENANT: ${status.tenant}`));
    console.log(chalk.blue.bold("============================================="));
    console.log(`Estado Global: ${status.connected ? chalk.green("EN LÍNEA") : chalk.red("DESCONECTADO")}`);
    console.log("---------------------------------------------");
    Object.keys(status.printers).forEach(k => {
        const p = status.printers[k];
        console.log(`${k.padEnd(20)} | Cola: ${p.queue} | OK: ${p.totalPrints} | ${p.lastError ? chalk.red("ERR") : chalk.green("OK")}`);
    });
    console.log(chalk.blue.bold("============================================="));
}

main().catch(err => {
    console.error(err);
    process.stdin.resume();
});
