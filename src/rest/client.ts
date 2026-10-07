import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import type { Readable } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';

export type HttpVersion = 'auto' | '1.1' | '2';
export function parseHttpVersion(value: string): HttpVersion {
  if (value === 'auto' || value === '1.1' || value === '2') return value;
  throw new Error('CONFIG_ERROR: HTTP version must be auto, 1.1 or 2');
}
const protocolError = (message: string) => Object.assign(new Error(message), { code: 'HTTP_PROTOCOL_ERROR' });
export interface HttpResponse { httpVersion?: string; status: number; headers: IncomingHttpHeaders; body: string; durationMs: number; bodyTruncated?: boolean; diagnosticReadFailed?: boolean; consoleBody?: string; consoleBodyUnavailable?: boolean }
export function send(url: URL, method: string, headers: Record<string,string>, body: string | undefined, timeoutMs: number, tls: ConnectionOptions = {}, signal?: AbortSignal, diagnosticBodyMaxBytes?: number, captureConsoleBody = false, httpVersion: HttpVersion = 'auto'): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let diagnosticFailure: (() => void) | undefined;
    let cleanup = () => {};
    let settled = false;
    const succeed = (value: HttpResponse) => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const collect = (response: Readable, status: number, responseHeaders: IncomingHttpHeaders, actualVersion: string) => {
      const consoleChunks: Buffer[] = []; let consoleSize = 0; let consoleTruncated = false;
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      const diagnostic = diagnosticBodyMaxBytes !== undefined && status >= 400 && status <= 599;
      const limit = diagnostic ? diagnosticBodyMaxBytes : 1024 * 1024;
      const finish = (failed = false) => succeed({ status, headers: responseHeaders, httpVersion: actualVersion, body: failed ? '' : Buffer.concat(chunks).toString('utf8'), durationMs: performance.now() - start, ...(captureConsoleBody ? { consoleBody: failed || consoleTruncated ? undefined : Buffer.concat(consoleChunks).toString('utf8'), consoleBodyUnavailable: failed || consoleTruncated } : {}), ...(diagnostic ? { bodyTruncated: truncated, diagnosticReadFailed: failed } : {}) });
      if (diagnostic) diagnosticFailure = () => finish(true);
      response.on('data', (chunk: Buffer) => {
        if (captureConsoleBody) {
          consoleSize += chunk.length;
          if (consoleSize > 1024 * 1024) { consoleTruncated = true; consoleChunks.length = 0; }
          else if (!consoleTruncated) consoleChunks.push(chunk);
        }
        if (diagnostic) {
          const remaining = Math.max(0, limit! - size);
          if (chunk.length > remaining) truncated = true;
          if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining))); size += Math.min(chunk.length, remaining);
          return;
        }
        size += chunk.length;
        if (size > 1024 * 1024) { const error = Object.assign(new Error('Response exceeds 1 MiB limit'), { code: 'RESPONSE_TOO_LARGE' }); response.destroy(error); }
        else chunks.push(chunk);
      });
      response.on('error', error => diagnostic ? finish(true) : fail(error));
      response.on('aborted', () => diagnostic ? finish(true) : fail(Object.assign(new Error('Response aborted'), { code: 'ECONNRESET' })));
      response.on('close', () => { if (!response.readableEnded) { if (diagnostic) finish(true); else fail(protocolError('Response closed before completion')); } });
      response.on('end', () => finish());
    };
    const onError = (error: Error) => diagnosticFailure ? diagnosticFailure() : fail(error);
    if (httpVersion !== '2') {
      const request = (url.protocol === 'https:' ? https : http).request(url, { ...tls, method, headers, signal, rejectUnauthorized: true }, response => collect(response, response.statusCode ?? 0, response.headers, response.httpVersion));
      const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      cleanup = () => { clearTimeout(timer); };
      request.on('close', () => clearTimeout(timer));
      request.on('error', onError);
      request.end(body);
      return;
    }
    if (url.protocol !== 'https:') { fail(protocolError('HTTP/2 mode currently requires HTTPS')); return; }
    if (signal?.aborted) { fail(Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' })); return; }
    let session: http2.ClientHttp2Session;
    try { session = http2.connect(url.origin, { ...tls, ALPNProtocols: ['h2'] }); }
    catch (error) { fail(error as Error); return; }
    let stream: http2.ClientHttp2Stream | undefined;
    const abort = () => onError(Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => onError(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); stream?.destroy(); session.destroy(); };
    signal?.addEventListener('abort', abort, { once: true });
    session.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code?.includes('NO_APPLICATION_PROTOCOL')) onError(protocolError('HTTP/2 requested but server did not negotiate h2'));
      else if (code === 'ECONNRESET' && !stream) onError(Object.assign(new Error('HTTP/2 connection reset before h2 could be established'), { code }));
      else onError(error);
    });
    session.on('goaway', () => { if (!settled) onError(protocolError('HTTP/2 session received GOAWAY before response completion')); });
    session.on('close', () => { if (!settled) onError(protocolError('HTTP/2 session closed before response completion')); });
    session.once('connect', () => {
      if (settled) return;
      if (session.alpnProtocol !== 'h2') { fail(protocolError('HTTP/2 requested but server did not negotiate h2')); return; }
      const forbidden = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'http2-settings']);
      for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'connection') for (const token of value.split(',')) forbidden.add(token.trim().toLowerCase());
      const outgoing: http2.OutgoingHttpHeaders = { ':method': method, ':path': url.pathname + url.search, ':scheme': 'https', ':authority': url.host };
      for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (key.startsWith(':') || key === 'host' || forbidden.has(key) || (key === 'te' && value.toLowerCase().trim() !== 'trailers')) continue;
        outgoing[key] = value;
      }
      try {
        stream = session.request(outgoing);
        stream.on('error', onError);
        stream.once('response', incoming => {
          const status = Number(incoming[':status']);
          if (!Number.isInteger(status) || status < 100 || status > 599) { fail(protocolError('Invalid HTTP/2 response status')); return; }
          const normalized = Object.fromEntries(Object.entries(incoming).filter(([key]) => !key.startsWith(':'))) as IncomingHttpHeaders;
          collect(stream!, status, normalized, '2');
        });
        stream.on('close', () => { if (!settled) onError(protocolError('HTTP/2 stream closed before response completion')); });
        stream.end(body);
      } catch (error) { fail(error as Error); }
    });
  });
}
