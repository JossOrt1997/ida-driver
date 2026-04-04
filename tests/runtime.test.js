const { createRuntime } = require('../lib/runtime');

function createMockWs() {
  const handlers = new Map();
  return {
    readyState: 1,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, payload) {
      if (handlers.has(event)) {
        handlers.get(event)(payload);
      }
    },
    ping() {},
    terminate() {
      this.readyState = 3;
      this.emit('close');
    },
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  };
}

describe('runtime', () => {
  test('adds failed completion to pending ack queue and flushes later', async () => {
    const ws = createMockWs();
    const calls = { complete: 0 };
    const states = [];

    const runtime = createRuntime({
      executePrint: async () => {},
      fetchPendingJobs: async () => [{ id: 101, ip: '127.0.0.1', puerto: 9100, texto: 'A' }],
      markAsCompleted: async () => {
        calls.complete += 1;
        if (calls.complete === 1) {
          throw new Error('network');
        }
      },
      createWebSocket: () => ws,
      onStateChange: (s) => {
        states.push({
          connected: s.connected,
          pendingAcks: s.pendingAcks
        });
      },
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999
    });

    runtime.start({ empresaId: '1' });
    ws.emit('open');

    await new Promise((r) => setTimeout(r, 20));

    const hadPending = states.some((s) => s.pendingAcks > 0);
    expect(hadPending).toBe(true);

    await runtime.flushPendingAcks();
    await new Promise((r) => setTimeout(r, 5));

    expect(calls.complete).toBeGreaterThanOrEqual(2);
    const last = states[states.length - 1];
    expect(last.pendingAcks).toBe(0);

    await runtime.stop();
  });

  test('enqueues websocket message and updates printer totals', async () => {
    const ws = createMockWs();
    const runtime = createRuntime({
      executePrint: async () => {},
      fetchPendingJobs: async () => [],
      markAsCompleted: async () => {},
      createWebSocket: () => ws,
      onStateChange: () => {},
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999
    });

    runtime.start({ empresaId: '2' });
    ws.emit('open');
    ws.emit('message', JSON.stringify({ id: 777, ip: '127.0.0.1', puerto: 9101, texto: 'Ticket' }));

    await new Promise((r) => setTimeout(r, 20));

    const st = runtime.getStatus();
    expect(st.printers['127.0.0.1:9101'].totalPrints).toBe(1);

    await runtime.stop();
  });

  test('hydrates and persists pending ack entries', async () => {
    const ws = createMockWs();
    const savedSnapshots = [];

    const runtime = createRuntime({
      executePrint: async () => {},
      fetchPendingJobs: async () => [{ id: 300, ip: '127.0.0.1', puerto: 9102, texto: 'X' }],
      markAsCompleted: async () => {
        throw new Error('offline');
      },
      loadPendingAcks: async () => [{ jobId: 200, attempts: 1, lastError: 'old' }],
      savePendingAcks: async (items) => {
        savedSnapshots.push(items.map((i) => i.jobId).sort());
      },
      createWebSocket: () => ws,
      onStateChange: () => {},
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999,
      pendingAckPersistDebounceMs: 1
    });

    runtime.start({ empresaId: '3' });
    ws.emit('open');
    await new Promise((r) => setTimeout(r, 30));

    const st = runtime.getStatus();
    expect(st.pendingAcks).toBeGreaterThanOrEqual(2);
    const hadSaved = savedSnapshots.some((jobs) => jobs.includes('200') || jobs.includes('300'));
    expect(hadSaved).toBe(true);

    await runtime.stop();
  });

  test('emits metrics updates for print and ack retry', async () => {
    const ws = createMockWs();
    const metricsStates = [];

    const runtime = createRuntime({
      executePrint: async () => {},
      fetchPendingJobs: async () => [{ id: 401, ip: '127.0.0.1', puerto: 9103, texto: 'M' }],
      markAsCompleted: async () => {
        throw new Error('temp');
      },
      createWebSocket: () => ws,
      onStateChange: () => {},
      onMetrics: (m) => {
        metricsStates.push(m);
      },
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999,
      pendingAckPersistDebounceMs: 1
    });

    runtime.start({ empresaId: '4' });
    ws.emit('open');
    await new Promise((r) => setTimeout(r, 20));

    const current = runtime.getMetrics();
    expect(current.prints_ok).toBe(1);
    expect(current.pending_acks).toBeGreaterThanOrEqual(1);

    await runtime.flushPendingAcks();
    const afterFlush = runtime.getMetrics();
    expect(afterFlush.ack_retries).toBeGreaterThanOrEqual(1);
    expect(metricsStates.length).toBeGreaterThan(0);

    await runtime.stop();
  });

  test('rejects duplicate job ids across websocket events', async () => {
    const ws = createMockWs();
    const printed = [];
    const runtime = createRuntime({
      executePrint: async (key, texto) => {
        printed.push({ key, texto });
      },
      fetchPendingJobs: async () => [],
      markAsCompleted: async () => {},
      createWebSocket: () => ws,
      onStateChange: () => {},
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999,
      pendingAckPersistDebounceMs: 1
    });

    runtime.start({ empresaId: '5' });
    ws.emit('open');
    ws.emit('message', JSON.stringify({ id: 9001, ip: '127.0.0.1', puerto: 9104, texto: 'uno' }));
    ws.emit('message', JSON.stringify({ id: 9001, ip: '127.0.0.1', puerto: 9104, texto: 'duplicado' }));

    await new Promise((r) => setTimeout(r, 20));

    expect(printed.length).toBe(1);
    expect(printed[0].texto).toBe('uno');
    await runtime.stop();
  });

  test('normalizes java long style job id and avoids duplicate print', async () => {
    const ws = createMockWs();
    const printed = [];
    const completed = [];
    const runtime = createRuntime({
      executePrint: async (key, texto) => {
        printed.push({ key, texto });
      },
      fetchPendingJobs: async () => [
        { id: ['java.lang.Long', 700], ip: '127.0.0.1', puerto: 9105, texto: 'Desde pendientes' }
      ],
      markAsCompleted: async (jobId) => {
        completed.push(String(jobId));
      },
      createWebSocket: () => ws,
      onStateChange: () => {},
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999,
      pendingAckPersistDebounceMs: 1,
      requireJobId: true
    });

    runtime.start({ empresaId: '6' });
    ws.emit('open');
    ws.emit('message', JSON.stringify({ id: 700, ip: '127.0.0.1', puerto: 9105, texto: 'Duplicado via ws' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(printed.length).toBe(1);
    expect(completed[0]).toBe('700');
    await runtime.stop();
  });

  test('quarantines jobs without id when requireJobId is enabled', async () => {
    const ws = createMockWs();
    const audits = [];
    const runtime = createRuntime({
      executePrint: async () => {},
      fetchPendingJobs: async () => [
        { ip: '127.0.0.1', puerto: 9106, texto: 'Sin ID' }
      ],
      markAsCompleted: async () => {},
      createWebSocket: () => ws,
      onAudit: (entry) => audits.push(entry),
      onStateChange: () => {},
      logger: { error() {} }
    }, {
      wsEndpoint: 'ws://test.local/ws/impresion',
      pendingSyncIntervalMs: 999999,
      pendingAckIntervalMs: 999999,
      wsHeartbeatIntervalMs: 999999,
      wsReconnectBaseMs: 999999,
      wsReconnectMaxMs: 999999,
      pendingAckPersistDebounceMs: 1,
      requireJobId: true
    });

    runtime.start({ empresaId: '7' });
    ws.emit('open');
    await new Promise((r) => setTimeout(r, 30));

    const st = runtime.getStatus();
    expect(st.quarantinedJobs).toBeGreaterThanOrEqual(1);
    const quarantinedEvents = audits.filter((a) => a.event === 'job_quarantined');
    expect(quarantinedEvents.length).toBeGreaterThanOrEqual(1);

    await runtime.stop();
  });
});
