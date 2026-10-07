import { OAuth2AuthError, type OAuth2Diagnostics } from '../auth/oauth2.js';
import type { Profile } from '../profiles/types.js';
import type { AppConfig } from '../config/types.js';
import type { RequestOptions } from '../requests/schema.js';
import type { AuthProvider } from '../auth/types.js';
import { send, parseHttpVersion } from './client.js';
import { classifyError, classifyStatus } from '../diagnostics/errors.js';
import { Redactor } from '../logging/redactor.js';
import { responseDiagnostics, type ResponseBodyDiagnostic } from '../diagnostics/response.js';
import { correlation } from '../diagnostics/correlation.js';
import { preparePlaceholders, templateBody } from '../requests/placeholders.js';
import { validateHeaderValue } from 'node:http';

export function resolveRequest(config: AppConfig, profile: Profile, template: RequestOptions = {}, cli: RequestOptions = {}) {
  if (!profile.rest) throw new Error('CONFIG_ERROR: Profile has no REST transport; configure rest.baseUrl and rest.auth');
  const defined = Object.fromEntries(Object.entries(cli).filter(([,v]) => v !== undefined));
  const headers: Record<string,string> = {};
  for (const layer of [config.rest.headers, profile.rest.headers, template.headers, cli.headers]) {
    for (const [key,value] of Object.entries(layer ?? {})) headers[key.toLowerCase()] = value;
  }
  const options = { method: 'GET', ...config.rest, ...profile.rest, ...template, ...defined, headers };
  if ([options.path, options.bodyFile, ...Object.keys(headers)].some(value => value?.includes('{{') || value?.includes('}}'))) throw new Error('CONFIG_ERROR: Placeholders are only supported in request body and header values');
  if (!options.path || !options.path.startsWith('/') || options.path.startsWith('//')) throw new Error('CONFIG_ERROR: Request path must start with a single /');
  const base = new URL(profile.rest.baseUrl); const url = new URL(options.path, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error('CONFIG_ERROR: Request must stay on the profile origin without a fragment');
  for (const key of Object.keys(options.headers)) {
    if (/^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection)$/i.test(key)) throw new Error('CONFIG_ERROR: Reserved request header');
  }
  if (options.body !== undefined && options.bodyFile !== undefined) throw new Error('CONFIG_ERROR: Choose body or body-file');
  if (['GET','HEAD'].includes(options.method) && (options.body !== undefined || options.bodyFile)) throw new Error('CONFIG_ERROR: GET/HEAD cannot have a body');
  return { ...options, httpVersion: parseHttpVersion(cli.httpVersion ?? 'auto'), profile, url, timeoutMs: options.timeoutMs ?? 30000 };
}
export function enforceProdSafety(profile: Profile, method: string, allowed: boolean) {
  if (profile.environment === 'PROD' && !['GET','HEAD','OPTIONS'].includes(method) && !allowed) throw new Error('CONFIG_ERROR: PROD writes require --allow-prod-write');
}
export interface RequestResult {
  statusCode?: number;
  httpVersion?: string;
  protocolError?: string;
  durationMs: number;
  requestId?: string | string[];
  correlationId?: string | string[];
  result: string;
  errorType?: string;
  networkErrorCode?: string;
  oauth2?: OAuth2Diagnostics;
  responseBody?: ResponseBodyDiagnostic;
  responseHeaders?: Record<string, string | string[]>;
  responseBodyReadFailed?: boolean;
  responseDiagnosticsFailed?: boolean;
  configurationError?: string;
}
export async function executeRequest(auth: AuthProvider, request: ReturnType<typeof resolveRequest>, signal?: AbortSignal, expected?: number[], redactor = new Redactor(), consoleResponse?: (body: string | undefined) => void): Promise<RequestResult> {
  const started = performance.now();
  try {
    const parsedBody = templateBody(request.body);
    const jsonText = typeof request.body === 'string' && parsedBody !== request.body;
    const resolve = preparePlaceholders({ headers: request.headers, body: parsedBody }, redactor, request.profile);
    const prepared = await auth.prepareRequest({ timeoutMs: request.timeoutMs, signal });
    const runtime = resolve() as { headers: Record<string, string>; body: unknown };
    for (const [name, value] of Object.entries(runtime.headers)) {
      try { validateHeaderValue(name, value); }
      catch { throw new Error('CONFIG_ERROR: Invalid resolved request header value'); }
    }
    const body = runtime.body === undefined ? undefined
      : jsonText ? JSON.stringify(runtime.body) === JSON.stringify(parsedBody) ? request.body as string : JSON.stringify(runtime.body)
      : typeof runtime.body === 'string' ? runtime.body : JSON.stringify(runtime.body);
    const response = await send(request.url, request.method, { ...runtime.headers, ...prepared.headers }, body, request.timeoutMs, prepared.tls, signal, request.diagnosticBodyMaxBytes, consoleResponse !== undefined, request.httpVersion);
    if (consoleResponse) consoleResponse(response.consoleBodyUnavailable ? undefined : response.consoleBody);
    const errorType = classifyStatus(response.status) ?? (expected && !expected.includes(response.status) ? 'UNEXPECTED_STATUS' : undefined);
    let diagnostics = {};
    if (response.status >= 400 && response.status <= 599) {
      try { diagnostics = responseDiagnostics(response, redactor) as object; }
      catch { diagnostics = { responseDiagnosticsFailed: true }; }
    }
    return { httpVersion: response.httpVersion, statusCode: response.status, durationMs: response.durationMs, ...correlation(response.headers), ...diagnostics, result: errorType ? 'failure' : 'success', errorType };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('CONFIG_ERROR')) return { durationMs: performance.now() - started, result: 'failure', errorType: 'CONFIG_ERROR', configurationError: redactor.text(message) };
    return { durationMs: performance.now() - started, result: 'failure', errorType: message.startsWith('AUTH_ERROR') ? 'AUTH_ERROR' : message.startsWith('CONFIG_ERROR') ? 'CONFIG_ERROR' : classifyError(error), networkErrorCode: (error as NodeJS.ErrnoException).code, ...((error as NodeJS.ErrnoException).code === 'HTTP_PROTOCOL_ERROR' ? { protocolError: redactor.text(message) } : {}), ...(error instanceof OAuth2AuthError && error.diagnostics ? { oauth2: error.diagnostics } : {}) };
  }
}
