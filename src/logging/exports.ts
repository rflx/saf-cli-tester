import { mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expandPath } from '../config/paths.js';
import type { StatsCollector } from '../stats/collector.js';
import type { Redactor } from './redactor.js';

export const csvFields = ['timestamp', 'runId', 'sequenceNumber', 'profile', 'environment', 'method', 'path', 'statusCode', 'durationMs', 'result', 'errorType', 'requestId', 'correlationId'] as const;
export type ExportFormat = 'csv' | 'summary' | 'both';
export function exportFormat(value: unknown): ExportFormat | undefined {
  if (value === undefined) return undefined;
  if (value === 'csv' || value === 'summary' || value === 'both') return value;
  throw new Error('CONFIG_ERROR: Export must be csv, summary or both');
}

// Resolve existing ancestors to catch config paths routed into a checkout by symlinks.
async function outsideRepository(directory: string) {
  let current = directory;
  while (true) {
    try { current = await realpath(current); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  while (true) {
    try { await stat(join(current, '.git')); throw new Error('CONFIG_ERROR: Default exports must be outside Git repositories; choose an explicit --output'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function cell(value: unknown): string {
  let text = value === undefined || value === null ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value);
  // Prevent spreadsheet formulas in untrusted identifiers and names.
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
export class RunExports {
  private csv?: FileHandle;
  private summaryFile?: FileHandle;
  readonly files: string[] = [];
  private constructor(private readonly redactor: Redactor, private readonly fields: readonly string[]) {}
  static async open(format: ExportFormat | undefined, output: string | undefined, logs: string, runId: string, redactor: Redactor, fields: readonly string[] = csvFields) {
    if (!format) {
      if (output !== undefined) throw new Error('CONFIG_ERROR: --output requires --export');
      return undefined;
    }
    if (output === undefined) await outsideRepository(logs);
    const exports = new RunExports(redactor, fields);
    const directory = output === undefined ? logs : expandPath(output);
    try {
      for (const kind of ['csv', 'summary'] as const) {
        if (format !== 'both' && format !== kind) continue;
        const file = output !== undefined && format !== 'both' ? directory : join(directory, `${runId}.${kind === 'csv' ? 'csv' : 'summary.json'}`);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(file, 'wx', 0o600);
        exports.files.push(file);
        if (kind === 'csv') { exports.csv = handle; await handle.write(fields.join(',') + '\r\n'); }
        else exports.summaryFile = handle;
      }
      return exports;
    } catch (error) { await exports.close(); throw error; }
  }
  async record(record: Record<string, unknown>) {
    if (!this.csv) return;
    const selected = Object.fromEntries(this.fields.map(key => [key, record[key]]));
    const safe = this.redactor.sanitize({ ...selected, ...(record.transport === 'kafka' ? { transport: 'kafka' } : {}) }) as Record<string, unknown>;
    await this.csv.write(this.fields.map(key => cell(safe[key])).join(',') + '\r\n');
  }
  async summary(metadata: { runId: string; profile: string; environment: string; startTime: string; endTime: string }, stats: ReturnType<StatsCollector['summary']> | Record<string, unknown>) {
    await this.summaryFile?.write(JSON.stringify(this.redactor.sanitize({ ...metadata, ...stats }), null, 2) + '\n');
  }
  async close() { try { await this.csv?.close(); } finally { await this.summaryFile?.close(); } }
}
