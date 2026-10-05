import { z } from 'zod';

export const httpsUrl = z.string().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
}, 'Expected HTTPS URL without credentials or fragment');
export const headersSchema = z.record(z.string(), z.string());
export const configSchema = z.object({
  rest: z.object({ diagnosticBodyMaxBytes: z.number().int().min(0).max(1024 * 1024).default(64 * 1024), timeoutMs: z.number().int().positive().default(30000), headers: headersSchema.default({}) }).strict().default({ diagnosticBodyMaxBytes: 64 * 1024, timeoutMs: 30000, headers: {} }),
  poll: z.object({ intervalSeconds: z.number().positive().default(60) }).strict().default({ intervalSeconds: 60 })
}).strict();
