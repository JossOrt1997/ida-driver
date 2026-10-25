const { hydratePendingAck, serializePendingAcks } = require('../lib/pending-acks');

describe('persisted pending ACK state', () => {
  const normalizeJobId = value => value == null ? null : String(value).trim();

  test('hydrates a legacy entry into the current tenant with normalized attempts', () => {
    expect(hydratePendingAck(
      { jobId: ['java.lang.Long', 17], attempts: '2', lastError: 'offline' },
      'tenant-a',
      value => Array.isArray(value) ? String(value[1]) : normalizeJobId(value)
    )).toEqual({
      accepted: true,
      ack: { jobId: '17', tenantId: 'tenant-a', attempts: 2, lastError: 'offline' }
    });
  });

  test('rejects absent and unnormalizable job IDs', () => {
    expect(hydratePendingAck(null, 'tenant-a', normalizeJobId)).toEqual({
      accepted: false, reason: 'invalid-job-id'
    });
    expect(hydratePendingAck({ jobId: null }, 'tenant-a', normalizeJobId)).toEqual({
      accepted: false, reason: 'invalid-job-id'
    });
    expect(hydratePendingAck({ attempts: 1 }, 'tenant-a', normalizeJobId)).toEqual({
      accepted: false, reason: 'invalid-job-id'
    });
    expect(hydratePendingAck({ jobId: {} }, 'tenant-a', () => null)).toEqual({
      accepted: false, reason: 'invalid-job-id'
    });
  });

  test('rejects ACKs explicitly owned by another tenant and accepts matching identity', () => {
    expect(hydratePendingAck({ jobId: 7, tenantId: 'tenant-b' }, 'tenant-a', normalizeJobId))
      .toEqual({ accepted: false, reason: 'wrong-tenant' });
    expect(hydratePendingAck({ jobId: 7, tenantId: 'tenant-a' }, 'tenant-a', normalizeJobId))
      .toEqual({ accepted: true, ack: { jobId: '7', tenantId: 'tenant-a', attempts: 0, lastError: null } });
    expect(hydratePendingAck({ jobId: 8, tenantId: null }, 'tenant-a', normalizeJobId))
      .toEqual({ accepted: true, ack: { jobId: '8', tenantId: 'tenant-a', attempts: 0, lastError: null } });
  });

  test('serializes only stable ACK fields for restart recovery', () => {
    expect(serializePendingAcks(new Map([
      ['7', { jobId: '7', tenantId: 'tenant-a', attempts: 3, lastError: 'temporary' }],
      ['8', { jobId: '8', tenantId: 'tenant-a' }]
    ]))).toEqual([
      { jobId: '7', tenantId: 'tenant-a', attempts: 3, lastError: 'temporary' },
      { jobId: '8', tenantId: 'tenant-a', attempts: 0, lastError: null }
    ]);
    expect(serializePendingAcks(new Map())).toEqual([]);
  });
});
