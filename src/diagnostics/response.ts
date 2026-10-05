import type { HttpResponse } from '../rest/client.js';
import { Redactor } from '../logging/redactor.js';

export const diagnosticHeaders = ['traceparent', 'tracestate', 'x-request-id', 'x-correlation-id', 'request-id', 'correlation-id', 'x-ms-request-id', 'x-ms-correlation-request-id', 'x-ms-client-request-id', 'x-azure-ref'] as const;
export interface ResponseBodyDiagnostic { type: 'json' | 'text' | 'empty' | 'binary'; value?: unknown; truncated: boolean }
export function responseDiagnostics(response: HttpResponse, redactor: Redactor) {
  const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const responseHeaders = Object.fromEntries(diagnosticHeaders.filter(key => headers[key] !== undefined).map(key => [key, headers[key]]));
  if (response.diagnosticReadFailed) return redactor.sanitize({ responseHeaders, responseBodyReadFailed: true });
  const truncated = response.bodyTruncated ?? false;
  const contentType = String(headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const textual = !contentType || contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('+json') || contentType === 'application/xml' || contentType.endsWith('+xml');
  let responseBody: ResponseBodyDiagnostic;
  if (!response.body && !truncated) responseBody = { type: 'empty', truncated };
  else if (!textual || /[\x00-\x08\x0e-\x1f\ufffd]/.test(response.body)) responseBody = { type: 'binary', truncated };
  else {
    // Incomplete JSON can split a secret/key. Omit its content rather than expose a partial credential.
    if (truncated) responseBody = { type: 'text', value: '[OMITTED: truncated response]', truncated };
    else {
      try { responseBody = { type: 'json', value: JSON.parse(response.body), truncated }; }
      catch { responseBody = { type: 'text', value: response.body, truncated }; }
    }
  }
  return redactor.sanitize({ responseHeaders, responseBody });
}
