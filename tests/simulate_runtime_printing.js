const { createRuntime } = require('../lib/runtime');
const { sanitizePrintableText, stripResidualTags } = require('../lib/format');

function createMockWs() {
  const handlers = new Map();
  return {
    readyState: 1,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, payload) {
      const fn = handlers.get(event);
      if (fn) fn(payload);
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

function renderLines(texto) {
  const processedText = sanitizePrintableText(texto);
  const lines = processedText.split('\n');
  const out = [];
  for (const line of lines) {
    let currentLine = line;
    currentLine = currentLine.replace(/\[C\]|\[\/C\]|\[R\]|\[\/R\]|\[B\]|\[\/B\]|\[L\]|\[\/L\]/g, '');
    currentLine = stripResidualTags(currentLine);
    if (currentLine.length > 0 || line.length === 0) {
      out.push(currentLine);
    }
  }
  return out;
}

async function run() {
  const ws = createMockWs();
  const printed = [];
  const completed = [];
  const failedAcks = new Set([1002]);

  const runtime = createRuntime({
    executePrint: async (key, texto) => {
      printed.push({ key, lines: renderLines(texto) });
    },
    fetchPendingJobs: async () => [
      { id: 1000, ip: '127.0.0.1', puerto: 9100, texto: '[C][B]Cafe\nNandu[/B][/C]' }
    ],
    markAsCompleted: async (jobId) => {
      if (failedAcks.has(Number(jobId))) {
        failedAcks.delete(Number(jobId));
        throw new Error('temporary network');
      }
      completed.push(String(jobId));
    },
    createWebSocket: () => ws,
    onStateChange: () => {},
    logger: { error() {} }
  }, {
    wsEndpoint: 'ws://sim.local/ws/impresion',
    pendingSyncIntervalMs: 999999,
    pendingAckIntervalMs: 999999,
    wsHeartbeatIntervalMs: 999999,
    wsReconnectBaseMs: 999999,
    wsReconnectMaxMs: 999999,
    pendingAckPersistDebounceMs: 1
  });

  runtime.start({ empresaId: '99' });
  ws.emit('open');

  ws.emit('message', JSON.stringify({ id: 1002, ip: '127.0.0.1', puerto: 9100, texto: '[C]Jalapeno\nLimon[/C]' }));
  ws.emit('message', JSON.stringify({ id: 1002, ip: '127.0.0.1', puerto: 9100, texto: '[C]Duplicado 1002[/C]' }));

  await new Promise((r) => setTimeout(r, 250));

  if (printed.length !== 2) {
    throw new Error(`Simulacion fallida: se esperaban 2 impresiones unicas y salieron ${printed.length}`);
  }

  const merged = printed.flatMap((p) => p.lines).join('|');
  if (!merged.includes('Cafe') || !merged.includes('Nandu') || !merged.includes('Jalapeno') || !merged.includes('Limon')) {
    throw new Error(`Simulacion fallida: caracteres/contenido inesperado -> ${merged}`);
  }

  const beforeFlush = runtime.getStatus();
  if (beforeFlush.pendingAcks < 1) {
    throw new Error('Simulacion fallida: se esperaba al menos 1 ack pendiente');
  }

  await runtime.flushPendingAcks();
  await new Promise((r) => setTimeout(r, 10));

  const afterFlush = runtime.getStatus();
  if (afterFlush.pendingAcks !== 0) {
    throw new Error(`Simulacion fallida: pendingAcks esperado 0, actual ${afterFlush.pendingAcks}`);
  }

  if (!completed.includes('1000') || !completed.includes('1002')) {
    throw new Error(`Simulacion fallida: completados esperados [1000,1002], actual ${completed.join(',')}`);
  }

  await runtime.stop();
  console.log('OK Simulacion runtime: sin duplicados y sin corrupcion de caracteres.');
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
