import { AssignerProtocol, PartitionAssigners, type Assignment, type PartitionAssigner } from 'kafkajs';

const { MemberMetadata, MemberAssignment } = AssignerProtocol;
const version = 0;
const userData = Buffer.alloc(0);

// KafkaJS 2.2.4 exposes a custom PartitionAssigner API, but no built-in range assignor.
const range: PartitionAssigner = ({ cluster }) => ({
  name: 'range', version,
  protocol: ({ topics }) => ({ name: 'range', metadata: MemberMetadata.encode({ version, topics, userData }) }),
  async assign({ members, topics }) {
    const subscriptions = members.map(member => {
      const metadata = MemberMetadata.decode(member.memberMetadata);
      if (!metadata) throw new Error('Invalid consumer subscription metadata');
      return { ...member, topics: metadata.topics, assignment: Object.create(null) as Assignment };
    }).sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
    for (const topic of topics) {
      const subscribers = subscriptions.filter(member => member.topics.includes(topic));
      if (!subscribers.length) continue;
      const partitions = cluster.findTopicPartitionMetadata(topic).map(partition => partition.partitionId).sort((a, b) => a - b);
      const size = Math.floor(partitions.length / subscribers.length), extra = partitions.length % subscribers.length;
      subscribers.forEach((member, index) => {
        const start = index * size + Math.min(index, extra);
        member.assignment[topic] = partitions.slice(start, start + size + (index < extra ? 1 : 0));
      });
    }
    return subscriptions.map(member => ({ memberId: member.memberId,
      memberAssignment: MemberAssignment.encode({ version, assignment: member.assignment, userData }) }));
  }
});

// Keep the native KafkaJS wire name as well as the standard roundrobin name.
const roundrobin: PartitionAssigner = config => {
  const assignor = PartitionAssigners.roundRobin(config);
  return { ...assignor, name: 'roundrobin', protocol(options) {
    return { ...assignor.protocol(options), name: 'roundrobin' };
  } };
};

export const configuredAssignors = [
  { label: 'RangeAssignor', protocol: 'range', factory: range },
  { label: 'RoundRobinAssigner', protocol: 'roundrobin', factory: roundrobin },
  { label: 'RoundRobinAssigner', protocol: 'RoundRobinAssigner', factory: PartitionAssigners.roundRobin }
] as const;
