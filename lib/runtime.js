const { createQueueState, enqueueJob, nextRetryDelay } = require('./queue');

function createRuntime(deps, options = {}) {
  const {
    executePrint,
    fetchPendingJobs,
    markAsCompleted,
    createWebSocket,
    onStateChange,
    loadPendingAcks,
    savePendingAcks,
    onMetrics,
    logger = console
  } = deps;

  if (typeof executePrint !== 'function') {
    throw new Error('createRuntime requires executePrint function');
  }

  const cfg = {
    wsEndpoint: options.wsEndpoint,
    pendingSyncIntervalMs: options.pendingSyncIntervalMs || 60000,
    pendingAckIntervalMs: options.pendingAckIntervalMs || 15000,
    wsHeartbeatIntervalMs: options.wsHeartbeatIntervalMs || 30000,
    wsReconnectBaseMs: options.wsReconnectBaseMs || 5000,
    wsReconnectMaxMs: options.wsReconnectMaxMs || 30000,
    pendingAckPersistDebounceMs: options.pendingAckPersistDebounceMs || 250
  };

  const queueState = createQueueState();
  const status = {
    connected: false,
    tenant: null,
    printers: queueState.status.printers,
    pendingAcks: 0
  };
  const metrics = {
    prints_ok: 0,
    prints_error: 0,
    acks_ok: 0,
    ack_retries: 0,
    ws_messages: 0,
    ws_reconnects: 0,
    pending_synced: 0,
    pending_acks: 0,
    updated_at: new Date().toISOString()
  };

  let ws = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let syncInProgress = false;
  let ackFlushInProgress = false;
  let heartbeatTimer = null;
  let pendingSyncTimer = null;
  let pendingAckTimer = null;
  let reconnectTimer = null;
  let pendingAckPersistTimer = null;
  let isAlive = true;

  const queueTimers = new Map();
  const pendingAcks = new Map();

  function emitMetrics() {
    metrics.pending_acks = pendingAcks.size;
    metrics.updated_at = new Date().toISOString();
    if (typeof onMetrics === 'function') {
      onMetrics({ ...metrics });
    }
  }

  function emitState() {
    status.pendingAcks = pendingAcks.size;
    if (typeof onStateChange === 'function') {
      onStateChange(status);
    }
    emitMetrics();
  }

  function queueKey(ip, puerto) {
    return `${ip}:${puerto}`;
  }

  function serializePendingAcks() {
    return Array.from(pendingAcks.values()).map((ack) => ({
      jobId: ack.jobId,
      attempts: ack.attempts || 0,
      lastError: ack.lastError || null
    }));
  }

  function schedulePendingAckPersist() {
    if (typeof savePendingAcks !== 'function') return;
    if (pendingAckPersistTimer) {
      clearTimeout(pendingAckPersistTimer);
    }
    pendingAckPersistTimer = setTimeout(async () => {
      pendingAckPersistTimer = null;
      try {
        await savePendingAcks(serializePendingAcks());
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('⚠️ No se pudo persistir pendingAcks:', err && err.message ? err.message : err);
        }
      }
    }, cfg.pendingAckPersistDebounceMs);
  }

  async function hydratePendingAcks() {
    if (typeof loadPendingAcks !== 'function') return;
    try {
      const loaded = await loadPendingAcks();
      (loaded || []).forEach((item) => {
        if (!item || item.jobId === undefined || item.jobId === null) return;
        const id = String(item.jobId);
        pendingAcks.set(id, {
          jobId: item.jobId,
          attempts: Number(item.attempts || 0),
          lastError: item.lastError || null
        });
      });
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('⚠️ No se pudo cargar pendingAcks:', err && err.message ? err.message : err);
      }
    }
  }

  function scheduleQueueRun(key, delayMs) {
    if (queueTimers.has(key)) {
      clearTimeout(queueTimers.get(key));
    }
    const timer = setTimeout(() => {
      queueTimers.delete(key);
      processQueue(key).catch(() => {});
    }, delayMs);
    queueTimers.set(key, timer);
  }

  async function tryMarkCompleted(jobId) {
    if (!jobId || typeof markAsCompleted !== 'function') return false;
    try {
      await markAsCompleted(jobId);
      metrics.acks_ok += 1;
      emitMetrics();
      return true;
    } catch (e) {
      return false;
    }
  }

  function enqueuePendingAck(jobId) {
    if (!jobId) return;
    const id = String(jobId);
    if (!pendingAcks.has(id)) {
      pendingAcks.set(id, { jobId, attempts: 0, lastError: null });
      schedulePendingAckPersist();
    }
    emitState();
  }

  async function flushPendingAcks() {
    if (ackFlushInProgress || pendingAcks.size === 0) return;
    ackFlushInProgress = true;
    let changed = false;
    try {
      for (const [id, ack] of pendingAcks.entries()) {
        const ok = await tryMarkCompleted(ack.jobId);
        if (ok) {
          pendingAcks.delete(id);
          changed = true;
        } else {
          ack.attempts += 1;
          ack.lastError = 'mark-failed';
          metrics.ack_retries += 1;
          changed = true;
        }
      }
      if (changed) {
        schedulePendingAckPersist();
      }
      emitState();
    } finally {
      ackFlushInProgress = false;
    }
  }

  function addToQueue(ip, puerto, texto, jobId = null) {
    const key = queueKey(ip, puerto || 9100);
    const result = enqueueJob(queueState, key, { texto, jobId });
    if (result.accepted) {
      processQueue(key).catch(() => {});
      emitState();
    }
    return result;
  }

  async function processQueue(key) {
    const printer = queueState.printerQueues[key];
    if (!printer || printer.active || printer.queue.length === 0) return;

    printer.active = true;
    const item = printer.queue.shift();
    status.printers[key].queue = printer.queue.length;
    emitState();

    let printSuccess = false;
    try {
      await executePrint(key, item.texto);
      printSuccess = true;
      status.printers[key].totalPrints += 1;
      status.printers[key].lastError = null;
      printer.retryCount = 0;
      metrics.prints_ok += 1;
    } catch (err) {
      status.printers[key].lastError = err && err.message ? err.message : 'print-failed';
      printer.retryCount = (printer.retryCount || 0) + 1;
      printer.queue.unshift(item);
      status.printers[key].queue = printer.queue.length;
      metrics.prints_error += 1;
      if (logger && typeof logger.error === 'function') {
        logger.error(`❌ Error físico en impresora ${key}:`, status.printers[key].lastError);
      }
    }

    if (printSuccess && item.jobId) {
      const marked = await tryMarkCompleted(item.jobId);
      if (!marked) {
        enqueuePendingAck(item.jobId);
      }
    }

    printer.active = false;
    status.printers[key].queue = printer.queue.length;
    emitState();

    if (printer.queue.length > 0) {
      const delay = nextRetryDelay(printer.retryCount, printSuccess);
      scheduleQueueRun(key, delay);
    }
  }

  async function syncPendingJobs() {
    if (!status.tenant || typeof fetchPendingJobs !== 'function') return;
    if (syncInProgress) return;

    syncInProgress = true;
    try {
      const jobs = await fetchPendingJobs(status.tenant);
      metrics.pending_synced += (jobs || []).length;
      (jobs || []).forEach((job) => {
        addToQueue(job.ip, job.puerto || 9100, job.texto || job.contenidoTexto, job.id);
      });
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('⚠️ Error de conexión con el servidor.', err && err.message ? err.message : err);
      }
    } finally {
      syncInProgress = false;
      emitState();
    }
  }

  function clearPeriodicTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pendingSyncTimer) clearInterval(pendingSyncTimer);
    if (pendingAckTimer) clearInterval(pendingAckTimer);
    if (pendingAckPersistTimer) clearTimeout(pendingAckPersistTimer);
    heartbeatTimer = null;
    pendingSyncTimer = null;
    pendingAckTimer = null;
    pendingAckPersistTimer = null;
  }

  function scheduleReconnect(config) {
    if (stopped) return;
    reconnectAttempts += 1;
    metrics.ws_reconnects += 1;
    emitMetrics();
    const backoff = Math.min(cfg.wsReconnectBaseMs * Math.pow(2, reconnectAttempts - 1), cfg.wsReconnectMaxMs);
    const jitter = Math.floor(Math.random() * 1000);
    const delay = backoff + jitter;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs(config);
    }, delay);
  }

  function connectWs(config) {
    if (stopped || !cfg.wsEndpoint || typeof createWebSocket !== 'function') return;
    const wsUrl = `${cfg.wsEndpoint}?tenant=${encodeURIComponent(config.empresaId)}`;
    ws = createWebSocket(wsUrl);
    isAlive = true;

    ws.on('open', async () => {
      reconnectAttempts = 0;
      status.connected = true;
      emitState();

      await hydratePendingAcks();
      await syncPendingJobs();
      await flushPendingAcks();

      pendingSyncTimer = setInterval(() => {
        syncPendingJobs().catch(() => {});
      }, cfg.pendingSyncIntervalMs);

      pendingAckTimer = setInterval(() => {
        flushPendingAcks().catch(() => {});
      }, cfg.pendingAckIntervalMs);

      heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== 1) return;
        if (!isAlive) {
          try { ws.terminate(); } catch (e) {}
          return;
        }
        isAlive = false;
        try { ws.ping(); } catch (e) {}
      }, cfg.wsHeartbeatIntervalMs);
    });

    ws.on('pong', () => {
      isAlive = true;
    });

    ws.on('message', (data) => {
      metrics.ws_messages += 1;
      try {
        const payload = JSON.parse(data);
        if (payload.texto && payload.ip) {
          addToQueue(payload.ip, payload.puerto || 9100, payload.texto, payload.id);
        }
      } catch (e) {
        if (logger && typeof logger.error === 'function') {
          logger.error('⚠️ Mensaje WS inválido:', e && e.message ? e.message : e);
        }
      } finally {
        emitMetrics();
      }
    });

    ws.on('error', (err) => {
      status.connected = false;
      emitState();
      if (logger && typeof logger.error === 'function') {
        logger.error('⚠️ Error de WebSocket:', err && err.message ? err.message : err);
      }
    });

    ws.on('close', () => {
      clearPeriodicTimers();
      status.connected = false;
      emitState();
      scheduleReconnect(config);
    });
  }

  function start(config) {
    stopped = false;
    status.tenant = config.empresaId;
    emitState();
    connectWs(config);
  }

  async function stop() {
    stopped = true;
    clearPeriodicTimers();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const timer of queueTimers.values()) {
      clearTimeout(timer);
    }
    queueTimers.clear();

    if (typeof savePendingAcks === 'function') {
      try {
        await savePendingAcks(serializePendingAcks());
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('⚠️ No se pudo persistir pendingAcks al cerrar:', err && err.message ? err.message : err);
        }
      }
    }

    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }

  function getStatus() {
    return status;
  }

  function getMetrics() {
    return { ...metrics, pending_acks: pendingAcks.size };
  }

  return {
    start,
    stop,
    getStatus,
    getMetrics,
    addToQueue,
    syncPendingJobs,
    flushPendingAcks
  };
}

module.exports = {
  createRuntime
};
