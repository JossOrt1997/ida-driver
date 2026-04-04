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
    onAudit,
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
    pendingAckPersistDebounceMs: options.pendingAckPersistDebounceMs || 250,
    requireJobId: options.requireJobId !== false
  };

  const queueState = createQueueState();
  const status = {
    connected: false,
    tenant: null,
    printers: queueState.status.printers,
    pendingAcks: 0,
    quarantinedJobs: 0
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
    quarantined_jobs: 0,
    dedupe_dropped: 0,
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
  const quarantinedJobs = [];

  function normalizeJobId(raw) {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return null;
      return String(Math.trunc(raw));
    }

    if (typeof raw === 'bigint') {
      return String(raw);
    }

    if (typeof raw === 'string') {
      const str = raw.trim();
      if (!str) return null;
      if (/^-?\d+$/.test(str)) {
        try {
          return String(BigInt(str));
        } catch (e) {
          return str;
        }
      }
      return str;
    }

    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      if (raw.length >= 2 && typeof raw[0] === 'string' && raw[0].includes('java.lang')) {
        return normalizeJobId(raw[1]);
      }
      return normalizeJobId(raw[raw.length - 1]);
    }

    if (typeof raw === 'object') {
      if (Object.prototype.hasOwnProperty.call(raw, '$numberLong')) {
        return normalizeJobId(raw.$numberLong);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'jobId')) {
        return normalizeJobId(raw.jobId);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'id')) {
        return normalizeJobId(raw.id);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'value')) {
        return normalizeJobId(raw.value);
      }
      if (Object.prototype.hasOwnProperty.call(raw, '@value')) {
        return normalizeJobId(raw['@value']);
      }
      return null;
    }

    return null;
  }

  function audit(event, payload = {}) {
    if (typeof onAudit !== 'function') return;
    onAudit({ ts: new Date().toISOString(), event, ...payload });
  }

  function emitMetrics() {
    metrics.pending_acks = pendingAcks.size;
    metrics.quarantined_jobs = quarantinedJobs.length;
    metrics.updated_at = new Date().toISOString();
    if (typeof onMetrics === 'function') {
      onMetrics({ ...metrics });
    }
  }

  function emitState() {
    status.pendingAcks = pendingAcks.size;
    status.quarantinedJobs = quarantinedJobs.length;
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
        const normalizedJobId = normalizeJobId(item.jobId);
        if (!normalizedJobId) return;
        const id = String(normalizedJobId);
        pendingAcks.set(id, {
          jobId: normalizedJobId,
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
      audit('ack_ok', { jobId });
      emitMetrics();
      return true;
    } catch (e) {
      audit('ack_error', { jobId, error: e && e.message ? e.message : String(e) });
      return false;
    }
  }

  function enqueuePendingAck(jobId) {
    if (!jobId) return;
    const id = String(jobId);
    if (!pendingAcks.has(id)) {
      pendingAcks.set(id, { jobId, attempts: 0, lastError: null });
      schedulePendingAckPersist();
      audit('pending_ack_enqueued', { jobId });
    }
    emitState();
  }

  function quarantineJob(job, reason, source) {
    const entry = {
      reason,
      source,
      ip: job && job.ip,
      puerto: job && job.puerto,
      rawJobId: job && Object.prototype.hasOwnProperty.call(job, 'id') ? job.id : null,
      textoPreview: String((job && (job.texto || job.contenidoTexto)) || '').slice(0, 120)
    };
    quarantinedJobs.push(entry);
    if (quarantinedJobs.length > 1000) {
      quarantinedJobs.shift();
    }
    metrics.quarantined_jobs += 1;
    audit('job_quarantined', entry);
    emitState();
  }

  function normalizeIncomingJob(job, source) {
    const normalizedJobId = normalizeJobId(job && job.id);
    const normalized = {
      ip: job && job.ip,
      puerto: (job && job.puerto) || 9100,
      texto: (job && (job.texto || job.contenidoTexto)) || '',
      jobId: normalizedJobId,
      rawJobId: job && Object.prototype.hasOwnProperty.call(job, 'id') ? job.id : null
    };

    if (cfg.requireJobId && !normalized.jobId) {
      quarantineJob(job, 'missing-job-id', source);
      return null;
    }

    return normalized;
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
    const normalizedJobId = normalizeJobId(jobId);

    if (cfg.requireJobId && !normalizedJobId) {
      quarantineJob({ ip, puerto, texto, id: jobId }, 'missing-job-id', 'direct');
      return { accepted: false, reason: 'missing-job-id' };
    }

    const result = enqueueJob(queueState, key, { texto, jobId: normalizedJobId });
    if (result.accepted) {
      processQueue(key).catch(() => {});
      emitState();
      audit('job_enqueued', { key, jobId: normalizedJobId, source: 'direct' });
    } else {
      metrics.dedupe_dropped += 1;
      audit('job_deduped', { key, jobId: normalizedJobId, reason: result.reason, source: 'direct' });
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
      audit('print_ok', { key, jobId: item.jobId });
    } catch (err) {
      status.printers[key].lastError = err && err.message ? err.message : 'print-failed';
      printer.retryCount = (printer.retryCount || 0) + 1;
      printer.queue.unshift(item);
      status.printers[key].queue = printer.queue.length;
      metrics.prints_error += 1;
      audit('print_error', { key, jobId: item.jobId, error: status.printers[key].lastError });
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
        const normalized = normalizeIncomingJob(job, 'pending-sync');
        if (!normalized) return;
        const result = enqueueJob(queueState, queueKey(normalized.ip, normalized.puerto), {
          texto: normalized.texto,
          jobId: normalized.jobId
        });
        if (result.accepted) {
          processQueue(queueKey(normalized.ip, normalized.puerto)).catch(() => {});
          audit('job_enqueued', {
            key: queueKey(normalized.ip, normalized.puerto),
            source: 'pending-sync',
            jobId: normalized.jobId,
            rawJobId: normalized.rawJobId
          });
        } else {
          metrics.dedupe_dropped += 1;
          audit('job_deduped', {
            key: queueKey(normalized.ip, normalized.puerto),
            source: 'pending-sync',
            jobId: normalized.jobId,
            rawJobId: normalized.rawJobId,
            reason: result.reason
          });
        }
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
          const normalized = normalizeIncomingJob(payload, 'websocket');
          if (normalized) {
            const key = queueKey(normalized.ip, normalized.puerto);
            const result = enqueueJob(queueState, key, {
              texto: normalized.texto,
              jobId: normalized.jobId
            });
            if (result.accepted) {
              processQueue(key).catch(() => {});
              audit('job_enqueued', {
                key,
                source: 'websocket',
                jobId: normalized.jobId,
                rawJobId: normalized.rawJobId
              });
            } else {
              metrics.dedupe_dropped += 1;
              audit('job_deduped', {
                key,
                source: 'websocket',
                jobId: normalized.jobId,
                rawJobId: normalized.rawJobId,
                reason: result.reason
              });
            }
          }
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
