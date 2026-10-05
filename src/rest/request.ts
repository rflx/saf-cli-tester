import { OAuth2AuthError, type OAuth2Diagnostics } from '../auth/oauth2.js';
import type { Profile } from '../profiles/types.js';
import type { AppConfig } from '../config/types.js';
import type { RequestOptions } from '../requests/schema.js';
import type { AuthProvider } from '../auth/types.js';
import { send } from './client.js';
import { classifyError, classifyStatus } from '../diagnostics/errors.js';
import { correlation } from '../diagnostics/correlation.js';

export function resolveRequest(config: AppConfig, profile: Profile, template: RequestOptions = {}, cli: RequestOptions = {}) {
  const defined = Object.fromEntries(Object.entries(cli).filter(([,v]) => v !== undefined));
  const headers: Record<string,string> = {};
  for (const layer of [config.rest.headers, profile.rest.headers, template.headers, cli.headers]) {
    for (const [key,value] of Object.entries(layer ?? {})) headers[key.toLowerCase()] = value;
  }
  const options = { method: 'GET', ...config.rest, ...profile.rest, ...template, ...defined, headers };
  if (!options.path || !options.path.startsWith('/') || options.path.startsWith('//')) throw new Error('CONFIG_ERROR: Request path must start with a single /');
  const base = new URL(profile.rest.baseUrl); const url = new URL(options.path, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error('CONFIG_ERROR: Request must stay on the profile origin without a fragment');
  for (const key of Object.keys(options.headers)) {
    if (/^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection)$/i.test(key)) throw new Error('CONFIG_ERROR: Reserved request header');
  }
  if (options.body !== undefined && options.bodyFile !== undefined) throw new Error('CONFIG_ERROR: Choose body or body-file');
  if (['GET','HEAD'].includes(options.method) && (options.body !== undefined || options.bodyFile)) throw new Error('CONFIG_ERROR: GET/HEAD cannot have a body');
  return { ...options, url, timeoutMs: options.timeoutMs ?? 30000 };
}
export function enforceProdSafety(profile: Profile, method: string, allowed: boolean) {
  if (profile.environment === 'PROD' && !['GET','HEAD','OPTIONS'].includes(method) && !allowed) throw new Error('CONFIG_ERROR: PROD writes require --allow-prod-write');
}
export interface RequestResult {
  statusCode?: number;
  durationMs: number;
  requestId?: string | string[];
  correlationId?: string | string[];
  result: string;
  errorType?: string;
  networkErrorCode?: string;
  oauth2?: OAuth2Diagnostics;
}
export async function executeRequest(auth: AuthProvider, request: ReturnType<typeof resolveRequest>, signal?: AbortSignal, expected?: number[]): Promise<RequestResult> {
  const started = performance.now();
  try {
    const prepared = await auth.prepareRequest({ timeoutMs: request.timeoutMs, signal });
    const response = await send(request.url, request.method, { ...request.headers, ...prepared.headers }, request.body, request.timeoutMs, prepared.tls, signal);
    const errorType = classifyStatus(response.status) ?? (expected && !expected.includes(response.status) ? 'UNEXPECTED_STATUS' : undefined);
    // Only explicitly selected diagnostics are retained; payloads and arbitrary headers may contain customer data.
    return { statusCode: response.status, durationMs: response.durationMs, ...correlation(response.headers), result: errorType ? 'failure' : 'success', errorType };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { durationMs: performance.now() - started, result: 'failure', errorType: message.startsWith('AUTH_ERROR') ? 'AUTH_ERROR' : message.startsWith('CONFIG_ERROR') ? 'CONFIG_ERROR' : classifyError(error), networkErrorCode: (error as NodeJS.ErrnoException).code, ...(error instanceof OAuth2AuthError && error.diagnostics ? { oauth2: error.diagnostics } : {}) };
  }
}
