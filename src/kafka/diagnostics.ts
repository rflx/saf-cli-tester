import type { EachMessagePayload } from 'kafkajs';
import type { Redactor } from '../logging/redactor.js';

// Decode only bounded UTF-8 JSON objects. No binary dumps or SAF crypto.
function json(buffer: Buffer | null, max: number): unknown {
  if (!buffer) return null;
  if (buffer.length > max) return '[omitted: size limit]';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value : '[omitted: not a JSON object]';
  } catch { return '[omitted: binary or non-JSON]'; }
}
export function messageDiagnostic(input: EachMessagePayload, includePayload: boolean, maxBytes: number, redactor: Redactor) {
  const { topic, partition, message } = input;
  const key = message.key;
  // Keys can also contain customer data; retain length instead of untrusted content.
  return redactor.sanitize({ topic, partition, offset: message.offset, kafkaTimestamp: message.timestamp,
    messageKey: key === null ? null : { sizeBytes: key.length }, messageSizeBytes: message.value?.length ?? 0,
    result: 'success', ...(includePayload ? { payload: json(message.value, maxBytes) } : {}) }) as Record<string, unknown>;
}
export class KafkaStats {
  private start = performance.now();
  messagesConsumed = 0; bytesConsumed = 0; errors = 0;
  private partitions = new Set<number>();
  add(partition: number, bytes: number) { this.messagesConsumed++; this.bytesConsumed += bytes; this.partitions.add(partition); }
  summary() {
    const durationSeconds = (performance.now() - this.start) / 1000;
    return { messagesConsumed: this.messagesConsumed, bytesConsumed: this.bytesConsumed, partitionsSeen: this.partitions.size,
      errors: this.errors, durationSeconds, messagesPerSecond: durationSeconds ? this.messagesConsumed / durationSeconds : 0 };
  }
}
export const kafkaCsvFields = ['timestamp', 'runId', 'profile', 'environment', 'topic', 'partition', 'offset', 'groupId', 'clientId', 'messageSizeBytes', 'result', 'errorType'];
