const WebSocket = require('ws');
const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const chalk = require('chalk');
const axios = require('axios');
const { sanitizePrintableText, stripResidualTags } = require('./lib/format');
const { createRuntime } = require('./lib/runtime');

const BASE_URL = (process.env.IDA_BASE_URL || 'https://ida.analiticasoft.com').replace(/\/+$/, '');
const WS_ENDPOINT = process.env.IDA_WS_URL || `${BASE_URL.replace(/^http/i, 'ws')}/ws/impresion`;
const HTTP_TIMEOUT_MS = Number(process.env.IDA_HTTP_TIMEOUT_MS || 5000);
const PENDING_SYNC_INTERVAL_MS = Number(process.env.IDA_PENDING_SYNC_INTERVAL_MS || 60000);
const PENDING_ACK_INTERVAL_MS = Number(process.env.IDA_PENDING_ACK_INTERVAL_MS || 15000);
const WS_HEARTBEAT_INTERVAL_MS = Number(process.env.IDA_WS_HEARTBEAT_INTERVAL_MS || 30000);
const WS_RECONNECT_BASE_MS = Number(process.env.IDA_WS_RECONNECT_BASE_MS || 5000);
const WS_RECONNECT_MAX_MS = Number(process.env.IDA_WS_RECONNECT_MAX_MS || 30000);
const LOG_MAX_BYTES = Number(process.env.IDA_LOG_MAX_BYTES || 5 * 1024 * 1024);
const METRICS_FLUSH_DEBOUNCE_MS = Number(process.env.IDA_METRICS_FLUSH_DEBOUNCE_MS || 1000);
const METRICS_PORT = Number(process.env.IDA_METRICS_PORT || 8787);
const METRICS_HOST = process.env.IDA_METRICS_HOST || '127.0.0.1';
const METRICS_SNAPSHOT_INTERVAL_MS = Number(process.env.IDA_METRICS_SNAPSHOT_INTERVAL_MS || 60000);
const METRICS_HISTORY_MAX_ENTRIES = Number(process.env.IDA_METRICS_HISTORY_MAX_ENTRIES || 1440);

const CONFIG_FILE = path.join(process.cwd(), 'config_ida.json');
const LOGS_DIR = path.join(process.cwd(), 'logs_impresion');
const PENDING_ACKS_FILE = path.join(process.cwd(), 'pending_acks.json');
const METRICS_FILE = path.join(process.cwd(), 'driver_metrics.json');
const METRICS_HISTORY_FILE = path.join(process.cwd(), 'driver_metrics_history.json');
const AUDIT_LOG_FILE = path.join(process.cwd(), 'driver_job_audit.log');
const QUARANTINED_FILE = path.join(process.cwd(), 'driver_quarantined_jobs.json');
const REQUIRE_JOB_ID = process.env.IDA_REQUIRE_JOB_ID !== 'false';

if (!fs.existsSync(LOGS_DIR)) {
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}
}

const status = { connected: false, tenant: null, printers: {}, pendingAcks: 0, quarantinedJobs: 0 };
let metricsWriteTimer = null;
let metricsSnapshotTimer = null;
let metricsServer = null;

function writeJsonSafe(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

async function loadPendingAcks() {
  if (!fs.existsSync(PENDING_ACKS_FILE)) return [];
  try {
    const raw = fs.readFileSync(PENDING_ACKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function savePendingAcks(items) {
  writeJsonSafe(PENDING_ACKS_FILE, Array.isArray(items) ? items : []);
}

function scheduleMetricsWrite(metrics) {
  if (metricsWriteTimer) {
    clearTimeout(metricsWriteTimer);
  }
  metricsWriteTimer = setTimeout(() => {
    metricsWriteTimer = null;
    try {
      writeJsonSafe(METRICS_FILE, metrics || {});
    } catch (e) {}
  }, METRICS_FLUSH_DEBOUNCE_MS);
}

function appendAuditLine(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {}
}

function appendQuarantined(entry) {
  let arr = [];
  if (fs.existsSync(QUARANTINED_FILE)) {
    try {
      const raw = fs.readFileSync(QUARANTINED_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        arr = parsed;
      }
    } catch (e) {}
  }

  arr.push(entry);
  if (arr.length > 5000) {
    arr = arr.slice(arr.length - 5000);
  }

  try {
    writeJsonSafe(QUARANTINED_FILE, arr);
  } catch (e) {}
}

function appendMetricsSnapshot(metrics) {
  let history = [];
  if (fs.existsSync(METRICS_HISTORY_FILE)) {
    try {
      const raw = fs.readFileSync(METRICS_HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history = parsed;
      }
    } catch (e) {}
  }

  history.push({
    ts: new Date().toISOString(),
    ...metrics
  });

  if (history.length > METRICS_HISTORY_MAX_ENTRIES) {
    history = history.slice(history.length - METRICS_HISTORY_MAX_ENTRIES);
  }

  try {
    writeJsonSafe(METRICS_HISTORY_FILE, history);
  } catch (e) {}
}

function startObservabilityServer() {
  if (!Number.isFinite(METRICS_PORT) || METRICS_PORT <= 0) return;
  if (metricsServer) return;

  metricsServer = http.createServer((req, res) => {
    const url = req.url || '/';
    const now = new Date().toISOString();

    if (url === '/health') {
      const payload = {
        ok: true,
        ts: now,
        status: runtime.getStatus(),
        metrics: runtime.getMetrics()
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url === '/metrics') {
      const payload = runtime.getMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not-found' }));
  });

  metricsServer.listen(METRICS_PORT, METRICS_HOST, () => {
    console.log(chalk.gray(`Observabilidad en http://${METRICS_HOST}:${METRICS_PORT} (/health, /metrics)`));
  });

  metricsSnapshotTimer = setInterval(() => {
    appendMetricsSnapshot(runtime.getMetrics());
  }, METRICS_SNAPSHOT_INTERVAL_MS);
}

function stopObservabilityServer() {
  if (metricsWriteTimer) {
    clearTimeout(metricsWriteTimer);
    metricsWriteTimer = null;
  }
  if (metricsSnapshotTimer) {
    clearInterval(metricsSnapshotTimer);
    metricsSnapshotTimer = null;
  }
  appendMetricsSnapshot(runtime.getMetrics());

  if (!metricsServer) return Promise.resolve();
  const toClose = metricsServer;
  metricsServer = null;
  return new Promise((resolve) => {
    toClose.close(() => resolve());
  });
}

function drawDashboard() {
  process.stdout.write('\033[H\033[2J');
  console.log(chalk.blue.bold('============================================='));
  console.log(chalk.white.bold(`   💠 AGENTE IDA v6.0 - EMPRESA: ${status.tenant}`));
  console.log(chalk.blue.bold('============================================='));
  console.log(`Estado: ${status.connected ? chalk.green('EN LÍNEA') : chalk.red('DESCONECTADO')}`);
  console.log(`Confirmaciones pendientes: ${status.pendingAcks}`);
  console.log(`En cuarentena (sin ID): ${status.quarantinedJobs}`);
  console.log('---------------------------------------------');
  Object.keys(status.printers).forEach((k) => {
    const p = status.printers[k];
    console.log(`${k.padEnd(20)} | Cola: ${p.queue} | OK: ${p.totalPrints} | ${p.lastError ? chalk.red('ERR') : chalk.green('OK')}`);
  });
}

function rotateLogIfNeeded(logFile) {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size < LOG_MAX_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = logFile.replace(/\.log$/i, `.${stamp}.log`);
    fs.renameSync(logFile, rotated);
  } catch (e) {}
}

async function executePrint(key, texto) {
  const logFile = path.join(LOGS_DIR, `${key.replace(/:/g, '-')}.log`);
  rotateLogIfNeeded(logFile);
  fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ---\n${texto}\n`);

  if (key.startsWith('127.0.0.1') || key.startsWith('localhost')) return;

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${key}`,
    options: { timeout: 3000 }
  });

  const processedText = sanitizePrintableText(texto);
  const lines = processedText.split('\n');

  for (const line of lines) {
    let currentLine = line;

    if (currentLine.includes('[CUT]')) {
      printer.newLine();
      printer.newLine();
      printer.newLine();
      printer.cut();
      continue;
    }

    printer.alignLeft();
    printer.setTextNormal();
    printer.bold(false);

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

    currentLine = stripResidualTags(currentLine);
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

async function fetchPendingJobs(tenant) {
  const resp = await axios.get(`${BASE_URL}/api/public/impresion/${tenant}/pendientes`, {
    timeout: HTTP_TIMEOUT_MS
  });
  return (resp.data && resp.data.data) || [];
}

async function markAsCompleted(jobId) {
  await axios.post(`${BASE_URL}/api/public/impresion/${jobId}/completar`, {}, {
    timeout: HTTP_TIMEOUT_MS
  });
}

const runtime = createRuntime({
  executePrint,
  fetchPendingJobs,
  markAsCompleted,
  loadPendingAcks,
  savePendingAcks,
  createWebSocket: (url) => new WebSocket(url),
  onStateChange: (nextStatus) => {
    status.connected = nextStatus.connected;
    status.tenant = nextStatus.tenant;
    status.printers = nextStatus.printers;
    status.pendingAcks = nextStatus.pendingAcks;
    status.quarantinedJobs = nextStatus.quarantinedJobs;
    drawDashboard();
  },
  onMetrics: (metrics) => {
    scheduleMetricsWrite(metrics);
  },
  onAudit: (entry) => {
    appendAuditLine(entry);
    if (entry && entry.event === 'job_quarantined') {
      appendQuarantined(entry);
    }
  },
  logger: console
}, {
  wsEndpoint: WS_ENDPOINT,
  pendingSyncIntervalMs: PENDING_SYNC_INTERVAL_MS,
  pendingAckIntervalMs: PENDING_ACK_INTERVAL_MS,
  wsHeartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
  wsReconnectBaseMs: WS_RECONNECT_BASE_MS,
  wsReconnectMaxMs: WS_RECONNECT_MAX_MS,
  requireJobId: REQUIRE_JOB_ID
});

async function setupConfig() {
  const data = await inquirer.prompt([
    { name: 'empresaId', message: 'ID de Empresa (Tenant):', default: '1' }
  ]);

  const impresoras = [];
  let addMore = true;
  while (addMore) {
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

async function main() {
  console.clear();
  console.log(chalk.blue.bold('============================================='));
  console.log(chalk.white.bold('   💠 AGENTE DE IMPRESIÓN IDA V1.0.1 STABLE  '));
  console.log(chalk.white.bold('   Motor: Runtime Modular (Ack Queue)        '));
  console.log(chalk.blue.bold('============================================='));

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
  if (choice === 'reset') {
    await setupConfig();
    return main();
  }

  runtime.start(config);
  startObservabilityServer();
}

process.on('SIGINT', () => {
  Promise.resolve()
    .then(() => stopObservabilityServer())
    .then(() => runtime.stop())
    .finally(() => process.exit(0));
});

main().catch((err) => {
  console.error(err);
  process.stdin.resume();
});
