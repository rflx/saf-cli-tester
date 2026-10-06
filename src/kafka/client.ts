import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type KafkaConfig, type EachMessagePayload } from 'kafkajs';
import { profileSchema, type Profile } from '../profiles/types.js';
import { MtlsAuthProvider } from '../auth/mtls.js';
import type { Redactor } from '../logging/redactor.js';

export function kafkaCredential(profile: Profile) {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success || !parsed.data.kafka) throw new Error('CONFIG_ERROR: Kafka requires brokers and a configured mTLS credential; OAuth2 is unsupported');
  return parsed.data.credentials.mtls!;
}
export function clientId(value?: string) {
  if (value !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('CONFIG_ERROR: Kafka client ID must be a UUID');
  return value ?? randomUUID();
}
export function validateGroupId(value: string | undefined) {
  if (value === undefined || value.trim().length === 0) throw new Error('CONFIG_ERROR: Consumer group ID is required and must be non-empty');
}
export function kafkaError(error: unknown): string {
  const visited = new Set<unknown>();
  let current = error; const parts: string[] = [];
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const e = current as { code?: unknown; type?: unknown; name?: string; message?: string; cause?: unknown };
    parts.push(String(e.code ?? ''), String(e.type ?? ''), e.name ?? '', e.message ?? ''); current = e.cause;
  }
  const text = parts.join(' ').toUpperCase();
  if (text.includes('CONFIG_ERROR')) return 'CONFIG_ERROR';
  if (/INCONSISTENT_GROUP_PROTOCOL|SUPPORTED PROTOCOLS ARE INCOMPATIBLE|\b23\b/.test(text)) return 'KAFKA_GROUP_PROTOCOL_ERROR';
  if (/KAFKA_GROUP_NOT_FOUND|GROUP_ID_NOT_FOUND|\b69\b/.test(text)) return 'KAFKA_GROUP_NOT_FOUND';
  if (/TOPIC_AUTHORIZATION|\b29\b/.test(text)) return 'KAFKA_TOPIC_AUTHORIZATION_ERROR';
  if (/GROUP_AUTHORIZATION|\b30\b/.test(text)) return 'KAFKA_GROUP_AUTHORIZATION_ERROR';
  if (/UNKNOWN_TOPIC|\b3\b/.test(text)) return 'KAFKA_UNKNOWN_TOPIC';
  if (/TIMEOUT|TIMEDOUT/.test(text)) return 'KAFKA_TIMEOUT';
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(text)) return 'KAFKA_TLS_ERROR';
  if (/AUTH|PKCS#12/.test(text)) return 'KAFKA_AUTH_ERROR';
  return 'KAFKA_CONNECTION_ERROR';
}
export async function createKafka(profile: Profile, id: string, redactor: Redactor, factory: (config: KafkaConfig) => Kafka = config => new Kafka(config)) {
  const credential = kafkaCredential(profile);
  const prepared = await new MtlsAuthProvider(credential, redactor).prepareRequest();
  return factory({ brokers: profile.kafka!.brokers, clientId: clientId(id), ssl: { ...prepared.tls, rejectUnauthorized: true },
    connectionTimeout: 10000, requestTimeout: 30000, retry: { retries: 2 }, logLevel: logLevel.NOTHING });
}
export type AdminClient = Pick<ReturnType<Kafka['admin']>, 'connect' | 'fetchTopicMetadata' | 'disconnect'>;
export async function connectionTest(admin: AdminClient) {
  try { await admin.connect(); await admin.fetchTopicMetadata({ topics: [] }); }
  finally { await admin.disconnect(); }
}
// KafkaJS 2.2.4 defaults to [PartitionAssigners.roundRobin], whose protocol name is this.
export const consumerAssignors = ['RoundRobinAssigner'] as const;
export function groupProtocolDiagnostic(profile: string, groupId: string) {
  return `Consumer group protocol mismatch.\n\nThe selected consumer group already has active members whose supported\npartition assignment protocol is incompatible with this client.\n\nClient supported assignors: ${consumerAssignors.join(', ')}\n\nRun:\n\n  kafka group-describe --profile ${profile} --group-id ${groupId}\n\nto inspect the group's current protocol.`;
}
export type GroupAdminClient = Pick<ReturnType<Kafka['admin']>, 'connect' | 'describeGroups' | 'disconnect'>;
export async function describeGroup(admin: GroupAdminClient, groupId: string) {
  validateGroupId(groupId);
  try {
    await admin.connect();
    const { groups } = await admin.describeGroups([groupId]);
    const group = groups.find(group => group.groupId === groupId);
    if (!group || group.state === 'Dead') throw new Error(`KAFKA_GROUP_NOT_FOUND: Consumer group ${groupId} does not exist`);
    // Whitelist diagnostic fields: never retain opaque member metadata or assignments.
    return { groupId: group.groupId, state: group.state, protocolType: group.protocolType, protocol: group.protocol,
      memberCount: group.members.length, members: group.members.map(member => ({
        ...(member.clientId ? { clientId: member.clientId } : {}),
        ...(member.memberId ? { memberId: member.memberId } : {}),
        ...(member.clientHost ? { host: member.clientHost } : {}),
        ...(Buffer.isBuffer(member.memberAssignment) ? { assignmentBytes: member.memberAssignment.length } : {})
      })) };
  } finally { await admin.disconnect(); }
}
export function groupDescriptionOutput(group: Awaited<ReturnType<typeof describeGroup>>) {
  return [`Group ID: ${group.groupId}`, `State: ${group.state}`,
    ...(group.protocolType ? [`Protocol type: ${group.protocolType}`] : []),
    ...(group.protocol ? [`Protocol: ${group.protocol}`] : []), `Members: ${group.memberCount}`,
    ...group.members.map((member, index) => [`\nMember ${index + 1}`,
      ...(member.clientId ? [`  Client ID: ${member.clientId}`] : []),
      ...(member.memberId ? [`  Member ID: ${member.memberId}`] : []),
      ...(member.host ? [`  Host: ${member.host}`] : []),
      ...(member.assignmentBytes !== undefined ? [`  Assignment metadata: ${member.assignmentBytes} bytes (opaque payload omitted)`] : [])].join('\n'))].join('\n');
}
export type ConsumerClient = Pick<ReturnType<Kafka['consumer']>, 'connect' | 'subscribe' | 'run' | 'stop' | 'disconnect' | 'on' | 'events'>;
export type ConsumeOptions = { topic: string; count?: number; durationMs?: number; fromBeginning?: boolean; signal?: AbortSignal };
export function validateConsume(options: ConsumeOptions) {
  if (!/^[A-Za-z0-9._-]{1,249}$/.test(options.topic) || ['.', '..'].includes(options.topic)) throw new Error('CONFIG_ERROR: Invalid Kafka topic');
  if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count <= 0)) throw new Error('CONFIG_ERROR: Count must be a positive integer');
  if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0 || options.durationMs > 2147483647)) throw new Error('CONFIG_ERROR: Duration must be positive and at most 24.8 days');
  if (options.count === undefined && options.durationMs === undefined) throw new Error('CONFIG_ERROR: Consume requires --count or --duration');
}
export async function consume(consumer: ConsumerClient, options: ConsumeOptions, record: (message: EachMessagePayload) => Promise<void>) {
  validateConsume(options);
  let stopped = false, count = 0, failure: unknown;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => { stopped = true; finish(); };
  const removeCrash = consumer.on(consumer.events.CRASH, event => { failure = event.payload.error; stop(); });
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = options.durationMs === undefined ? undefined : setTimeout(stop, options.durationMs);
  try {
    if (options.signal?.aborted) stop();
    if (!stopped) await consumer.connect();
    if (!stopped) await consumer.subscribe({ topic: options.topic, fromBeginning: options.fromBeginning ?? false });
    if (!stopped) await consumer.run({ partitionsConsumedConcurrently: 1, autoCommitThreshold: 1, eachBatchAutoResolve: false, eachBatch: async batch => {
      for (const message of batch.batch.messages) {
        if (stopped || !batch.isRunning() || batch.isStale()) break;
        try {
          await record({ topic: batch.batch.topic, partition: batch.batch.partition, message, heartbeat: batch.heartbeat, pause: batch.pause });
          batch.resolveOffset(message.offset); count++;
          if (count >= (options.count ?? Infinity)) stop();
          if (!stopped) await batch.heartbeat();
        } catch (error) { failure = error; stop(); throw error; }
      }
      // Commit only explicitly resolved records, including the last record at a bound.
      await batch.commitOffsetsIfNecessary();
    } });
    if (!stopped) await done;
    if (failure) throw failure;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop); removeCrash();
    try { await consumer.stop(); } finally { await consumer.disconnect(); }
  }
  return count;
}
