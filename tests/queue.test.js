const { createQueueState, enqueueJob, nextRetryDelay } = require('../lib/queue');

describe('driver queue mechanics', () => {
  test('accepts first job and rejects duplicate processed id', () => {
    const state = createQueueState();
    const key = '127.0.0.1:9100';

    const first = enqueueJob(state, key, { texto: 'A', jobId: 100 });
    expect(first.accepted).toBe(true);

    const dup = enqueueJob(state, key, { texto: 'B', jobId: 100 });
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toBe('duplicate-processed');
  });

  test('keeps queue entries for jobs without id', () => {
    const state = createQueueState();
    const key = '127.0.0.1:9100';

    const one = enqueueJob(state, key, { texto: 'No id 1' });
    const two = enqueueJob(state, key, { texto: 'No id 2' });

    expect(one.accepted).toBe(true);
    expect(two.accepted).toBe(true);
    expect(state.printerQueues[key].queue.length).toBe(2);
  });

  test('calculates exponential retry delay with cap', () => {
    expect(nextRetryDelay(0, false)).toBe(500);
    expect(nextRetryDelay(1, false)).toBe(1000);
    expect(nextRetryDelay(2, false)).toBe(2000);
    expect(nextRetryDelay(8, false)).toBe(10000);
    expect(nextRetryDelay(2, true)).toBe(100);
  });
});
