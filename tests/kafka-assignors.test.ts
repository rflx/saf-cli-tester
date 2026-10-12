import test from 'node:test';
import assert from 'node:assert/strict';
import { AssignerProtocol, PartitionAssigners, type Kafka, type PartitionAssigner } from 'kafkajs';
import { configuredAssignors } from '../src/kafka/assignors.js';
import { consumerAssignors, createConsumer, groupProtocolDiagnostic } from '../src/kafka/client.js';

const config = { cluster: { findTopicPartitionMetadata: (topic: string) =>
  (topic === 'a' ? [4, 0, 3, 1, 2] : [0, 1]).map(partitionId => ({ partitionId })) }
} as unknown as Parameters<PartitionAssigner>[0];
const member = (memberId: string, topics: string[]) => ({ memberId,
  memberMetadata: AssignerProtocol.MemberMetadata.encode({ version: 0, topics, userData: Buffer.alloc(0) }) });

test('shared consumer creation offers range, roundrobin and the existing KafkaJS protocol without changing group or offsets', () => {
  let offered: PartitionAssigner[] = [];
  const consumer = {} as ReturnType<Kafka['consumer']>;
  const kafka = { consumer(options) {
    assert.deepEqual(Object.keys(options).sort(), ['groupId', 'partitionAssigners']);
    assert.equal(options.groupId, ' unchanged-group ');
    offered = options.partitionAssigners!;
    return consumer;
  } } as Pick<Kafka, 'consumer'>;
  assert.equal(createConsumer(kafka, ' unchanged-group '), consumer);
  const protocols = offered.map(factory => factory(config).protocol({ topics: ['a'] }));
  assert.deepEqual(protocols.map(protocol => protocol.name), ['range', 'roundrobin', 'RoundRobinAssigner']);
  for (const protocol of protocols) {
    assert.deepEqual(AssignerProtocol.MemberMetadata.decode(protocol.metadata), { version: 0, topics: ['a'], userData: Buffer.alloc(0) });
  }
  // Fake existing groups negotiate by exact protocol name, as JoinGroup requires.
  for (const existing of ['range', 'roundrobin', 'RoundRobinAssigner']) {
    assert.ok(protocols.some(protocol => protocol.name === existing));
  }
  assert.equal(offered[2], PartitionAssigners.roundRobin);
});

test('range leader assigns contiguous numeric ranges per topic to subscribed members in member ID order', async () => {
  const assignor = configuredAssignors[0].factory(config);
  const assignments = await assignor.assign({ topics: ['a', 'b'], members: [member('z', ['a']), member('a', ['a', 'b'])] });
  assert.deepEqual(assignments.map(value => ({ memberId: value.memberId,
    assignment: AssignerProtocol.MemberAssignment.decode(value.memberAssignment)!.assignment })), [
    { memberId: 'a', assignment: { a: [0, 1, 2], b: [0, 1] } },
    { memberId: 'z', assignment: { a: [3, 4] } }
  ]);
});

test('range includes idle members when there are fewer partitions than subscribers', async () => {
  const assignments = await configuredAssignors[0].factory(config).assign({ topics: ['b'],
    members: [member('c', ['b']), member('b', ['b']), member('a', ['b']), member('d', ['other'])] });
  assert.deepEqual(assignments.map(value => AssignerProtocol.MemberAssignment.decode(value.memberAssignment)!.assignment),
    [{ b: [0] }, { b: [1] }, { b: [] }, {}]);
  assert.deepEqual(await configuredAssignors[0].factory(config).assign({ topics: ['a'], members: [] }), []);
});

test('standard roundrobin keeps KafkaJS round-robin assignment behavior and legacy assignor remains unchanged', async () => {
  const orderedConfig = { ...config, cluster: { findTopicPartitionMetadata: () => [0, 1, 2, 3, 4].map(partitionId => ({ partitionId })) } } as unknown as Parameters<PartitionAssigner>[0];
  const group = { topics: ['a'], members: [member('z', ['a']), member('a', ['a'])] };
  const standard = await configuredAssignors[1].factory(orderedConfig).assign(group);
  const legacy = await PartitionAssigners.roundRobin(orderedConfig).assign(group);
  assert.deepEqual(standard, legacy);
  assert.deepEqual(standard.map(value => AssignerProtocol.MemberAssignment.decode(value.memberAssignment)!.assignment),
    [{ a: [0, 2, 4] }, { a: [1, 3] }]);
});

test('protocol diagnostics derive labels and wire names from configured assignors', () => {
  assert.deepEqual(consumerAssignors, ['RangeAssignor', 'RoundRobinAssigner']);
  const diagnostic = groupProtocolDiagnostic('test', 'unchanged');
  for (const assignor of configuredAssignors) assert.ok(diagnostic.includes(`${assignor.label} (${assignor.protocol})`));
  assert.ok(diagnostic.includes('kafka group-describe --profile test --group-id unchanged'));
});
