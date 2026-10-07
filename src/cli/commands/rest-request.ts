import { parseHttpVersion } from '../../rest/client.js';
import { payloadOutput } from '../../logging/payload.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { configPaths, expandPath } from '../../config/paths.js';
import { loadConfig } from '../../config/loader.js';
import { restCredential } from '../../profiles/types.js';
import { loadProfile } from '../../profiles/loader.js';
import { OAuth2AuthProvider } from '../../auth/oauth2.js';
import { MtlsAuthProvider } from '../../auth/mtls.js';
import { Logger } from '../../logging/logger.js';
import { openLog } from '../../logging/jsonl.js';
import { exportFormat, RunExports } from '../../logging/exports.js';
import type { Redactor } from '../../logging/redactor.js';
import { enforceProdSafety, executeRequest, resolveRequest } from '../../rest/request.js';
import { durationMs, poll } from '../../rest/poller.js';
import { StatsCollector } from '../../stats/collector.js';
import { formatSummary } from '../../stats/summary.js';
import { loadTemplate } from '../../requests/loader.js';
import { requestSchema, pollSchema } from '../../requests/schema.js';

export function requestFlags(command: Command): Command {
  return command.requiredOption('--profile <name>', 'TechUser profile').option('--method <method>', 'HTTP method')
    .option('--path <path>', 'Origin-relative path').option('--body <body>', 'Request body').option('--body-file <file>', 'Local body file')
    .option('--header <header>', 'Header: value (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--timeout <ms>', 'Request timeout in milliseconds', Number).option('--allow-prod-write', 'Permit writes to PROD')
    .option('--http-version <version>', 'HTTP protocol: auto, 1.1 or 2', parseHttpVersion)
    .option('--show-response', 'Print the HTTP response body to the terminal (subject to secret redaction)')
    .option('--export <format>', 'Export csv, summary or both', exportFormat).option('--output <path>', 'Export file (single format) or directory (both)');
}
export function pollFlags(command: Command): Command {
  return command.option('--interval <seconds>', 'Polling start interval in seconds', Number).option('--count <n>', 'Number of requests', Number).option('--duration <duration>', 'Duration, e.g. 2h');
}
export async function runRequest(program: Command, options: Record<string,unknown>, redactor: Redactor, polling: boolean, templatePath?: string) {
  const paths = configPaths(program.opts().configDir as string | undefined);
  const config = await loadConfig(paths.config); const profile = await loadProfile(paths.profiles, String(options.profile), redactor);
  const template = templatePath ? await loadTemplate(templatePath) : undefined;
  const headers: Record<string,string> = {};
  for (const value of options.header as string[] ?? []) {
    const index = value.indexOf(':'); if (index < 1) throw new Error('CONFIG_ERROR: Header must use Name: value');
    headers[value.slice(0,index).trim().toLowerCase()] = value.slice(index+1).trim();
  }
  const cli = { ...requestSchema.parse({ method: options.method, path: options.path, body: options.body, bodyFile: options.bodyFile, timeoutMs: options.timeout, headers }), httpVersion: options.httpVersion === undefined ? undefined : parseHttpVersion(String(options.httpVersion)) };
  // An explicit CLI body source overrides the template body source.
  const templateRequest = { ...template?.request };
  if (cli.body !== undefined || cli.bodyFile !== undefined) { delete templateRequest.body; delete templateRequest.bodyFile; }
  const request = resolveRequest(config, profile, templateRequest, cli);
  enforceProdSafety(profile, request.method, options.allowProdWrite === true);
  if (request.bodyFile) {
    try { request.body = await readFile(expandPath(request.bodyFile), 'utf8'); }
    catch { throw new Error('CONFIG_ERROR: Cannot read request body file'); }
  }
  const shouldPoll = polling || !!template?.poll;
  const pollOptions = pollSchema.parse({ ...template?.poll, ...Object.fromEntries(Object.entries({ intervalSeconds: options.interval, count: options.count, duration: options.duration }).filter(([,v]) => v !== undefined)) });
  if (options.count !== undefined) delete pollOptions.duration;
  if (options.duration !== undefined) delete pollOptions.count;
  if (shouldPoll && !['GET','HEAD','OPTIONS'].includes(request.method) && pollOptions.intervalSeconds === undefined) throw new Error('CONFIG_ERROR: Mutating polling requires an explicit interval');
  const duration = pollOptions.duration ? durationMs(pollOptions.duration) : undefined;
  if (shouldPoll && ((!pollOptions.count && !duration) || (pollOptions.count && duration))) throw new Error('CONFIG_ERROR: Polling requires count or duration, exclusively');
  const runId = randomUUID(); const startTime = new Date().toISOString();
  const exports = await RunExports.open(exportFormat(options.export), options.output as string | undefined, paths.logs, runId, redactor);
  let logger: Logger;
  try { logger = new Logger(redactor, await openLog(paths.logs, runId)); }
  catch (error) { await exports?.close(); throw error; }
  const stats = new StatsCollector(); const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const credential = restCredential(profile);
  const auth = credential.mode === 'oauth2' ? new OAuth2AuthProvider(credential, redactor) : new MtlsAuthProvider(credential, redactor);
  try {
    logger.console(`Profile: ${profile.name}\nEnvironment: ${profile.environment}\nRun ID: ${runId}\nLog: ${paths.logs}/${runId}.jsonl`);
    if (exports) logger.console(`Exports: ${exports.files.join(', ')}`);
    const task = async (sequenceNumber: number) => {
      let responseBody: string | undefined;
      let responseReceived = false;
      const timestamp = new Date().toISOString(); const result = await executeRequest(auth, request, controller.signal, template?.expect?.status, redactor, options.showResponse === true ? body => { responseReceived = true; responseBody = body; } : undefined);
      stats.add(result);
      if (result.protocolError) logger.error(result.protocolError);
      if (result.configurationError) logger.error(result.configurationError);
      // URL query values and request payloads are deliberately omitted from persisted diagnostics.
      const record = { transport: 'rest', timestamp, runId, sequenceNumber, profile: profile.name, environment: profile.environment, method: request.method, path: request.url.pathname, ...result };
      await logger.record(record);
      await exports?.record(record);
      if (options.showResponse === true) logger.console(`\n[${timestamp}] Request #${sequenceNumber}`);
      if (result.httpVersion) logger.console(`HTTP version: ${result.httpVersion}`);
      logger.console(`${timestamp} #${sequenceNumber} ${request.method} ${request.url.pathname} ${result.statusCode ?? result.errorType} ${result.durationMs.toFixed(2)} ms ${result.result}`);
      if (responseReceived) logger.console(responseBody === undefined ? 'Response: <unavailable: read failure or 1 MiB console limit>' : payloadOutput('Response', responseBody, redactor));
    };
    if (shouldPoll) await poll(task, { intervalMs: (pollOptions.intervalSeconds ?? config.poll.intervalSeconds)*1000, count: pollOptions.count, durationMs: duration, signal: controller.signal });
    else await task(1);
    const summary = stats.summary(); await logger.record({ runId, summary }); logger.console(formatSummary(summary));
    await exports?.summary({ runId, profile: profile.name, environment: profile.environment, startTime, endTime: new Date().toISOString() }, summary);
    if (controller.signal.aborted) process.exitCode = 130;
    else if (summary.successful < summary.requests) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); try { await logger.close(); } finally { await exports?.close(); } }
}
