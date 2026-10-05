import { z } from 'zod';
import { httpsUrl, headersSchema } from '../config/schema.js';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const oauth = z.object({ mode: z.literal('oauth2'), clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional(),
  clientIdEnv: envName.optional(), clientSecretEnv: envName.optional(),
  openIdConfigurationUrl: httpsUrl.optional(), tokenEndpoint: httpsUrl.optional(), scope: z.string().optional(),
  tokenAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic')
}).strict().refine(a =>
  (a.clientId !== undefined && a.clientSecret !== undefined && a.clientIdEnv === undefined && a.clientSecretEnv === undefined) ||
  (a.clientIdEnv !== undefined && a.clientSecretEnv !== undefined && a.clientId === undefined && a.clientSecret === undefined),
  'OAuth requires either clientId + clientSecret or clientIdEnv + clientSecretEnv; mixing is forbidden'
).refine(a => a.tokenEndpoint || a.openIdConfigurationUrl, 'OAuth requires a token endpoint or discovery URL');
const mtls = z.object({ mode: z.literal('mtls'), p12Path: z.string().min(1), p12PasswordEnv: envName }).strict();
export const profileSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), environment: z.enum(['IAT', 'PROD']),
  rest: z.object({ baseUrl: httpsUrl, timeoutMs: z.number().int().positive().optional(), headers: headersSchema.optional() }).strict(),
  auth: z.union([oauth, mtls])
}).strict();
export type Profile = z.infer<typeof profileSchema>;
