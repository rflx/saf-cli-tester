import type { IncomingHttpHeaders } from 'node:http';
export function correlation(headers: IncomingHttpHeaders) {
  return { requestId: headers['x-request-id'], correlationId: headers['x-correlation-id'] ?? headers['correlation-id'] };
}
