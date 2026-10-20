import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Kafka } from 'kafkajs';
import { Command } from 'commander';
import { kafkaCommands } from '../src/cli/commands/kafka.js';
import { describeTopic, topicDescriptionOutput, kafkaError, type AdminClient } from '../src/kafka/client.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { Redactor } from '../src/logging/redactor.js';

const partitions = [
  { partitionId: 0, partitionErrorCode: 0, leader: 2, replicas: [2, 3], isr: [2] },
  { partitionId: 1, partitionErrorCode: 0, leader: -1, replicas: [3, 2], isr: [] }
];

test('KafkaJS metadata parsers reject topic and partition errors before admin returns metadata', async () => {
  const require = createRequire(import.meta.url);
  const createAdmin = require('kafkajs/src/admin');
  const metadataProtocol = require('kafkajs/src/protocol/requests/metadata');
  // Exercise the installed dependency, not a mock that returns impossible successful metadata.
  for (const version of metadataProtocol.versions) {
    const { response } = metadataProtocol.protocol({ version })({ topics: ['topic'] });
    for (const level of ['topic', 'partition']) {
      for (const [code, type, classification] of [
        [3, 'UNKNOWN_TOPIC_OR_PARTITION', 'KAFKA_UNKNOWN_TOPIC'],
        [29, 'TOPIC_AUTHORIZATION_FAILED', 'KAFKA_TOPIC_AUTHORIZATION_ERROR'],
        [5, 'LEADER_NOT_AVAILABLE', 'KAFKA_CONNECTION_ERROR']
      ] as const) {
        const calls: string[] = [];
        const admin: AdminClient = createAdmin({
          logger: { namespace: () => ({}) },
          cluster: {
            connect: async () => { calls.push('connect'); },
            disconnect: async () => { calls.push('disconnect'); },
            metadata: async (options: unknown) => {
              assert.deepEqual(options, { topics: ['topic'] });
              return response.parse({ topicMetadata: [{ topic: 'topic',
                topicErrorCode: level === 'topic' ? code : 0,
                partitionMetadata: [{ ...partitions[0], partitionErrorCode: level === 'partition' ? code : 0 }]
              }] });
            }
          }
        });
        await assert.rejects(describeTopic(admin, 'topic'), error => {
          assert.equal((error as { code: number }).code, code);
          assert.equal((error as { type: string }).type, type);
          assert.equal(kafkaError(error), classification);
          return true;
        });
        assert.deepEqual(calls, ['connect', 'disconnect']);
      }
    }
  }
});
test('topic service selects exactly one topic, whitelists metadata and always disconnects', async () => {
  for (const state of ['ok', 'missing', 'authorization', 'tls', 'network', 'timeout']) {
    const calls: string[] = [];
    const errors: Record<string, Error> = { authorization: Object.assign(new Error('denied'), { type: 'TOPIC_AUTHORIZATION_FAILED' }), tls: new Error('TLS certificate'), network: new Error('ECONNREFUSED'), timeout: new Error('request timeout') };
    const admin: AdminClient = { connect: async () => { calls.push('connect'); }, disconnect: async () => { calls.push('disconnect'); }, fetchTopicMetadata: async options => {
      calls.push('metadata'); assert.deepEqual(options, { topics: ['topic'] });
      if (errors[state]) throw errors[state];
      return { topics: state === 'missing' ? [] : [{ name: 'topic', partitions: partitions.map(p => ({ ...p, get payload(): never { throw new Error('payload accessed'); } })) }] };
    } };
    if (state === 'ok') {
      const result = await describeTopic(admin, 'topic'); assert.deepEqual(result, { topic: 'topic', partitionCount: 2, partitions });
      assert.equal(topicDescriptionOutput(result), 'Topic: topic\nPartitions: 2\n\nPartition 0\n  Leader: 2\n  Replicas: 2, 3\n  ISR: 2\n\nPartition 1\n  Leader: unavailable\n  Replicas: 3, 2\n  ISR: (none)');
    } else await assert.rejects(describeTopic(admin, 'topic'), error => {
      assert.equal(kafkaError(error), ({ missing: 'KAFKA_UNKNOWN_TOPIC', authorization: 'KAFKA_TOPIC_AUTHORIZATION_ERROR', tls: 'KAFKA_TLS_ERROR', network: 'KAFKA_CONNECTION_ERROR', timeout: 'KAFKA_TIMEOUT' } as Record<string, string>)[state]); return true;
    });
    assert.deepEqual(calls, ['connect', 'metadata', 'disconnect']);
    calls.length = 0;
    for (const topic of ['', ' ', '..', 'bad/topic']) await assert.rejects(describeTopic(admin, topic), /CONFIG_ERROR/);
    assert.deepEqual(calls, []);
  }
});

test('CLI topic registration, required arguments and forbidden consumer flags', async () => {
  const program = () => { const p = new Command().exitOverride().configureOutput({ writeErr: () => {} }); kafkaCommands(p, new Redactor()); return p; };
  const kafka = program().commands[0]!;
  assert.match(kafka.helpInformation(), /topic-describe/);
  const command = kafka.commands.find(c => c.name() === 'topic-describe')!;
  for (const flag of ['--profile', '--topic', '--client-id', '--export', '--output', '--interval', '--count', '--duration', '--changes-only', '--help']) assert.ok(command.helpInformation().includes(flag));
  for (const flag of ['--group-id', '--from-beginning', '--include-payload']) assert.ok(!command.helpInformation().includes(flag));
  for (const args of [[], ['--topic', 'topic'], ['--profile', 'test']]) await assert.rejects(program().parseAsync(['kafka', 'topic-describe', ...args], { from: 'user' }), /required option/);
  await assert.rejects(program().parseAsync(['kafka', 'topic-describe', '--profile', 'test', '--topic', 'topic', '--client-id', 'bad'], { from: 'user' }), /UUID/);
});

test('CLI topic uses admin only, reuses UUID and exports redacted metadata without message rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saf-topics-'));
  const originalAdmin = Kafka.prototype.admin, originalConsumer = Kafka.prototype.consumer, originalProducer = Kafka.prototype.producer;
  const originalPrepare = MtlsAuthProvider.prototype.prepareRequest, originalLog = console.log, originalError = console.error, originalExit = process.exitCode;
  const output: string[] = []; let fail = false; let calls = 0;
  const id = '11111111-2222-3333-4444-555555555555';
  MtlsAuthProvider.prototype.prepareRequest = async () => ({ headers: {}, tls: { pfx: Buffer.from('fake'), passphrase: 'profile-secret' } });
  Kafka.prototype.consumer = () => { throw new Error('consumer forbidden'); };
  Kafka.prototype.producer = () => { throw new Error('producer forbidden'); };
  Kafka.prototype.admin = function () { return { connect: async () => {}, disconnect: async () => {}, fetchTopicMetadata: async (options: unknown) => {
    calls++; assert.deepEqual(options, { topics: ['topic'] });
    if (fail) throw new Error('TLS profile-secret');
    return { topics: [{ name: 'topic', partitions }] };
  } } as ReturnType<Kafka['admin']>; };
  console.log = value => { output.push(String(value)); }; console.error = console.log;
  try {
    await mkdir(join(root, 'profiles'));
    await writeFile(join(root, 'profiles/test.yaml'), JSON.stringify({ name: 'test', environment: 'IAT', credentials: { mtls: { p12Path: '/fake.p12', p12Password: 'profile-secret' } }, kafka: { brokers: ['broker.invalid:9092'], auth: { mode: 'mtls', credential: 'mtls' } } }));
    for (const format of ['csv', 'summary', 'both']) {
      const p = new Command().option('--config-dir <path>', '', root); kafkaCommands(p, new Redactor());
      await p.parseAsync(['kafka', 'topic-describe', '--profile', 'test', '--topic', 'topic', '--client-id', id, '--export', format, '--output', join(root, format)], { from: 'user' });
      if (format === 'csv') assert.equal((await readFile(join(root, format), 'utf8')).trim().split('\n').length, 1);
      if (format === 'summary') { const summary = JSON.parse(await readFile(join(root, format), 'utf8')); assert.deepEqual(summary.partitions, partitions); assert.equal(summary.clientId, id); assert.equal(summary.messagesConsumed, 0); }
      if (format === 'both') assert.equal((await readdir(join(root, format))).length, 2);
    }
    for (const failing of [false, true]) {
      fail = failing;
      const p = new Command().option('--config-dir <path>', '', root); kafkaCommands(p, new Redactor());
      const path = join(root, `poll-${failing}.json`);
      const before = output.length;
      await p.parseAsync(['kafka', 'topic-describe', '--profile', 'test', '--topic', 'topic', '--interval', '0.001', '--count', '3', '--changes-only', '--export', 'summary', '--output', path], { from: 'user' });
      const summary = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(summary.samplesAttempted, 3); assert.equal(summary.successfulSamples, failing ? 0 : 3); assert.equal(summary.failedSamples, failing ? 3 : 0);
      if (!failing) {
        assert.deepEqual(summary.latestSuccessfulMetadata.partitions, partitions);
        assert.equal(output.slice(before).filter(line => line.includes('Sample ')).length, 1);
      } else assert.equal(output.slice(before).filter(line => line.includes('KAFKA_TLS_ERROR')).length, 3);
      const logs = await Promise.all((await readdir(join(root, 'logs'))).map(file => readFile(join(root, 'logs', file), 'utf8')));
      const run = logs.map(log => log.trim().split('\n').map(line => JSON.parse(line))).find(records => records.some(r => r.summary?.samplesAttempted === 3 && r.summary.failedSamples === (failing ? 3 : 0)))!;
      assert.equal(run.filter(r => r.sample !== undefined).length, 3);
    }
    fail = true;
    const p = new Command().option('--config-dir <path>', '', root); kafkaCommands(p, new Redactor());
    await p.parseAsync(['kafka', 'topic-describe', '--profile', 'test', '--topic', 'topic'], { from: 'user' });
    assert.equal(process.exitCode, 1); assert.equal(calls, 10);
    assert.match(output.join('\n'), /Client UUID: 11111111-2222-3333-4444-555555555555/);
    assert.ok(!output.join('\n').includes('profile-secret'));
    for (const file of await readdir(join(root, 'logs'))) {
      const content = await readFile(join(root, 'logs', file), 'utf8'); assert.ok(!content.includes('profile-secret')); assert.ok(!content.includes('groupId'));
      const records = content.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records[0].operation, 'topic-describe');
      assert.ok(records.some(r => r.partitionCount === 2 || r.errorType === 'KAFKA_TLS_ERROR'));
    }
  } finally {
    Kafka.prototype.admin = originalAdmin; Kafka.prototype.consumer = originalConsumer; Kafka.prototype.producer = originalProducer;
    MtlsAuthProvider.prototype.prepareRequest = originalPrepare; console.log = originalLog; console.error = originalError; process.exitCode = originalExit;
    await rm(root, { recursive: true, force: true });
  }
});
