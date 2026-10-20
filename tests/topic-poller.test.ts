import test from 'node:test';
import assert from 'node:assert/strict';
import { pollTopic, topicMetadataKey, validateTopicPolling } from '../src/kafka/topic-poller.js';
import type { AdminClient } from '../src/kafka/client.js';

const snapshot = { topic: 'topic', partitionCount: 1, partitions: [{ partitionId: 0, partitionErrorCode: 0, leader: 1, replicas: [1, 2], isr: [1, 2] }] };
test('poll option validation is bounded and rejects nonsensical one-shot flags', () => {
  assert.equal(validateTopicPolling({}), false);
  for (const options of [{ intervalMs: 1 }, { changesOnly: true }, { count: 1 }, { count: 0, intervalMs: 1 }, { count: Number.MAX_SAFE_INTEGER + 1, intervalMs: 1 }, { count: 1, intervalMs: 0 }, { count: 1, intervalMs: Infinity }, { count: 1, durationMs: 1, intervalMs: 1 }, { durationMs: 2147483648, intervalMs: 1 }]) assert.throws(() => validateTopicPolling(options), /CONFIG_ERROR/);
});
test('comparison ignores extra fields and ordering but preserves meaningful changes', () => {
  const key = topicMetadataKey(snapshot);
  assert.equal(topicMetadataKey({ ...snapshot, timestamp: 'later', runId: 'other', partitions: [{ ...snapshot.partitions[0]!, isr: [2, 1] }] } as typeof snapshot), key);
  for (const patch of [{ leader: 2 }, { isr: [1] }, { replicas: [2, 1] }, { partitionErrorCode: 5 }]) assert.notEqual(topicMetadataKey({ ...snapshot, partitions: [{ ...snapshot.partitions[0]!, ...patch }] }), key);
});
test('count polling is sequential with fresh admin lifecycle, failures and changes-only', async () => {
  let now = 0, active = 0, created = 0;
  const cycles: string[] = [], printed: number[] = [], attempts: number[] = [];
  const result = await pollTopic(() => {
    const n = ++created;
    return { connect: async () => { assert.equal(active++, 0); cycles.push('connect'); },
      fetchTopicMetadata: async options => {
        assert.deepEqual(options, { topics: ['topic'] }); cycles.push('fetch'); now += 15;
        if (n === 6) throw new Error('timeout');
        const partition = { ...snapshot.partitions[0]! };
        if (n >= 3) partition.leader = 2;
        if (n >= 4) partition.isr = [2];
        if (n >= 5) partition.replicas = [2];
        return { topics: [{ name: 'topic', partitions: [partition] }] };
      }, disconnect: async () => { cycles.push('disconnect'); active--; } } satisfies AdminClient;
  }, 'topic', { intervalMs: 10, count: 6, changesOnly: true }, async sample => { attempts.push(sample.sequence); if (sample.print) printed.push(sample.sequence); }, () => now, async ms => { assert.equal(ms, 0); });
  assert.deepEqual(printed, [1, 3, 4, 5, 6]); assert.equal(attempts.length, 6);
  assert.deepEqual(cycles, Array.from({ length: 6 }, () => ['connect', 'fetch', 'disconnect']).flat());
  assert.equal(result.samplesAttempted, 6); assert.equal(result.successfulSamples, 5); assert.equal(result.failedSamples, 1); assert.equal(result.metadataChangeCount, 3); assert.equal(result.latestSuccessfulMetadata?.partitions[0]?.leader, 2);
});
test('duration and abort stop new samples and disconnect in-flight operations', async () => {
  for (const abort of [false, true]) {
    let now = 0, disconnected = 0;
    const controller = new AbortController();
    const result = await pollTopic(() => ({ connect: async () => {}, fetchTopicMetadata: async () => { now += 2; if (abort) controller.abort(); return { topics: [{ name: 'topic', partitions: snapshot.partitions }] }; }, disconnect: async () => { disconnected++; } }), 'topic', { intervalMs: 10, durationMs: 25, signal: controller.signal }, async () => {}, () => now, async ms => { now += ms; });
    assert.equal(result.samplesAttempted, abort ? 1 : 3); assert.equal(disconnected, result.samplesAttempted);
  }
  const controller = new AbortController(); controller.abort();
  const result = await pollTopic(() => { throw new Error('must not start'); }, 'topic', { intervalMs: 1, count: 2, signal: controller.signal }, async () => {});
  assert.equal(result.samplesAttempted, 0);
});
