import { poll } from '../rest/poller.js';
import { describeTopic, type AdminClient } from './client.js';

type Snapshot = Awaited<ReturnType<typeof describeTopic>>;
export type TopicPollOptions = { intervalMs?: number; count?: number; durationMs?: number; changesOnly?: boolean; signal?: AbortSignal };
export function validateTopicPolling(options: TopicPollOptions) {
  const enabled = options.count !== undefined || options.durationMs !== undefined;
  if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count <= 0)) throw new Error('CONFIG_ERROR: Count must be a positive safe integer');
  if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0 || options.durationMs > 2147483647)) throw new Error('CONFIG_ERROR: Duration must be positive and at most 24.8 days');
  if (options.count !== undefined && options.durationMs !== undefined) throw new Error('CONFIG_ERROR: Choose count or duration');
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > 2147483647)) throw new Error('CONFIG_ERROR: Interval must be positive and at most 2147483.647 seconds');
  if (enabled && options.intervalMs === undefined) throw new Error('CONFIG_ERROR: Polling requires explicit --interval');
  if (!enabled && (options.changesOnly || options.intervalMs !== undefined)) throw new Error('CONFIG_ERROR: --interval and --changes-only require --count or --duration');
  return enabled;
}
export function topicMetadataKey(snapshot: Snapshot) {
  return JSON.stringify({ partitionCount: snapshot.partitionCount, partitions: snapshot.partitions.map(p => ({
    partitionId: p.partitionId, leader: p.leader, replicas: p.replicas,
    isr: [...p.isr].sort((a, b) => a - b), partitionErrorCode: p.partitionErrorCode ?? 0
  })).sort((a, b) => a.partitionId - b.partitionId) });
}
export async function pollTopic(admin: () => AdminClient, topic: string, options: TopicPollOptions,
  record: (sample: { sequence: number; timestamp: string; metadata?: Snapshot; error?: unknown; print: boolean }) => Promise<void>,
  clock = () => performance.now(), wait?: (ms: number) => Promise<void>) {
  if (!validateTopicPolling(options)) throw new Error('CONFIG_ERROR: Polling requires count or duration');
  const start = clock();
  let samplesAttempted = 0, successfulSamples = 0, failedSamples = 0, metadataChangeCount = 0;
  let latestSuccessfulMetadata: (Snapshot & { timestamp: string }) | undefined, previous: string | undefined;
  await poll(async sequence => {
    samplesAttempted++;
    let metadata: Snapshot;
    try { metadata = await describeTopic(admin(), topic); }
    catch (error) { failedSamples++; await record({ sequence, timestamp: new Date().toISOString(), error, print: true }); return; }
    const timestamp = new Date().toISOString(), key = topicMetadataKey(metadata);
    const changed = previous !== undefined && key !== previous;
    if (changed) metadataChangeCount++;
    const print = !options.changesOnly || previous === undefined || changed;
    previous = key; successfulSamples++; latestSuccessfulMetadata = { ...metadata, timestamp };
    await record({ sequence, timestamp, metadata, print });
  }, { ...options, intervalMs: options.intervalMs! }, clock, wait);
  return { samplesAttempted, successfulSamples, failedSamples, metadataChangeCount, durationSeconds: (clock() - start) / 1000, topic, latestSuccessfulMetadata };
}
