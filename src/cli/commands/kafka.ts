import { kafkaPayloadOutput } from '../../logging/payload.js';
import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { configPaths } from '../../config/paths.js';
import { loadProfile } from '../../profiles/loader.js';
import { Logger } from '../../logging/logger.js';
import type { Redactor } from '../../logging/redactor.js';
import { openLog } from '../../logging/jsonl.js';
import { RunExports, exportFormat } from '../../logging/exports.js';
import { durationMs } from '../../rest/poller.js';
import { clientId, connectionTest, consume, createKafka, kafkaError, validateConsume, validateGroupId } from '../../kafka/client.js';
import { KafkaStats, kafkaCsvFields, messageDiagnostic } from '../../kafka/diagnostics.js';

export function kafkaCommands(program: Command, redactor: Redactor) {
  const kafka = program.command('kafka').description('Native SAF Kafka transport diagnostics (mTLS only)');
  for (const name of ['connection-test', 'consume']) {
    const command = kafka.command(name).requiredOption('--profile <name>', 'TechUser profile')
      .option('--client-id <uuid>', 'Kafka UUID client ID (generated when omitted)')
      .option('--export <format>', 'csv, summary or both', exportFormat).option('--output <path>', 'Export file or directory');
    if (name === 'consume') command.requiredOption('--topic <topic>', 'SAF OUT topic').requiredOption('--group-id <id>', 'SAF consumer group ID')
      .option('--count <n>', 'Maximum records', Number).option('--duration <duration>', 'Maximum run duration, e.g. 10m')
      .option('--from-beginning', 'Read earliest available offsets for a new group')
      .option('--include-payload', 'Print consumed Kafka message payloads to the terminal (secret redaction); also log bounded JSON locally')
      .option('--max-payload-bytes <n>', 'Maximum payload diagnostic size (1–1048576)', Number, 65536);
    command.action(async (options: Record<string, unknown>) => {
      const id = clientId(options.clientId as string | undefined);
      const consumeOptions = { topic: String(options.topic), count: options.count as number | undefined,
        durationMs: options.duration === undefined ? undefined : durationMs(String(options.duration)), fromBeginning: options.fromBeginning === true };
      if (name === 'consume') {
        const warning = validateGroupId(options.groupId as string | undefined);
        if (warning) new Logger(redactor).console(warning);
        validateConsume(consumeOptions);
        if (!Number.isSafeInteger(options.maxPayloadBytes) || Number(options.maxPayloadBytes) < 1 || Number(options.maxPayloadBytes) > 1048576) throw new Error('CONFIG_ERROR: Invalid maximum payload bytes');
      }
      const paths = configPaths(program.opts().configDir as string | undefined);
      const profile = await loadProfile(paths.profiles, String(options.profile), redactor);
      const runId = randomUUID(), startTime = new Date().toISOString();
      const metadata = { runId, profile: profile.name, environment: profile.environment, transport: 'kafka', clientId: id,
        ...(name === 'consume' ? { topic: consumeOptions.topic, groupId: String(options.groupId), consumerGroupId: String(options.groupId) } : {}) };
      const exports = await RunExports.open(exportFormat(options.export), options.output as string | undefined, paths.logs, runId, redactor, kafkaCsvFields);
      let logger: Logger;
      try { logger = new Logger(redactor, await openLog(paths.logs, runId)); } catch (error) { await exports?.close(); throw error; }
      const controller = new AbortController(); const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const stats = new KafkaStats(); let failure: unknown;
      try {
        logger.console(`Profile: ${profile.name}\nEnvironment: ${profile.environment}\nKafka broker: ${profile.kafka?.brokers.join(', ')}\nAuthentication: mTLS\nClient UUID: ${id}\nRun ID: ${runId}\nLog: ${paths.logs}/${runId}.jsonl`);
        await logger.record({ timestamp: startTime, ...metadata, operation: name, payloadLogging: options.includePayload ? 'bounded-json' : 'metadata-only', result: 'started' });
        if (options.includePayload) logger.console('Warning: SAF event payloads may contain sensitive customer/business data. Payload diagnostics are stored locally.');
        const client = await createKafka(profile, id, redactor);
        if (name === 'connection-test') {
          await connectionTest(client.admin());
          await logger.record({ timestamp: new Date().toISOString(), ...metadata, result: 'success' });
          logger.console('TLS: OK\nKafka connection: OK\nBroker metadata: OK\n\nConnection test successful.');
        } else await consume(client.consumer({ groupId: String(options.groupId) }), { ...consumeOptions, signal: controller.signal }, async message => {
          const record = { timestamp: new Date().toISOString(), ...metadata, ...messageDiagnostic(message, options.includePayload === true, Number(options.maxPayloadBytes), redactor) };
          await logger.record(record); await exports?.record(record);
          stats.add(message.partition, message.message.value?.length ?? 0);
          logger.console(`\nTopic: ${message.topic}\nPartition: ${message.partition}\nOffset: ${message.message.offset}\nTimestamp: ${message.message.timestamp}\nKey: ${message.message.key === null ? '<null>' : `<${message.message.key.length} bytes>`}\nSize: ${message.message.value?.length ?? 0} bytes`);
          logger.console(options.includePayload === true ? kafkaPayloadOutput(message.message.value, redactor) : 'Payload: hidden');
        });
      } catch (error) {
        failure = error; stats.errors++;
        const record = { timestamp: new Date().toISOString(), ...metadata, result: 'error', errorType: kafkaError(error), error: error instanceof Error ? error.message : 'Kafka operation failed' };
        await logger.record(record); await exports?.record(record); logger.error(record); process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        try {
          const summary = { ...stats.summary(), transport: 'kafka', operation: name, topic: options.topic, groupId: options.groupId,
            clientId: id, result: failure ? 'error' : controller.signal.aborted ? 'interrupted' : 'success' };
          await logger.record({ ...metadata, summary });
          await exports?.summary({ runId, profile: profile.name, environment: profile.environment, startTime, endTime: new Date().toISOString() }, summary);
          if (name === 'consume') logger.console(`Run completed\nProfile: ${profile.name}\nEnvironment: ${profile.environment}\nTransport: Kafka\nTopic: ${options.topic}\nMessages consumed: ${summary.messagesConsumed}\nBytes consumed: ${summary.bytesConsumed}\nPartitions seen: ${summary.partitionsSeen}\nErrors: ${summary.errors}\nDuration: ${summary.durationSeconds.toFixed(1)} s\nMessages/sec: ${summary.messagesPerSecond.toFixed(2)}`);
          if (controller.signal.aborted && !failure) process.exitCode = 130;
        } finally { try { await logger.close(); } finally { await exports?.close(); } }
      }
    });
  }
}
