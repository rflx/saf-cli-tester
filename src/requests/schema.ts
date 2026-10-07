import { z } from 'zod';
import { headersSchema } from '../config/schema.js';
export const requestSchema = z.object({ method: z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']).optional(), path: z.string().min(1).optional(), headers: headersSchema.optional(), body: z.json().optional(), bodyFile: z.string().optional(), timeoutMs: z.number().int().positive().optional() }).strict();
export const pollSchema = z.object({ intervalSeconds: z.number().positive().optional(), count: z.number().int().positive().optional(), duration: z.string().optional() }).strict();
export const templateSchema = z.object({ name: z.string().optional(), request: requestSchema, poll: pollSchema.optional(), expect: z.object({ status: z.array(z.number().int().min(100).max(599)).min(1) }).strict().optional() }).strict();
export type RequestOptions = z.infer<typeof requestSchema> & { httpVersion?: import('../rest/client.js').HttpVersion };
export type PollOptions = z.infer<typeof pollSchema>;
