function createQueueState() {
  return {
    printerQueues: {},
    status: { printers: {} },
    processedJobIds: new Set()
  };
}

function ensurePrinter(state, key) {
  if (!state.printerQueues[key]) {
    state.printerQueues[key] = { queue: [], active: false, retryCount: 0 };
  }
  if (!state.status.printers[key]) {
    state.status.printers[key] = { queue: 0, totalPrints: 0, lastError: null };
  }
}

function enqueueJob(state, key, job) {
  ensurePrinter(state, key);

  if (job.jobId) {
    const strId = String(job.jobId);
    if (state.processedJobIds.has(strId)) {
      return { accepted: false, reason: 'duplicate-processed' };
    }

    if (state.processedJobIds.size > 1000) {
      const first = state.processedJobIds.values().next().value;
      state.processedJobIds.delete(first);
    }

    state.processedJobIds.add(strId);

    if (state.printerQueues[key].queue.some(q => String(q.jobId) === strId)) {
      return { accepted: false, reason: 'duplicate-in-queue' };
    }
  }

  state.printerQueues[key].queue.push({ texto: job.texto, jobId: job.jobId || null });
  state.status.printers[key].queue = state.printerQueues[key].queue.length;
  return { accepted: true };
}

function nextRetryDelay(retryCount, printSuccess) {
  if (printSuccess) {
    return 100;
  }
  if (!retryCount || retryCount <= 0) {
    return 500;
  }
  return Math.min(500 * Math.pow(2, retryCount), 10000);
}

module.exports = {
  createQueueState,
  ensurePrinter,
  enqueueJob,
  nextRetryDelay
};
