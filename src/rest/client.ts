import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { ConnectionOptions } from 'node:tls';

export interface HttpResponse { status: number; headers: IncomingHttpHeaders; body: string; durationMs: number; bodyTruncated?: boolean; diagnosticReadFailed?: boolean }
export function send(url: URL, method: string, headers: Record<string,string>, body: string | undefined, timeoutMs: number, tls: ConnectionOptions = {}, signal?: AbortSignal, diagnosticBodyMaxBytes?: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let diagnosticFailure: (() => void) | undefined;
    const request = (url.protocol === 'https:' ? https : http).request(url, { ...tls, method, headers, signal, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      const diagnostic = diagnosticBodyMaxBytes !== undefined && (response.statusCode ?? 0) >= 400 && (response.statusCode ?? 0) <= 599;
      const limit = diagnostic ? diagnosticBodyMaxBytes : 1024 * 1024;
      const finish = (failed = false) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: failed ? '' : Buffer.concat(chunks).toString('utf8'), durationMs: performance.now() - start, ...(diagnostic ? { bodyTruncated: truncated, diagnosticReadFailed: failed } : {}) });
      if (diagnostic) diagnosticFailure = () => finish(true);
      response.on('data', (chunk: Buffer) => {
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
      response.on('error', error => diagnostic ? finish(true) : reject(error));
      response.on('aborted', () => { if (diagnostic) finish(true); });
      response.on('end', () => finish());
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => diagnosticFailure ? diagnosticFailure() : reject(error));
    request.end(body);
  });
}
