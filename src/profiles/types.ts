import { z } from 'zod';
import { httpsUrl, headersSchema } from '../config/schema.js';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const shared = z.object({
  licenceKey: z.string().refine(v => v.trim().length > 0).optional(), password: z.string().refine(v => v.trim().length > 0).optional(),
  licenceKeyEnv: envName.optional(), passwordEnv: envName.optional()
}).strict().refine(a =>
  (a.licenceKey !== undefined && a.password !== undefined && a.licenceKeyEnv === undefined && a.passwordEnv === undefined) ||
  (a.licenceKeyEnv !== undefined && a.passwordEnv !== undefined && a.licenceKey === undefined && a.password === undefined),
  'Shared credentials require licenceKey + password or licenceKeyEnv + passwordEnv; mixing is forbidden'
);
export type SharedCredential = z.infer<typeof shared>;
const oauthFields = { clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional(),
  clientIdEnv: envName.optional(), clientSecretEnv: envName.optional(),
  openIdConfigurationUrl: httpsUrl.optional(), tokenEndpoint: httpsUrl.optional(), scope: z.string().refine(value => value.trim().length > 0, 'OAuth scope must be nonempty').optional(),
  tokenAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic')
};
const oauth = z.object(oauthFields).strict().refine(a =>
  (a.clientId !== undefined && a.clientSecret !== undefined && a.clientIdEnv === undefined && a.clientSecretEnv === undefined) ||
  (a.clientIdEnv !== undefined && a.clientSecretEnv !== undefined && a.clientId === undefined && a.clientSecret === undefined),
  'OAuth requires either clientId + clientSecret or clientIdEnv + clientSecretEnv; mixing is forbidden'
).refine(a => a.tokenEndpoint || a.openIdConfigurationUrl, 'OAuth requires a token endpoint or discovery URL');
const mtls = z.object({ p12Path: z.string().min(1), p12Password: z.string().optional(), p12PasswordEnv: envName.optional() }).strict().refine(
  a => (a.p12Password !== undefined) !== (a.p12PasswordEnv !== undefined),
  'mTLS requires exactly one of p12Password or p12PasswordEnv'
);
export type OAuth2Credential = z.infer<typeof oauth>;
export type MtlsCredential = z.infer<typeof mtls>;
const restAuth = z.object({ mode: z.enum(['oauth2', 'mtls']), credential: z.string().min(1) }).strict();
const kafkaAuth = z.object({ mode: z.literal('mtls'), credential: z.string().min(1) }).strict();
const rest = z.object({ baseUrl: httpsUrl, timeoutMs: z.number().int().positive().optional(), headers: headersSchema.optional(), auth: restAuth }).strict();
const current = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), environment: z.enum(['IAT', 'PROD']),
  credentials: z.object({ shared: shared.optional(), oauth2: oauth.optional(), mtls: mtls.optional() }).strict(),
  rest: rest.optional(),
  kafka: z.object({ brokers: z.array(z.string().regex(/^[^\s/:]+:\d+$/, 'Broker must be host:port').refine(value => { const port = Number(value.split(':').at(-1)); return port > 0 && port <= 65535; }, 'Broker port must be 1–65535')).min(1), auth: kafkaAuth }).strict().optional()
}).strict().superRefine((p, ctx) => {
  if (!p.rest && !p.kafka) ctx.addIssue({ code: 'custom', message: 'Configure at least one transport: rest or kafka' });
  for (const transport of ['rest', 'kafka'] as const) {
    const auth = p[transport]?.auth;
    if (auth && (auth.credential !== auth.mode || !p.credentials[auth.mode])) ctx.addIssue({ code: 'custom', path: [transport, 'auth', 'credential'], message: `${transport}.auth.credential must reference configured credentials.${auth.mode}` });
  }
});
// Legacy top-level auth is accepted only when no new credentials/auth are present.
export const profileSchema = z.preprocess((input, ctx) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const p = input as Record<string, unknown>;
  if (p.auth === undefined) return input;
  const r = p.rest as Record<string, unknown> | undefined;
  if (p.credentials !== undefined || r?.auth !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Ambiguous legacy auth and new credentials/rest.auth; remove top-level auth and migrate to credentials + rest.auth' });
    return z.NEVER;
  }
  if (!p.auth || typeof p.auth !== 'object' || Array.isArray(p.auth)) return input;
  const { mode, ...credential } = p.auth as Record<string, unknown>;
  if (mode !== 'oauth2' && mode !== 'mtls') return input;
  const { auth: _legacy, ...identity } = p;
  return { ...identity, credentials: { [mode]: credential }, rest: r ? { ...r, auth: { mode, credential: mode } } : undefined };
}, current);
export type Profile = z.infer<typeof profileSchema>;
export function restCredential(profile: Profile) {
  if (!profile.rest) throw new Error('CONFIG_ERROR: Profile has no REST transport; configure rest.baseUrl and rest.auth');
  const mode = profile.rest.auth.mode;
  if (mode === 'oauth2') return { mode, ...profile.credentials.oauth2! };
  return { mode, ...profile.credentials.mtls! };
}
