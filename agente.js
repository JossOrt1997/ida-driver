const WebSocket = require('ws');
const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const chalk = require('chalk');
const axios = require('axios');
const { sanitizePrintableText, stripResidualTags } = require('./lib/format');
const { createRuntime } = require('./lib/runtime');

const CERTS_DIR = path.join(process.cwd(), 'certs');
const CERT_KEY = process.env.IDA_TLS_KEY || path.join(CERTS_DIR, 'ida_peripheral.key');
const CERT_CRT = process.env.IDA_TLS_CERT || path.join(CERTS_DIR, 'ida_fullchain.crt');

const BASE_URL = (process.env.IDA_BASE_URL || 'https://ida.analiticasoft.com').replace(/\/+$/, '');
const WS_ENDPOINT = process.env.IDA_WS_URL || `${BASE_URL.replace(/^http/i, 'ws')}/ws/impresion`;
const PRINT_DRIVER_TOKEN = process.env.IDA_PRINT_DRIVER_TOKEN || process.env.SECURITY_PRINT_DRIVER_TOKEN || '';

function getConfiguredPrintDriverToken() {
  return (activeConfig && (activeConfig.printDriverToken || activeConfig.securityPrintDriverToken))
    || PRINT_DRIVER_TOKEN;
}

function getConfiguredDriverAccessId() {
  return activeConfig && activeConfig.driverAccessId ? String(activeConfig.driverAccessId) : '';
}

function getConfiguredBaseUrl() {
  return ((activeConfig && activeConfig.baseUrl) || BASE_URL).replace(/\/+$/, '');
}

function getConfiguredWsEndpoint() {
  const configured = activeConfig && activeConfig.wsEndpoint;
  return configured || `${getConfiguredBaseUrl().replace(/^http/i, 'ws')}/ws/impresion`;
}

function getTenantPrintToken(tenant, rootSecret = getConfiguredPrintDriverToken()) {
  if (!rootSecret || !tenant) return '';
  return crypto
    .createHmac('sha256', rootSecret)
    .update(`print-driver:${tenant}`)
    .digest('base64url');
}

function printAuthHeaders(tenant) {
  const tenantToken = getTenantPrintToken(tenant, getConfiguredPrintDriverToken());
  return tenantToken ? { 'X-Print-Token': tenantToken } : undefined;
}

function parseEnvNumber(name, fallback, { min = null, max = null } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (min !== null && n < min) return fallback;
  if (max !== null && n > max) return fallback;
  return Math.trunc(n);
}

const HTTP_TIMEOUT_MS = parseEnvNumber('IDA_HTTP_TIMEOUT_MS', 5000, { min: 500, max: 120000 });
const PENDING_SYNC_INTERVAL_MS = parseEnvNumber('IDA_PENDING_SYNC_INTERVAL_MS', 60000, { min: 1000, max: 3600000 });
const PENDING_ACK_INTERVAL_MS = parseEnvNumber('IDA_PENDING_ACK_INTERVAL_MS', 15000, { min: 1000, max: 3600000 });
const WS_HEARTBEAT_INTERVAL_MS = parseEnvNumber('IDA_WS_HEARTBEAT_INTERVAL_MS', 30000, { min: 1000, max: 3600000 });
const WS_RECONNECT_BASE_MS = parseEnvNumber('IDA_WS_RECONNECT_BASE_MS', 5000, { min: 500, max: 120000 });
const WS_RECONNECT_MAX_MS = parseEnvNumber('IDA_WS_RECONNECT_MAX_MS', 30000, { min: 1000, max: 300000 });
const LOG_MAX_BYTES = parseEnvNumber('IDA_LOG_MAX_BYTES', 5 * 1024 * 1024, { min: 65536, max: 268435456 });
const METRICS_FLUSH_DEBOUNCE_MS = parseEnvNumber('IDA_METRICS_FLUSH_DEBOUNCE_MS', 1000, { min: 50, max: 60000 });
const METRICS_PORT = parseEnvNumber('IDA_METRICS_PORT', 8787, { min: 1, max: 65535 });
const METRICS_HOST = process.env.IDA_METRICS_HOST || '127.0.0.1';
const METRICS_SNAPSHOT_INTERVAL_MS = parseEnvNumber('IDA_METRICS_SNAPSHOT_INTERVAL_MS', 60000, { min: 1000, max: 86400000 });
const METRICS_HISTORY_MAX_ENTRIES = parseEnvNumber('IDA_METRICS_HISTORY_MAX_ENTRIES', 1440, { min: 10, max: 200000 });
const DEEP_HEALTH_TCP_TIMEOUT_MS = parseEnvNumber('IDA_DEEP_HEALTH_TCP_TIMEOUT_MS', 1500, { min: 200, max: 10000 });

const CONFIG_FILE = path.join(process.cwd(), 'config_ida.json');
const LOGS_DIR = path.join(process.cwd(), 'logs_impresion');
const PENDING_ACKS_FILE = path.join(process.cwd(), 'pending_acks.json');
const METRICS_FILE = path.join(process.cwd(), 'driver_metrics.json');
const METRICS_HISTORY_FILE = path.join(process.cwd(), 'driver_metrics_history.json');
const AUDIT_LOG_FILE = path.join(process.cwd(), 'driver_job_audit.log');
const QUARANTINED_FILE = path.join(process.cwd(), 'driver_quarantined_jobs.json');
const REQUIRE_JOB_ID = process.env.IDA_REQUIRE_JOB_ID !== 'false';
const ENFORCE_PRINTER_ALLOWLIST = process.env.IDA_ENFORCE_PRINTER_ALLOWLIST !== 'false';

if (!fs.existsSync(LOGS_DIR)) {
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}
}

const status = { connected: false, tenant: null, printers: {}, pendingAcks: 0, quarantinedJobs: 0 };
let metricsWriteTimer = null;
let metricsSnapshotTimer = null;
let metricsServer = null;
let activeConfig = null;

function checkPrinterTcp(ip, puerto, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (ok, error = null) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) {}
      resolve({
        ip,
        puerto,
        ok,
        latencyMs: Date.now() - startedAt,
        error
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err && err.message ? err.message : 'connect-error'));

    try {
      socket.connect(Number(puerto), ip);
    } catch (err) {
      finish(false, err && err.message ? err.message : 'invalid-address');
    }
  });
}

async function runDeepHealthCheck() {
  return runDeepHealthCheckWithRetries(1, true);
}

async function runDeepHealthCheckWithRetries(retries, parallelChecks = true) {
  const printers = Array.isArray(activeConfig && activeConfig.impresoras) ? activeConfig.impresoras : [];
  if (printers.length === 0) {
    return {
      ok: true,
      checked: 0,
      healthy: 0,
      unhealthy: 0,
      avgLatencyMs: 0,
      timeoutMs: DEEP_HEALTH_TCP_TIMEOUT_MS,
      printers: []
    };
  }

  const safeRetries = Number.isFinite(retries) ? Math.max(1, Math.min(5, Math.trunc(retries))) : 1;

  async function checkWithRetries(ip, puerto) {
    let last = null;
    for (let attempt = 1; attempt <= safeRetries; attempt += 1) {
      const current = await checkPrinterTcp(ip, puerto, DEEP_HEALTH_TCP_TIMEOUT_MS);
      if (current.ok) {
        return { ...current, attempts: attempt };
      }
      last = current;
    }
    return { ...(last || { ip, puerto, ok: false, latencyMs: 0, error: 'unknown' }), attempts: safeRetries };
  }

  let checks = [];
  if (parallelChecks) {
    checks = await Promise.all(
      printers.map((p) => checkWithRetries(p.ip, p.puerto || 9100))
    );
  } else {
    for (const p of printers) {
      checks.push(await checkWithRetries(p.ip, p.puerto || 9100));
    }
  }

  const healthy = checks.filter((c) => c.ok).length;
  const unhealthy = checks.length - healthy;
  const avgLatencyMs = Math.round(checks.reduce((sum, c) => sum + (c.latencyMs || 0), 0) / checks.length);

  return {
    ok: unhealthy === 0,
    checked: checks.length,
    healthy,
    unhealthy,
    avgLatencyMs,
    timeoutMs: DEEP_HEALTH_TCP_TIMEOUT_MS,
    retries: safeRetries,
    parallel: parallelChecks,
    printers: checks
  };
}

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

  const requestHandler = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Print-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const isSecure = Boolean(req.socket && req.socket.encrypted);
    const proto = isSecure ? 'https' : 'http';
    const parsedUrl = new URL(req.url || '/', `${proto}://${METRICS_HOST}:${METRICS_PORT}`);
    const url = parsedUrl.pathname || '/';
    const now = new Date().toISOString();

    if (url === '/health') {
      const payload = {
        ok: true,
        ts: now,
        tls: isSecure,
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

    if (url === '/health/deep') {
      const retriesParam = parsedUrl.searchParams.get('retries');
      const retries = retriesParam ? Number(retriesParam) : 1;
      const parallelParam = parsedUrl.searchParams.get('parallel');
      const parallelChecks = parallelParam !== 'false';
      runDeepHealthCheckWithRetries(retries, parallelChecks)
        .then((deep) => {
          const payload = {
            ok: deep.ok,
            ts: now,
            tls: isSecure,
            deep,
            status: runtime.getStatus(),
            metrics: runtime.getMetrics()
          };
          res.writeHead(deep.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : 'deep-health-error' }));
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not-found' }));
  };

  const hasTls = fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT);
  if (hasTls) {
    try {
      const tlsOptions = {
        key: fs.readFileSync(CERT_KEY),
        cert: fs.readFileSync(CERT_CRT)
      };
      metricsServer = https.createServer(tlsOptions, requestHandler);
      metricsServer.listen(METRICS_PORT, METRICS_HOST, () => {
        console.log(chalk.green(`🔒 Driver Seguro (HTTPS) en https://${METRICS_HOST}:${METRICS_PORT} (/health, /metrics)`));
      });
    } catch (tlsErr) {
      console.log(chalk.yellow(`⚠️ Error cargando certificados TLS (${tlsErr.message}). Iniciando HTTP estándar...`));
      metricsServer = http.createServer(requestHandler);
      metricsServer.listen(METRICS_PORT, METRICS_HOST, () => {
        console.log(chalk.gray(`Observabilidad en http://${METRICS_HOST}:${METRICS_PORT}`));
      });
    }
  } else {
    metricsServer = http.createServer(requestHandler);
    metricsServer.listen(METRICS_PORT, METRICS_HOST, () => {
      console.log(chalk.gray(`Observabilidad en http://${METRICS_HOST}:${METRICS_PORT} (/health, /health/deep, /metrics)`));
    });
  }

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
  const connection = status.connected ? chalk.bgGreen.black(' EN LINEA ') : chalk.bgRed.white(' DESCONECTADO ');
  const lastEvent = status.lastConnectedAt || status.lastDisconnectedAt;
  const sync = status.lastSyncAt ? `ultima sincronizacion ${formatDashboardTime(status.lastSyncAt)}` : 'sin sincronizacion';

  console.log(chalk.cyan.bold('┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.cyan.bold('│ ') + chalk.white.bold(`IDA PRINT CENTER  |  ${status.connected ? 'Empresa conectada' : 'Preparando conexión'}`.padEnd(59)) + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('├─────────────────────────────────────────────────────────────┤'));
  console.log(chalk.cyan.bold('│ ') + `Conexion: ${connection}  ${sync}`.padEnd(59) + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('│ ') + `Cola de confirmaciones: ${status.pendingAcks}  |  Cuarentena: ${status.quarantinedJobs}`.padEnd(59) + chalk.cyan.bold('│'));
  if (status.lastError) {
    console.log(chalk.cyan.bold('│ ') + chalk.yellow(`Aviso: ${status.lastError}`.slice(0, 57).padEnd(59)) + chalk.cyan.bold('│'));
  } else if (lastEvent) {
    console.log(chalk.cyan.bold('│ ') + `Ultimo evento: ${formatDashboardTime(lastEvent)}`.padEnd(59) + chalk.cyan.bold('│'));
  }
  console.log(chalk.cyan.bold('├─────────────────────────────────────────────────────────────┤'));
  console.log(chalk.cyan.bold('│ ') + chalk.white.bold('IMPRESORAS'.padEnd(59)) + chalk.cyan.bold('│'));

  const printers = Object.entries(status.printers || {});
  if (printers.length === 0) {
    console.log(chalk.cyan.bold('│ ') + chalk.gray('No hay impresoras configuradas'.padEnd(59)) + chalk.cyan.bold('│'));
  } else {
    printers.forEach(([key, printer]) => {
      const state = printer.lastError ? chalk.red('ERROR') : chalk.green('LISTA');
      const line = `${key.padEnd(25)} ${state}  cola ${String(printer.queue).padStart(3)}  impresos ${printer.totalPrints}`;
      console.log(chalk.cyan.bold('│ ') + line.slice(0, 59).padEnd(59) + chalk.cyan.bold('│'));
    });
  }
  console.log(chalk.cyan.bold('├─────────────────────────────────────────────────────────────┤'));
  console.log(chalk.cyan.bold('│ ') + chalk.gray('Health: http://127.0.0.1:' + METRICS_PORT + '/health'.padEnd(45)) + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('│ ') + chalk.gray('Ctrl+C para detener el servicio'.padEnd(59)) + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('└─────────────────────────────────────────────────────────────┘'));
}

function formatDashboardTime(value) {
  try {
    return new Date(value).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '-';
  }
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

    const imageMatch = currentLine.match(/\[IMG:(.+?)\]/i);
    if (imageMatch) {
      const imageUrl = (imageMatch[1] || '').trim();
      if (imageUrl) {
        const imageLocalPath = await resolveImageToLocalPath(imageUrl);
        if (imageLocalPath) {
          try {
            await printer.printImage(imageLocalPath);
          } catch (imgErr) {
            fs.appendFileSync(logFile, `\n[WARN] No se pudo imprimir imagen ${imageUrl}: ${imgErr.message}\n`);
          }
        }
      }
      currentLine = currentLine.replace(/\[IMG:.+?\]/ig, '').trim();
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

async function resolveImageToLocalPath(imageUrl) {
  try {
    let finalUrl = imageUrl;
    if (!/^https?:\/\//i.test(finalUrl)) {
      if (finalUrl.startsWith('/')) {
        finalUrl = `${getConfiguredBaseUrl()}${finalUrl}`;
      } else {
        finalUrl = `${getConfiguredBaseUrl()}/${finalUrl}`;
      }
    }

    const parsed = new URL(finalUrl);
    const extRaw = path.extname(parsed.pathname || '').toLowerCase();
    const ext = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'].includes(extRaw) ? extRaw : '.png';
    const tmpFile = path.join(LOGS_DIR, `logo-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);

    const response = await axios.get(finalUrl, {
      responseType: 'arraybuffer',
      timeout: HTTP_TIMEOUT_MS
    });

    fs.writeFileSync(tmpFile, Buffer.from(response.data));
    return tmpFile;
  } catch (e) {
    return null;
  }
}

async function fetchPendingJobs(tenant) {
  const accessId = getConfiguredDriverAccessId();
  const url = accessId
    ? `${getConfiguredBaseUrl()}/api/public/impresion/driver/${encodeURIComponent(accessId)}/pendientes`
    : `${getConfiguredBaseUrl()}/api/public/impresion/${tenant}/pendientes`;
  const resp = await axios.get(url, {
    headers: printAuthHeaders(tenant),
    timeout: HTTP_TIMEOUT_MS
  });
  return (resp.data && resp.data.data) || [];
}

async function markAsCompleted(jobId) {
  const tenantId = (activeConfig && activeConfig.empresaId) ? String(activeConfig.empresaId) : '';
  const accessId = getConfiguredDriverAccessId();
  const completeUrl = accessId
    ? `${getConfiguredBaseUrl()}/api/public/impresion/driver/${encodeURIComponent(accessId)}/ack/${encodeURIComponent(jobId)}`
    : tenantId
    ? `${getConfiguredBaseUrl()}/api/public/impresion/${jobId}/completar?tenantId=${encodeURIComponent(tenantId)}`
    : `${getConfiguredBaseUrl()}/api/public/impresion/${jobId}/completar`;

  await axios.post(completeUrl, {}, {
    headers: printAuthHeaders(tenantId),
    timeout: HTTP_TIMEOUT_MS
  });
}

async function markAsFailed(jobId, message) {
  const tenantId = (activeConfig && activeConfig.empresaId) ? String(activeConfig.empresaId) : '';
  const accessId = getConfiguredDriverAccessId();
  const errorUrl = accessId
    ? `${getConfiguredBaseUrl()}/api/public/impresion/driver/${encodeURIComponent(accessId)}/error/${encodeURIComponent(jobId)}`
    : `${getConfiguredBaseUrl()}/api/public/impresion/${encodeURIComponent(jobId)}/error`;
  await axios.post(errorUrl, {}, {
    params: {
      ...(accessId ? {} : { tenantId }),
      message: String(message || 'print-failed').slice(0, 1000)
    },
    headers: printAuthHeaders(tenantId),
    timeout: HTTP_TIMEOUT_MS
  });
}

const runtime = createRuntime({
  executePrint,
  fetchPendingJobs,
  markAsCompleted,
  markAsFailed,
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
  getPrintDriverToken: () => getConfiguredPrintDriverToken(),
  getDriverAccessId: () => getConfiguredDriverAccessId(),
  getWsEndpoint: () => getConfiguredWsEndpoint(),
  logger: console
}, {
  wsEndpoint: WS_ENDPOINT,
  printDriverToken: PRINT_DRIVER_TOKEN,
  pendingSyncIntervalMs: PENDING_SYNC_INTERVAL_MS,
  pendingAckIntervalMs: PENDING_ACK_INTERVAL_MS,
  wsHeartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
  wsReconnectBaseMs: WS_RECONNECT_BASE_MS,
  wsReconnectMaxMs: WS_RECONNECT_MAX_MS,
  requireJobId: REQUIRE_JOB_ID,
  enforcePrinterAllowlist: ENFORCE_PRINTER_ALLOWLIST
});

async function setupConfig() {
  const data = await inquirer.prompt([
    { name: 'empresaId', message: 'Número de empresa (sólo si te lo pidió soporte, opcional):', default: '' },
    { name: 'baseUrl', message: 'URL del servidor IDA:', default: BASE_URL },
    { name: 'driverAccessId', message: 'Código de conexión de tu empresa:', type: 'password', mask: '*' },
    {
      name: 'printDriverToken',
      message: 'Token del driver:',
      type: 'password',
      mask: '*',
      default: PRINT_DRIVER_TOKEN
    }
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

  const token = data.printDriverToken || PRINT_DRIVER_TOKEN;
  if (!token && !data.driverAccessId) {
    throw new Error('Escribe el código de conexión de tu empresa para continuar.');
  }
  const config = { ...data, printDriverToken: token, impresoras };
  saveDriverConfig(config);
}

function saveDriverConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function maskSecret(value) {
  if (!value) return 'No configurado';
  const text = String(value);
  return text.length > 8 ? `${text.slice(0, 4)}••••${text.slice(-4)}` : 'Configurado';
}

async function waitForEnter() {
  await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Presiona Enter para volver al menú' }]);
}

async function showDriverStatus(config) {
  console.clear();
  console.log(chalk.cyan.bold('\n  ESTADO DEL DRIVER\n'));
  console.log(`  Servicio:       ${status.connected ? chalk.green('Conectado') : chalk.yellow('Esperando conexión')}`);
  console.log(`  Empresa:        ${status.connected ? chalk.green('Identificada correctamente') : 'Pendiente de identificar'}`);
  console.log(`  Código:         ${maskSecret(config.driverAccessId)}`);
  console.log(`  Servidor:       ${config.baseUrl}`);
  console.log(`  Trabajos en espera de confirmación: ${status.pendingAcks}`);
  console.log('\n  IMPRESORAS');

  const printers = Array.isArray(config.impresoras) ? config.impresoras : [];
  if (printers.length === 0) {
    console.log(chalk.yellow('  No hay impresoras configuradas.'));
  } else {
    const checks = await Promise.all(printers.map((printer) =>
      checkPrinterTcp(printer.ip, printer.puerto || 9100, 1200)
    ));
    checks.forEach((check, index) => {
      const printer = printers[index];
      const label = printer.tipo || `Impresora ${index + 1}`;
      const state = check.ok ? chalk.green('Disponible') : chalk.red('No responde');
      console.log(`  ${label}: ${state} (${printer.ip}:${printer.puerto || 9100})`);
    });
  }
  console.log('');
  await waitForEnter();
}

async function editConnection(config) {
  const data = await inquirer.prompt([
    { name: 'baseUrl', message: 'Servidor de IDA:', default: config.baseUrl || BASE_URL },
    {
      name: 'driverAccessId',
      message: 'Nuevo código de conexión (deja vacío para conservarlo):',
      type: 'password',
      mask: '*'
    }
  ]);

  if (data.baseUrl) config.baseUrl = data.baseUrl.replace(/\/+$/, '');
  if (data.driverAccessId) config.driverAccessId = data.driverAccessId;
  saveDriverConfig(config);
  console.log(chalk.green('\n  Conexión actualizada.\n'));
  await waitForEnter();
}

async function managePrinters(config) {
  if (!Array.isArray(config.impresoras)) config.impresoras = [];
  let leave = false;
  while (!leave) {
    console.clear();
    console.log(chalk.cyan.bold('\n  IMPRESORAS\n'));
    if (config.impresoras.length === 0) {
      console.log(chalk.gray('  Todavía no has agregado impresoras.\n'));
    } else {
      config.impresoras.forEach((printer, index) => {
        console.log(`  ${index + 1}. ${printer.tipo || 'Impresora'} - ${printer.ip}:${printer.puerto || 9100}`);
      });
      console.log('');
    }

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '¿Qué deseas hacer?',
      choices: [
        { name: 'Agregar una impresora', value: 'add' },
        { name: 'Eliminar una impresora', value: 'remove', disabled: config.impresoras.length === 0 ? 'No hay impresoras' : false },
        { name: 'Volver al menú principal', value: 'back' }
      ]
    }]);

    if (action === 'back') {
      leave = true;
      continue;
    }
    if (action === 'add') {
      const printer = await inquirer.prompt([
        { name: 'ip', message: 'Dirección de la impresora:', validate: (value) => Boolean(value) || 'Escribe una dirección' },
        { name: 'puerto', message: 'Puerto de impresión:', default: 9100, type: 'number' },
        { name: 'tipo', message: '¿Dónde está?', choices: ['COCINA', 'BARRA', 'CAJA', 'OTRA'], type: 'list' }
      ]);
      config.impresoras.push({ ip: printer.ip, puerto: printer.puerto, tipo: printer.tipo });
      saveDriverConfig(config);
      console.log(chalk.green('\n  Impresora agregada.'));
      await waitForEnter();
    }
    if (action === 'remove') {
      const { index } = await inquirer.prompt([{
        type: 'list',
        name: 'index',
        message: 'Elige la impresora que deseas eliminar:',
        choices: config.impresoras.map((printer, i) => ({
          name: `${printer.tipo || 'Impresora'} - ${printer.ip}:${printer.puerto || 9100}`,
          value: i
        }))
      }]);
      const printer = config.impresoras[index];
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `¿Eliminar ${printer.tipo || 'esta impresora'}?`,
        default: false
      }]);
      if (confirmed) {
        config.impresoras.splice(index, 1);
        saveDriverConfig(config);
        console.log(chalk.green('\n  Impresora eliminada.'));
      }
      await waitForEnter();
    }
  }
}

async function deleteLocalConfiguration() {
  const { confirmed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    message: 'Esto desconectará el driver y borrará su configuración local. ¿Continuar?',
    default: false
  }]);
  if (!confirmed) return false;
  fs.unlinkSync(CONFIG_FILE);
  console.log(chalk.green('\n  Configuración local eliminada. Puedes volver a configurarlo cuando quieras.\n'));
  await waitForEnter();
  return true;
}

async function main() {
  console.clear();
  console.log(chalk.blue.bold('============================================='));
  console.log(chalk.white.bold('   IDA PRINT DRIVER 2.0.0 STABLE            '));
  console.log(chalk.white.bold('   Motor: Runtime Modular (Ack Queue)        '));
  console.log(chalk.blue.bold('============================================='));

  if (!fs.existsSync(CONFIG_FILE)) {
    await setupConfig();
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!config.printDriverToken && PRINT_DRIVER_TOKEN) {
    config.printDriverToken = PRINT_DRIVER_TOKEN;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  const hasDriverAccessId = Boolean(config.driverAccessId);
  if (hasDriverAccessId && !String(config.driverAccessId).match(/^[A-Za-z0-9_-]{64}$/)) {
    throw new Error('config_ida.json tiene un driverAccessId inválido.');
  }
  if (!hasDriverAccessId && (!config.empresaId || !String(config.empresaId).match(/^[1-9][0-9]*$/))) {
    throw new Error('config_ida.json requiere empresaId para compatibilidad legacy.');
  }
  let serverUrl;
  try {
    serverUrl = new URL(config.baseUrl || BASE_URL);
  } catch (e) {
    throw new Error('config_ida.json tiene una URL de servidor inválida.');
  }
  if (!['http:', 'https:'].includes(serverUrl.protocol)) {
    throw new Error('La URL del servidor debe usar http o https.');
  }
  config.baseUrl = serverUrl.toString().replace(/\/+$/, '');
  activeConfig = config;
  if (!getConfiguredPrintDriverToken() && !getConfiguredDriverAccessId()) {
    console.log(chalk.yellow('\n  Esta instalación todavía no tiene un código de conexión. Vamos a configurarla en pantalla.\n'));
    await editConnection(config);
    return main();
  }
  const choices = [
    { name: '▶️  Iniciar servicio', value: 'run' },
    { name: '📊  Ver estado de conexión e impresoras', value: 'status' },
    { name: '🔑  Cambiar código de conexión', value: 'connection' },
    { name: '🖨️  Administrar impresoras', value: 'printers' },
    { name: '🧹  Borrar configuración de este equipo', value: 'delete' },
    { name: '❌ Salir', value: 'exit' }
  ];

  const { choice } = await inquirer.prompt([{ type: 'list', name: 'choice', message: '¿Qué deseas hacer?', choices }]);
  if (choice === 'exit') process.exit(0);
  if (choice === 'status') {
    await showDriverStatus(config);
    return main();
  }
  if (choice === 'connection') {
    await editConnection(config);
    return main();
  }
  if (choice === 'printers') {
    await managePrinters(config);
    return main();
  }
  if (choice === 'delete') {
    if (await deleteLocalConfiguration()) return main();
    return main();
  }

  runtime.start(config);
  startObservabilityServer();
}

async function shutdownAndExit() {
  await Promise.resolve()
    .then(() => stopObservabilityServer())
    .then(() => runtime.stop());
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdownAndExit().catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdownAndExit().catch(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.message ? err.message : err);
  shutdownAndExit().catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && reason.message ? reason.message : reason);
  shutdownAndExit().catch(() => process.exit(1));
});

main().catch((err) => {
  console.error(err);
  process.stdin.resume();
});
