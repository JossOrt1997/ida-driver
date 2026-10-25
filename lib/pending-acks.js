function hydratePendingAck(item, tenantId, normalizeJobId) {
  if (!item) return { accepted: false, reason: 'invalid-job-id' };
  if (item.tenantId !== undefined && item.tenantId !== null
      && String(item.tenantId) !== String(tenantId)) {
    return { accepted: false, reason: 'wrong-tenant' };
  }

  const jobId = normalizeJobId(item.jobId);
  if (!jobId) return { accepted: false, reason: 'invalid-job-id' };

  return {
    accepted: true,
    ack: {
      jobId,
      tenantId: item.tenantId ?? tenantId,
      attempts: Number(item.attempts || 0),
      lastError: item.lastError || null
    }
  };
}

function serializePendingAcks(pendingAcks) {
  return Array.from(pendingAcks.values()).map(ack => ({
    jobId: ack.jobId,
    tenantId: ack.tenantId,
    attempts: ack.attempts || 0,
    lastError: ack.lastError || null
  }));
}

module.exports = { hydratePendingAck, serializePendingAcks };
