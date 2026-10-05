import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config/schema.js';
import { profileSchema } from '../src/profiles/types.js';
import { executeRequest, resolveRequest } from '../src/rest/request.js';
import { responseDiagnostics, diagnosticHeaders } from '../src/diagnostics/response.js';
import { Redactor } from '../src/logging/redactor.js';
import { Logger } from '../src/logging/logger.js';
import { openLog } from '../src/logging/jsonl.js';

const profile = profileSchema.parse({ name: 'test', environment: 'IAT', rest: { baseUrl: 'https://example.invalid' }, auth: { mode: 'oauth2', clientId: 'dummy', clientSecret: 'dummy', tokenEndpoint: 'https://example.invalid/token' } });
const auth = { prepareRequest: async () => ({ headers: {} }) };

test('HTTP failure diagnostics and unchanged success behavior reach sanitized JSONL', async () => {
  const server = createServer((req, res) => {
    const route = req.url!;
    res.statusCode = route === '/400' ? 400 : route === '/200' ? 200 : 500;
    res.setHeader('X-Request-ID', 'request-123');
    res.setHeader('Set-Cookie', 'session=hidden');
    res.setHeader('Authorization', 'Bearer hidden');
    res.setHeader('Content-Type', route === '/text' ? 'text/plain' : route === '/binary' ? 'application/octet-stream' : 'application/json');
    if (route === '/timeout') { res.write('{'); return; }
    if (route === '/broken') { res.write('{'); setImmediate(() => res.destroy()); return; }
    if (route === '/empty') res.end();
    else if (route === '/text') res.end('Internal Server Error Bearer text-token password=text-secret');
    else if (route === '/malformed') res.end('{"password":"malformed-secret", broken');
    else if (route === '/large') res.end('x'.repeat(2 * 1024 * 1024));
    else if (route === '/binary') res.end(Buffer.from([0, 1, 2]));
    else res.end(JSON.stringify({ title: 'Internal Server Error', status: res.statusCode, access_token: 'body-secret', note: 'registered-secret' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = await mkdtemp(join(tmpdir(), 'saf-diagnostics-'));
  const redactor = new Redactor(); redactor.add('registered-secret');
  const logger = new Logger(redactor, await openLog(dir, 'test'));
  try {
    for (const route of ['400', '500', 'text', 'empty', 'malformed', 'large', 'binary', '200', 'broken', 'timeout']) {
      const request = { ...resolveRequest(configSchema.parse({ rest: { diagnosticBodyMaxBytes: 256, timeoutMs: 200 } }), profile, { path: '/' + route }), url: new URL(`http://127.0.0.1:${address.port}/${route}`) };
      const result = await executeRequest(auth, request, undefined, undefined, redactor);
      assert.equal(result.statusCode, route === '400' ? 400 : route === '200' ? 200 : 500);
      if (route === '200') { assert.equal(result.result, 'success'); assert.equal(result.responseBody, undefined); assert.equal(result.responseHeaders, undefined); }
      else {
        assert.equal(result.errorType, 'HTTP_' + result.statusCode);
        assert.deepEqual(result.responseHeaders, { 'x-request-id': 'request-123' });
        if ((route === 'broken' || route === 'timeout')) assert.equal(result.responseBodyReadFailed, true);
        else if (route === 'empty') assert.deepEqual(result.responseBody, { type: 'empty', truncated: false });
        else if (route === 'binary') assert.deepEqual(result.responseBody, { type: 'binary', truncated: false });
        else if (route === 'large') { assert.equal(result.responseBody?.truncated, true); assert.ok(JSON.stringify(result).length < 1024); }
        else if (route === 'text' || route === 'malformed') assert.equal(result.responseBody?.type, 'text');
        else { assert.equal(result.responseBody?.type, 'json'); assert.deepEqual(result.responseBody?.value, { title: 'Internal Server Error', status: result.statusCode, access_token: '[REDACTED]', note: '[REDACTED]' }); }
      }
      await logger.record(result);
    }
    await logger.close();
    const log = await readFile(join(dir, 'test.jsonl'), 'utf8');
    for (const secret of ['body-secret', 'registered-secret', 'text-token', 'text-secret', 'malformed-secret', 'session=hidden', 'Bearer hidden']) assert.ok(!log.includes(secret), secret);
    assert.equal(log.trim().split('\n').length, 10);
  } finally { await logger.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('allowlisted response headers are case insensitive and sanitized', () => {
  const headers = Object.fromEntries(diagnosticHeaders.map(key => [key.toUpperCase(), 'Bearer hidden']));
  const result = responseDiagnostics({ status: 500, durationMs: 1, body: '', headers: { ...headers, 'Set-Cookie': 'hidden', Cookie: 'hidden', Authorization: 'hidden', 'Proxy-Authorization': 'hidden', 'x-secret': 'hidden' } }, new Redactor()) as { responseHeaders: Record<string, string> };
  assert.deepEqual(Object.keys(result.responseHeaders), [...diagnosticHeaders]);
  assert.ok(Object.values(result.responseHeaders).every(value => value === 'Bearer [REDACTED]'));
});

test('diagnostic sanitization failures retain original HTTP classification', async () => {
  const server = createServer((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"title":"failure"}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  class FailingRedactor extends Redactor { override sanitize(): unknown { throw new Error('diagnostic failure'); } }
  try {
    const request = { ...resolveRequest(configSchema.parse({}), profile, { path: '/' }), url: new URL(`http://127.0.0.1:${address.port}/`) };
    const result = await executeRequest(auth, request, undefined, undefined, new FailingRedactor());
    assert.equal(result.statusCode, 500); assert.equal(result.errorType, 'HTTP_500'); assert.equal(result.responseDiagnosticsFailed, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('central text redaction handles incomplete PEM and malformed credential fields', () => {
  const redactor = new Redactor();
  for (const source of ['-----BEGIN PRIVATE KEY-----\nsecret', '{"access_token":"secret', 'token=secret', 'certificate: secret']) assert.ok(!redactor.text(source).includes('secret'));
});

test('diagnostic size defaults and validation', () => {
  assert.equal(configSchema.parse({}).rest.diagnosticBodyMaxBytes, 65536);
  for (const value of [-1, 1.5, 1048577]) assert.equal(configSchema.safeParse({ rest: { diagnosticBodyMaxBytes: value } }).success, false);
});
