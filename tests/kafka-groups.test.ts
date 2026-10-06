import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kafka, type GroupDescription } from 'kafkajs';
import { Command } from 'commander';
import { kafkaCommands } from '../src/cli/commands/kafka.js';
import { describeGroup, kafkaError, type GroupAdminClient } from '../src/kafka/client.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { Redactor } from '../src/logging/redactor.js';

const groupId = 'CG-00001-IDP5061788';
function group(state = 'Stable'): GroupDescription {
  return { groupId, state: state as GroupDescription['state'], protocol: 'range', protocolType: 'consumer', members: state === 'Empty' ? [] : [
    { clientId: 'client-one', memberId: 'member-one', clientHost: 'host-one', memberAssignment: Buffer.from('opaque-sensitive'), memberMetadata: Buffer.from('opaque-sensitive') },
    {} as GroupDescription['members'][number]
  ] };
}
test('group description is read-only, handles optional fields, empty/unknown groups and admin errors', async () => {
  for (const state of ['Stable', 'Empty', 'Dead', 'missing', 'error']) {
    const calls: string[] = [];
    const admin = { connect: async () => { calls.push('connect'); }, disconnect: async () => { calls.push('disconnect'); },
      describeGroups: async (ids: string[]) => { assert.deepEqual(ids, [groupId]); calls.push('describe'); if (state === 'error') throw new Error('broker unavailable'); return { groups: state === 'missing' ? [] : [group(state)] }; } } as GroupAdminClient;
    if (['Dead', 'missing', 'error'].includes(state)) await assert.rejects(describeGroup(admin, groupId), state === 'error' ? /broker unavailable/ : /KAFKA_GROUP_NOT_FOUND/);
    else {
      const result = await describeGroup(admin, groupId);
      assert.equal(result.state, state); assert.equal(result.protocol, 'range'); assert.equal(result.protocolType, 'consumer');
      assert.equal(result.memberCount, state === 'Empty' ? 0 : 2);
      if (state === 'Stable') { assert.deepEqual(result.members[1], {}); assert.equal(result.members[0]!.host, 'host-one'); }
      assert.ok(!JSON.stringify(result).includes('opaque-sensitive'));
    }
    assert.deepEqual(calls, ['connect', 'describe', 'disconnect']);
  }
  for (const error of [{ type: 'INCONSISTENT_GROUP_PROTOCOL' }, { code: 23 }, { cause: new Error("The group member's supported protocols are incompatible with those of existing members") }]) assert.equal(kafkaError(error), 'KAFKA_GROUP_PROTOCOL_ERROR');
  assert.equal(kafkaError({ type: 'GROUP_ID_NOT_FOUND', code: 69 }), 'KAFKA_GROUP_NOT_FOUND');
});

test('CLI group inspection and consume mismatch use redacted logs and preserve group identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saf-group-diagnostics-'));
  const originalAdmin = Kafka.prototype.admin, originalConsumer = Kafka.prototype.consumer;
  const originalPrepare = MtlsAuthProvider.prototype.prepareRequest;
  const originalLog = console.log, originalError = console.error, originalExit = process.exitCode;
  const output: string[] = [], supplied: string[] = [];
  let state = 'Stable', failure: unknown;
  MtlsAuthProvider.prototype.prepareRequest = async () => ({ headers: {}, tls: { pfx: Buffer.from('fake'), passphrase: 'profile-secret' } });
  Kafka.prototype.admin = function () { return { connect: async () => {}, disconnect: async () => {}, describeGroups: async (ids: string[]) => {
    supplied.push(...ids); if (failure) throw failure;
    const result = group(state); if (result.members.length) result.members[0]!.clientHost = 'profile-secret';
    return { groups: [result] };
  } } as ReturnType<Kafka['admin']>; };
  Kafka.prototype.consumer = function (options) {
    supplied.push(options.groupId);
    return { events: { CRASH: 'crash' }, on: () => () => {}, connect: async () => { throw failure; }, stop: async () => {}, disconnect: async () => {} } as unknown as ReturnType<Kafka['consumer']>;
  };
  console.log = value => { output.push(String(value)); }; console.error = value => { output.push(String(value)); };
  try {
    await mkdir(join(root, 'profiles'));
    await writeFile(join(root, 'profiles/test.yaml'), JSON.stringify({ name: 'test', environment: 'IAT', credentials: { mtls: { p12Path: '/fake.p12', p12Password: 'profile-secret' } }, kafka: { brokers: ['broker.invalid:9092'], auth: { mode: 'mtls', credential: 'mtls' } } }));
    async function run(command: string) {
      output.length = 0; process.exitCode = undefined;
      const program = new Command().option('--config-dir <path>', '', root); kafkaCommands(program, new Redactor());
      await program.parseAsync(['kafka', command, '--profile', 'test', '--group-id', groupId, ...(command === 'consume' ? ['--topic', 'topic', '--count', '1'] : [])], { from: 'user' });
      assert.equal(supplied.at(-1), groupId);
      assert.match(output.join('\n'), /Continuing with the supplied group ID/);
      assert.ok(!output.join('\n').includes('profile-secret'));
    }
    await run('group-describe'); assert.equal(process.exitCode, undefined);
    assert.match(output.join('\n'), /State: Stable\nProtocol type: consumer\nProtocol: range\nMembers: 2/);
    assert.match(output.join('\n'), /Member 2/); assert.match(output.join('\n'), /\[REDACTED\]/);
    state = 'Empty'; await run('group-describe'); assert.equal(process.exitCode, undefined); assert.match(output.join('\n'), /Members: 0/);
    state = 'Dead'; await run('group-describe'); assert.equal(process.exitCode, 1); assert.match(output.join('\n'), /KAFKA_GROUP_NOT_FOUND/);
    failure = new Error('broker unavailable'); await run('group-describe'); assert.match(output.join('\n'), /KAFKA_CONNECTION_ERROR/);
    for (const error of [Object.assign(new Error('protocol mismatch'), { type: 'INCONSISTENT_GROUP_PROTOCOL' }), new Error('supported protocols are incompatible')]) {
      failure = error; await run('consume'); assert.equal(process.exitCode, 1);
      assert.match(output.join('\n'), /KAFKA_GROUP_PROTOCOL_ERROR/);
      assert.match(output.join('\n'), /kafka group-describe --profile test --group-id CG-00001-IDP5061788/);
      assert.match(output.join('\n'), /RoundRobinAssigner/);
    }
    assert.deepEqual(supplied, Array(6).fill(groupId));
    const records: Record<string, unknown>[] = [];
    for (const file of await readdir(join(root, 'logs'))) {
      const content = await readFile(join(root, 'logs', file), 'utf8');
      assert.ok(!content.includes('profile-secret')); assert.ok(!content.includes('opaque-sensitive')); assert.ok(!content.includes('memberAssignment')); assert.ok(!content.includes('memberMetadata'));
      records.push(...content.trim().split('\n').map(line => JSON.parse(line)));
    }
    const stable = records.find(record => record.state === 'Stable')!;
    for (const field of ['runId', 'profile', 'environment', 'transport', 'groupId', 'state', 'protocolType', 'protocol', 'memberCount', 'result']) assert.ok(field in stable);
    assert.equal(stable.memberCount, 2);
  } finally {
    Kafka.prototype.admin = originalAdmin; Kafka.prototype.consumer = originalConsumer; MtlsAuthProvider.prototype.prepareRequest = originalPrepare;
    console.log = originalLog; console.error = originalError; process.exitCode = originalExit;
    await rm(root, { recursive: true, force: true });
  }
});
