import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kafka, type ConsumerRunConfig, type EachBatchPayload, type EachMessagePayload } from 'kafkajs';
import { Command } from 'commander';
import { kafkaCommands } from '../src/cli/commands/kafka.js';
import { clientId, connectionTest, consume, createKafka, kafkaCredential, kafkaError, validateConsume, validateGroupId, type ConsumerClient } from '../src/kafka/client.js';
import { kafkaCsvFields, KafkaStats, messageDiagnostic } from '../src/kafka/diagnostics.js';
import { profileSchema } from '../src/profiles/types.js';
import { Redactor } from '../src/logging/redactor.js';
import { RunExports } from '../src/logging/exports.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { openLog } from '../src/logging/jsonl.js';
import { Logger } from '../src/logging/logger.js';

const raw = { name: 'kafka-test', environment: 'PROD', credentials: { mtls: { p12Path: '/absent.p12', p12Password: 'kafka-secret' } }, kafka: { brokers: ['example.invalid:9092'], auth: { mode: 'mtls', credential: 'mtls' } } };
const profile = profileSchema.parse(raw);
const topic = 'eh.saf.333205.commission.out.v1';
function message(offset = '12345'): EachMessagePayload {
  return { topic, partition: 2, message: { offset, attributes: 0, timestamp: '1700000000000', key: Buffer.from('customer-name'), value: Buffer.from('{"secret":"kafka-secret","data":"test"}'), headers: { authorization: Buffer.from('arbitrary-secret') } }, heartbeat: async () => {}, pause: () => () => {} };
}
function mockConsumer(messages = true) {
  const calls: string[] = [], resolved: string[] = [];
  let running: Promise<void> | undefined;
  const consumer = {
    events: { CRASH: 'crash' }, on: () => () => { calls.push('removeCrash'); },
    connect: async () => { calls.push('connect'); }, subscribe: async (options: { fromBeginning: boolean }) => { calls.push(`subscribe:${options.fromBeginning}`); },
    run: async (options: ConsumerRunConfig) => {
      calls.push('run'); assert.equal(options.eachBatchAutoResolve, false);
      if (messages) running = Promise.resolve().then(async () => {
        await options.eachBatch!({ batch: { topic, partition: 2, messages: [message('1').message, message('2').message, message('3').message] },
          resolveOffset: (offset: string) => { resolved.push(offset); }, heartbeat: async () => {}, pause: () => () => {},
          isRunning: () => true, isStale: () => false, commitOffsetsIfNecessary: async () => { calls.push('commit'); } } as unknown as EachBatchPayload);
      });
    }, stop: async () => { await running; calls.push('stop'); }, disconnect: async () => { calls.push('disconnect'); }
  } as unknown as ConsumerClient;
  return { consumer, calls, resolved };
}
test('Kafka profile/credential resolution is mTLS-only and preserves environment', async () => {
  assert.deepEqual(kafkaCredential(profile), raw.credentials.mtls); assert.equal(profile.environment, 'PROD');
  assert.throws(() => kafkaCredential({ ...profile, kafka: undefined }), /CONFIG_ERROR/);
  for (const kafka of [{ ...raw.kafka, brokers: [] }, { ...raw.kafka, brokers: ['bad'] }, { ...raw.kafka, auth: { mode: 'oauth2', credential: 'oauth2' } }, { ...raw.kafka, auth: { mode: 'mtls', credential: 'missing' } }]) {
    assert.equal(profileSchema.safeParse({ ...raw, kafka }).success, false);
  }
  await assert.rejects(createKafka(profile, clientId(), new Redactor()), /Cannot read/);
});
test('SAF group convention is advisory; missing and empty group IDs are rejected', () => {
  for (const value of ['CG-12345-IDP123456', 'CG-123456-IDP123456']) assert.equal(validateGroupId(value), undefined);
  for (const value of ['CG-00001-IDP5061788', 'some-group']) assert.equal(validateGroupId(value), 'Warning: consumer group ID does not match the documented SAF 1.2.0 pattern\n^CG-(\\d{5,6})-IDP(\\d{6})$\nContinuing with the supplied group ID.');
  for (const value of [undefined, '', '   ']) assert.throws(() => validateGroupId(value), /CONFIG_ERROR/);
});
test('UUID IDs and consume bounds validated locally', () => {
  assert.notEqual(clientId(), clientId()); assert.equal(clientId(clientId()).length, 36);
  assert.throws(() => clientId('profile-name'), /UUID/);
  for (const options of [{ topic }, { topic, count: 0 }, { topic, count: 1.5 }, { topic: '../topic', count: 1 }, { topic, durationMs: Infinity }]) assert.throws(() => validateConsume(options), /CONFIG_ERROR/);
});
test('Kafka consume CLI warns only on SAF deviations and passes group IDs unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saf-kafka-groups-'));
  const originalPrepare = MtlsAuthProvider.prototype.prepareRequest;
  const originalConsumer = Kafka.prototype.consumer;
  const originalConsole = console.log;
  const previousExit = process.exitCode;
  const output: string[] = [], supplied: string[] = [];
  MtlsAuthProvider.prototype.prepareRequest = async function () { return { headers: {}, tls: { pfx: Buffer.from('mock-p12'), passphrase: 'mock-password' } }; };
  Kafka.prototype.consumer = function (options) { supplied.push(options.groupId); return mockConsumer().consumer as ReturnType<Kafka['consumer']>; };
  console.log = value => { output.push(String(value)); };
  try {
    await mkdir(join(root, 'profiles'));
    await writeFile(join(root, 'profiles/kafka-test.yaml'), JSON.stringify(raw));
    for (const groupId of ['CG-12345-IDP123456', 'CG-00001-IDP5061788', 'some-group', ' some-group ']) {
      output.length = 0;
      const program = new Command().option('--config-dir <path>', '', root);
      kafkaCommands(program, new Redactor());
      await program.parseAsync(['kafka', 'consume', '--profile', 'kafka-test', '--topic', topic, '--group-id', groupId, '--count', '1'], { from: 'user' });
      assert.equal(supplied.at(-1), groupId);
      const warnings = output.filter(value => value.startsWith('Warning:'));
      assert.deepEqual(warnings, groupId === 'CG-12345-IDP123456' ? [] : [validateGroupId(groupId)]);
      assert.equal(process.exitCode, previousExit);
    }
    const program = new Command().option('--config-dir <path>', '', root);
    kafkaCommands(program, new Redactor());
    await assert.rejects(program.parseAsync(['kafka', 'consume', '--profile', 'kafka-test', '--topic', topic, '--group-id', '', '--count', '1'], { from: 'user' }), /CONFIG_ERROR/);
    assert.equal(supplied.length, 4);
  } finally {
    MtlsAuthProvider.prototype.prepareRequest = originalPrepare;
    Kafka.prototype.consumer = originalConsumer;
    console.log = originalConsole;
    process.exitCode = previousExit;
    await rm(root, { recursive: true, force: true });
  }
});
test('connection-test uses only admin metadata and always disconnects', async () => {
  const calls: string[] = [];
  const admin = { connect: async () => { calls.push('connect'); }, fetchTopicMetadata: async () => { calls.push('metadata'); return { topics: [] }; }, disconnect: async () => { calls.push('disconnect'); } };
  await connectionTest(admin); assert.deepEqual(calls, ['connect', 'metadata', 'disconnect']);
  calls.length = 0;
  await assert.rejects(connectionTest({ ...admin, connect: async () => { throw new Error('TLS error'); } }), /TLS/);
  assert.deepEqual(calls, ['disconnect']);
});
test('classifies nested Kafka errors and TLS/auth/timeouts', () => {
  for (const [error, expected] of [[{ code: 'CERT_HAS_EXPIRED' }, 'KAFKA_TLS_ERROR'], [{ type: 'SASL_AUTHENTICATION_FAILED' }, 'KAFKA_AUTH_ERROR'], [{ cause: { type: 'TOPIC_AUTHORIZATION_FAILED' } }, 'KAFKA_TOPIC_AUTHORIZATION_ERROR'], [{ type: 'GROUP_AUTHORIZATION_FAILED' }, 'KAFKA_GROUP_AUTHORIZATION_ERROR'], [{ type: 'UNKNOWN_TOPIC_OR_PARTITION' }, 'KAFKA_UNKNOWN_TOPIC'], [{ code: 'ETIMEDOUT' }, 'KAFKA_TIMEOUT'], [{ code: 'ECONNREFUSED' }, 'KAFKA_CONNECTION_ERROR']]) assert.equal(kafkaError(error), expected);
});
test('count stops exactly and resolves no unprocessed offsets', async () => {
  const mock = mockConsumer(); const seen: string[] = [];
  assert.equal(await consume(mock.consumer, { topic, count: 2 }, async value => { seen.push(value.message.offset); }), 2);
  assert.deepEqual(seen, ['1', '2']); assert.deepEqual(mock.resolved, seen);
  assert.deepEqual(mock.calls, ['connect', 'subscribe:false', 'run', 'commit', 'removeCrash', 'stop', 'disconnect']);
});
test('duration and Ctrl+C-style abort stop idle consumers cleanly', async () => {
  const timed = mockConsumer(false);
  assert.equal(await consume(timed.consumer, { topic, durationMs: 10 }, async () => {}), 0);
  assert.ok(timed.calls.includes('disconnect'));
  const interrupted = mockConsumer(false), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try { await consume(interrupted.consumer, { topic, count: 1, signal: controller.signal }, async () => {}); }
  finally { clearTimeout(timer); }
  assert.ok(interrupted.calls.includes('stop')); assert.ok(interrupted.calls.includes('disconnect'));
});
test('record failure disconnects without resolving failed record', async () => {
  const mock = mockConsumer();
  // Mock run owns its background failure, just like the client's crash event.
  const original = mock.consumer.run;
  mock.consumer.run = async options => { await original(options); };
  await assert.rejects(consume(mock.consumer, { topic, count: 1 }, async () => { throw new Error('record failure'); }), /record failure/);
  assert.deepEqual(mock.resolved, []); assert.ok(mock.calls.includes('disconnect'));
});
test('metadata-only default, bounded JSON payload opt-in and central redaction', () => {
  const redactor = new Redactor(); redactor.register(raw);
  const diagnostic = messageDiagnostic(message(), false, 65536, redactor);
  assert.equal(diagnostic.offset, '12345'); assert.equal(diagnostic.partition, 2); assert.ok(!('payload' in diagnostic)); assert.ok(!('headers' in diagnostic));
  assert.ok(!JSON.stringify(diagnostic).includes('customer-name'));
  const included = messageDiagnostic(message(), true, 65536, redactor);
  assert.equal((included.payload as Record<string, string>).secret, '[REDACTED]');
  assert.equal(messageDiagnostic(message(), true, 1, redactor).payload, '[omitted: size limit]');
  const binary = message(); binary.message.value = Buffer.from([255, 0, 1]);
  assert.equal(messageDiagnostic(binary, true, 100, redactor).payload, '[omitted: binary or non-JSON]');
});
test('Kafka JSONL, CSV and summary retain UUID and omit credentials/payload from CSV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-kafka-'));
  try {
    const redactor = new Redactor(); redactor.register(raw); const id = clientId();
    const record = { timestamp: new Date().toISOString(), runId: 'test', profile: profile.name, environment: profile.environment, transport: 'kafka', clientId: id, groupId: 'CG-123456-IDP123456', ...messageDiagnostic(message(), true, 65536, redactor) };
    const logger = new Logger(redactor, await openLog(dir, 'test')); await logger.record(record); await logger.close();
    const exports = await RunExports.open('both', dir, dir, 'test', redactor, kafkaCsvFields);
    const stats = new KafkaStats(); stats.add(2, 42);
    await exports!.record(record); await exports!.summary({ runId: 'test', profile: profile.name, environment: profile.environment, startTime: '', endTime: '' }, { transport: 'kafka', clientId: id, ...stats.summary() }); await exports!.close();
    for (const file of ['test.jsonl', 'test.csv', 'test.summary.json']) {
      const content = await readFile(join(dir, file), 'utf8'); assert.ok(content.includes(id)); assert.ok(!content.includes('kafka-secret')); assert.ok(!content.includes('arbitrary-secret'));
      if (file.endsWith('.csv')) { assert.ok(!content.includes('payload')); assert.ok(content.includes('12345')); }
    }
    const summary = JSON.parse(await readFile(join(dir, 'test.summary.json'), 'utf8')); assert.equal(summary.messagesConsumed, 1); assert.equal(summary.bytesConsumed, 42); assert.ok(!('statusCodes' in summary));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('P12 is validated in memory and passed unchanged into KafkaJS TLS options', async () => {
  const original = MtlsAuthProvider.prototype.prepareRequest;
  const pfx = Buffer.from('mock-p12'); const r = new Redactor();
  MtlsAuthProvider.prototype.prepareRequest = async function () { return { headers: {}, tls: { pfx, passphrase: 'mock-password' } }; };
  try {
    await createKafka(profile, clientId(), r, options => { assert.equal((options.ssl as { pfx: Buffer }).pfx, pfx); assert.equal((options.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true); assert.equal(options.sasl, undefined); return {} as Kafka; });
  } finally { MtlsAuthProvider.prototype.prepareRequest = original; }
});
