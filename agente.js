const WebSocket = require('ws');
const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');

// Configuración fija
const BASE_URL = 'https://ida.analiticasoft.com';
const CONFIG_FILE = path.join(process.cwd(), 'config_ida.json');
const LOGS_DIR = path.join(process.cwd(), 'logs_impresion');

if (!fs.existsSync(LOGS_DIR)) {
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}
}

const status = { connected: false, tenant: null, printers: {} };
const printerQueues = {};
const processedJobIds = new Set(); // Cache de IDs procesados para evitar duplicidad

async function syncPendingJobs() {
    if (!status.tenant) return;
    try {
        console.log(chalk.cyan("🔄 Recuperando pedidos pendientes..."));
        const resp = await axios.get(`${BASE_URL}/api/public/impresion/${status.tenant}/pendientes`);
        const jobs = resp.data.data || [];
        for (let job of jobs) {
            addToQueue(job.ip, job.puerto || 9100, job.texto || job.contenidoTexto, job.id);
        }
    } catch (err) { 
        console.error(chalk.red("⚠️ Error de conexión con el servidor."), err.message); 
    }
}

async function markAsCompleted(jobId) {
    if (!jobId) return;
    try { 
        await axios.post(`${BASE_URL}/api/public/impresion/${jobId}/completar`); 
        return true;
    } catch (e) {
        console.error(chalk.yellow(`⚠️ No se pudo marcar ID #${jobId} como completado en el servidor.`));
        return false;
    }
}

async function addToQueue(ip, puerto, texto, jobId = null) {
    const key = `${ip}:${puerto}`;
    if (!printerQueues[key]) {
        printerQueues[key] = { queue: [], active: false };
        status.printers[key] = { queue: 0, totalPrints: 0, lastError: null };
    }
    
    // --- DE-DUPLICACIÓN (Last Line of Defense) ---
    if (jobId) {
        const strId = String(jobId);
        if (processedJobIds.has(strId)) {
            // console.log(chalk.gray(`♻️  ID #${strId} ya procesado, ignorando duplicado.`));
            return;
        }
        
        // Limitar tamaño del cache de IDs (Aumentado a 1000)
        if (processedJobIds.size > 1000) {
            const first = processedJobIds.values().next().value;
            processedJobIds.delete(first);
        }
        processedJobIds.add(strId);
    }

    if (jobId && printerQueues[key].queue.some(q => String(q.jobId) === String(jobId))) return;
    printerQueues[key].queue.push({ texto, jobId });
    processQueue(key);
}

async function processQueue(key) {
    const p = printerQueues[key];
    if (p.active || p.queue.length === 0) return;
    p.active = true;
    const item = p.queue.shift();
    
    let printSuccess = false;
    try {
        await executePrint(key, item.texto);
        printSuccess = true;
        status.printers[key].totalPrints++;
        status.printers[key].lastError = null;
        p.retryCount = 0;
    } catch (err) {
        console.error(chalk.red(`❌ Error físico en impresora ${key}:`), err.message);
        status.printers[key].lastError = err.message;
        p.retryCount = (p.retryCount || 0) + 1;
        p.queue.unshift(item); // Reintentar impresión física
    }

    // Notificación al servidor (Independiente de la impresión física)
    if (printSuccess && item.jobId) {
        const marked = await markAsCompleted(item.jobId);
        if (!marked) {
            // Si falló la notificación pero se imprimió, NO volvemos a imprimir.
            // Opcional: Podríamos guardarlo en una cola de "notificaciones pendientes"
            // Por ahora, al estar ya en processedJobIds, no se duplicará en el próximo poll.
        }
    }

    p.active = false;
    // Exponential backoff for offline printers: 500ms, 1s, 2s, max 10s.
    let delay = printSuccess ? 100 : 500; 
    if (p.retryCount > 0) {
        delay = Math.min(500 * Math.pow(2, p.retryCount), 10000);
    }
    setTimeout(() => processQueue(key), delay);
}

async function executePrint(key, texto) {
    const logFile = path.join(LOGS_DIR, `${key.replace(/:/g, '-')}.log`);
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ---\n${texto}\n`);
    
    if (key.startsWith('127.0.0.1') || key.startsWith('localhost')) return;

    let printer = new ThermalPrinter({ 
        type: PrinterTypes.EPSON, 
        interface: `tcp://${key}`, 
        options: { timeout: 3000 }
    });

    // --- MEGA RENDERIZADOR v5.5 (ULTRA RESILIENTE) ---
    
    // 1. Corregir escapes literales que puedan venir del JSON (el error de \n impreso)
    let processedText = texto
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"');

    // 2. Normalizar saltos de línea
    processedText = processedText.replace(/\r\n/g, '\n');

    // 3. Procesar por líneas
    const lines = processedText.split('\n');

    for (let line of lines) {
        let currentLine = line;

        // Comando de CORTE
        if (currentLine.includes('[CUT]')) {
            printer.newLine();
            printer.newLine();
            printer.newLine();
            printer.cut();
            continue;
        }

        // Reset de estilos
        printer.alignLeft();
        printer.setTextNormal();
        printer.bold(false);

        // Procesar estilos
        if (currentLine.includes('[C]')) {
            printer.alignCenter();
            currentLine = currentLine.replace(/\[C\]/g, '').replace(/\[\/C\]/g, '');
        }
        if (currentLine.includes('[R]')) {
            printer.alignRight();
            currentLine = currentLine.replace(/\[R\]/g, '').replace(/\[\/R\]/g, '');
        }
        if (currentLine.includes('[B]')) {
            printer.bold(true);
            currentLine = currentLine.replace(/\[B\]/g, '').replace(/\[\/B\]/g, '');
        }
        if (currentLine.includes('[L]')) {
            printer.setTextDoubleHeight();
            printer.setTextDoubleWidth();
            currentLine = currentLine.replace(/\[L\]/g, '').replace(/\[\/L\]/g, '');
        }

        // Limpieza final de CUALQUIER etiqueta residual [XXX]
        currentLine = currentLine.replace(/\[\/?[A-Z0-9]+\]/g, '').trimRight();

        // Imprimir si tiene contenido o es un salto de línea intencional
        if (currentLine.length > 0 || line.length === 0) {
            printer.println(currentLine);
        }
    }

    try {
        await printer.execute();
    } catch (e) {
        throw new Error(e.message);
    }
}

async function main() {
    console.clear();
    console.log(chalk.blue.bold("============================================="));
    console.log(chalk.white.bold("   💠 AGENTE DE IMPRESIÓN IDA V1.0.1 STABLE  "));
    console.log(chalk.white.bold("   Motor: Ultra Resilient (Deduplicated)     "));
    console.log(chalk.blue.bold("============================================="));

    if (!fs.existsSync(CONFIG_FILE)) {
        await setupConfig();
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const choices = [
        { name: '▶️  Iniciar Servicio', value: 'run' },
        { name: '⚙️  Cambiar ID de Empresa o Impresoras', value: 'reset' },
        { name: '❌ Salir', value: 'exit' }
    ];

    const { choice } = await inquirer.prompt([{ type: 'list', name: 'choice', message: 'Acción:', choices }]);
    if (choice === 'exit') process.exit(0);
    if (choice === 'reset') { await setupConfig(); return main(); }

    startAgent(config);
}

async function setupConfig() {
    const data = await inquirer.prompt([
        { name: 'empresaId', message: 'ID de Empresa (Tenant):', default: '1' }
    ]);

    const impresoras = [];
    let addMore = true;
    while(addMore) {
        const imp = await inquirer.prompt([
            { name: 'ip', message: 'IP local de la impresora:', default: '192.168.1.100' },
            { name: 'puerto', message: 'Puerto:', default: 9100, type: 'number' },
            { name: 'tipo', message: 'Nombre:', choices: ['COCINA', 'BARRA', 'CAJA'], type: 'list' },
            { name: 'more', message: '¿Añadir otra?', type: 'confirm', default: false }
        ]);
        impresoras.push({ ip: imp.ip, puerto: imp.puerto, tipo: imp.tipo });
        addMore = imp.more;
    }
    const config = { ...data, impresoras };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function startAgent(config) {
    status.tenant = config.empresaId;
    
    const wsUrl = `wss://ida.analiticasoft.com/ws/impresion?tenant=${config.empresaId}`;
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', async () => { 
        status.connected = true; 
        drawDashboard(); 
        // Recuperar pendientes solo al abrir conexión
        await syncPendingJobs();
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
    console.log(chalk.white.bold(`   💠 AGENTE IDA v5.5 - EMPRESA: ${status.tenant}`));
    console.log(chalk.blue.bold("============================================="));
    console.log(`Estado: ${status.connected ? chalk.green("EN LÍNEA") : chalk.red("DESCONECTADO")}`);
    console.log("---------------------------------------------");
    Object.keys(status.printers).forEach(k => {
        const p = status.printers[k];
        console.log(`${k.padEnd(20)} | Cola: ${p.queue} | OK: ${p.totalPrints} | ${p.lastError ? chalk.red("ERR") : chalk.green("OK")}`);
    });
}

main().catch(err => { console.error(err); process.stdin.resume(); });
