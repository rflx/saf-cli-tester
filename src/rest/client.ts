import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { ConnectionOptions } from 'node:tls';

export interface HttpResponse { status: number; headers: IncomingHttpHeaders; body: string; durationMs: number }
export function send(url: URL, method: string, headers: Record<string,string>, body: string | undefined, timeoutMs: number, tls: ConnectionOptions = {}, signal?: AbortSignal): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const request = (url.protocol === 'https:' ? https : http).request(url, { ...tls, method, headers, signal, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { const error = Object.assign(new Error('Response exceeds 1 MiB limit'), { code: 'RESPONSE_TOO_LARGE' }); response.destroy(error); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), durationMs: performance.now() - start }));
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}
