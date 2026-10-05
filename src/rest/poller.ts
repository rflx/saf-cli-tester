import { setTimeout as sleep } from 'node:timers/promises';
export function durationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error('CONFIG_ERROR: Duration must use ms, s, m or h');
  const result = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]!] ?? 0);
  if (!Number.isFinite(result) || result <= 0) throw new Error('CONFIG_ERROR: Duration must be positive');
  return result;
}
export async function poll(task: (sequence: number) => Promise<void>, options: { intervalMs: number; count?: number; durationMs?: number; signal?: AbortSignal }, clock = () => performance.now(), wait = (ms: number) => sleep(ms, undefined, { signal: options.signal })) {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || (options.count !== undefined && (!Number.isInteger(options.count) || options.count <= 0)) || (!options.count && !options.durationMs)) throw new Error('CONFIG_ERROR: Polling requires positive interval and count or duration');
  if (options.count && options.durationMs) throw new Error('CONFIG_ERROR: Choose count or duration');
  const start = clock(); let sequence = 0;
  while (!options.signal?.aborted && (options.count === undefined || sequence < options.count) && (options.durationMs === undefined || clock() - start < options.durationMs)) {
    const requestStart = clock(); await task(++sequence);
    if (options.signal?.aborted || sequence === options.count) break;
    const delay = Math.max(0, options.intervalMs - (clock() - requestStart));
    if (options.durationMs !== undefined && clock() - start + delay >= options.durationMs) break;
    try { await wait(delay); } catch (error) { if (!options.signal?.aborted) throw error; }
  }
}
