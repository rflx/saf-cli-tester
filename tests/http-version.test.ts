import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Command } from 'commander';
import { send, parseHttpVersion } from '../src/rest/client.js';
import { requestFlags, pollFlags } from '../src/cli/commands/rest-request.js';
import { classifyError } from '../src/diagnostics/errors.js';
import { poll } from '../src/rest/poller.js';
import { executeRequest, resolveRequest } from '../src/rest/request.js';
import { configSchema } from '../src/config/schema.js';
import { profileSchema } from '../src/profiles/types.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { OAuth2AuthProvider } from '../src/auth/oauth2.js';
import { Redactor } from '../src/logging/redactor.js';
import { payloadOutput } from '../src/logging/payload.js';

const run = promisify(execFile);
const profile = profileSchema.parse({ name: 'test', environment: 'IAT', rest: { baseUrl: 'https://localhost' }, auth: { mode: 'oauth2', clientId: 'test', clientSecret: 'secret', tokenEndpoint: 'https://example.invalid/token' } });
async function listen(server: http.Server | http2.Http2SecureServer) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return address.port;
}

test('strict protocol CLI parsing shared by request, poll and run', () => {
  for (const name of ['request', 'poll', 'run']) for (const value of ['auto', '1.1', '2']) {
    const command = pollFlags(requestFlags(new Command(name))).exitOverride();
    command.parse(['--profile', 'test', '--http-version', value], { from: 'user' });
    assert.equal(command.opts().httpVersion, value);
  }
  for (const value of ['1', '2.0', 'h2', 'http2', 'http/1.1', '']) {
    assert.throws(() => parseHttpVersion(value), /CONFIG_ERROR/);
    assert.throws(() => requestFlags(new Command()).exitOverride().parse(['--profile', 'test', '--http-version', value], { from: 'user' }), /HTTP version/);
  }
  assert.equal(resolveRequest(configSchema.parse({}), profile, { path: '/' }).httpVersion, 'auto');
});

test('HTTP/1.1 and auto preserve GET, POST bytes, headers, console capture, timeouts and sequential polling', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/wait') return;
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.setHeader('x-test', 'yes'); res.end(body || 'plain'); });
  });
  const port = await listen(server);
  try {
    for (const version of ['auto', '1.1'] as const) {
      const url = new URL(`http://127.0.0.1:${port}/`);
      const response = await send(url, 'GET', {}, undefined, 1000, {}, undefined, undefined, true, version);
      assert.equal(response.httpVersion, '1.1'); assert.equal(response.headers['x-test'], 'yes'); assert.equal(response.consoleBody, 'plain');
      const body = '{"unicode":"ä"}';
      assert.equal((await send(url, 'POST', { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body, 1000, {}, undefined, undefined, true, version)).body, body);
      await assert.rejects(send(new URL('/wait', url), 'GET', {}, undefined, 30, {}, undefined, undefined, false, version), error => classifyError(error) === 'TIMEOUT');
      const versions: string[] = []; let active = 0;
      await poll(async () => { assert.equal(active++, 0); versions.push((await send(url, 'GET', {}, undefined, 1000, {}, undefined, undefined, false, version)).httpVersion!); active--; }, { intervalMs: 1, count: 3 });
      assert.deepEqual(versions, ['1.1', '1.1', '1.1']);
    }
    await assert.rejects(send(new URL(`http://127.0.0.1:${port}/`), 'GET', {}, undefined, 1000, {}, undefined, undefined, false, '2'), /requires HTTPS/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('secure HTTP/2: auth, bodies, header filtering, diagnostics, ALPN, cancellation and session cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-http2-'));
  let server: http2.Http2SecureServer | undefined;
  let fallback: https.Server | undefined;
  const sessions = new Set<http2.ServerHttp2Session>();
  try {
    // Only temporary test credentials; OpenSSL is also used by the project's certificate tests.
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const key = await readFile(join(dir, 'key')), cert = await readFile(join(dir, 'cert'));
    await run('openssl', ['pkcs12', '-export', '-inkey', join(dir, 'key'), '-in', join(dir, 'cert'), '-out', join(dir, 'test.p12'), '-passout', 'pass:test-password']);
    server = http2.createSecureServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: false });
    server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); session.on('error', () => {}); });
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      const path = headers[':path'];
      if (path === '/wait') return;
      if (path === '/reset') { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); return; }
      if (path === '/goaway') { stream.session!.goaway(http2.constants.NGHTTP2_INTERNAL_ERROR); return; }
      let body = ''; stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        if (stream.destroyed) return;
        stream.respond({ ':status': path === '/failure' ? 500 : 200, 'content-type': 'application/json', 'x-request-id': 'h2-id' });
        stream.end(path === '/empty' ? '' : path === '/text' ? 'plain response' : JSON.stringify({ body, headers, authorized: (stream.session!.socket as import('node:tls').TLSSocket).authorized }));
      });
    });
    const port = await listen(server), url = new URL(`https://localhost:${port}/`), tls = { ca: cert, servername: 'localhost' };
    await mkdir(join(dir, 'profiles'));
    await writeFile(join(dir, 'profiles', 'test.yaml'), JSON.stringify({ name: 'test', environment: 'IAT', rest: { baseUrl: url.origin, auth: { mode: 'mtls', credential: 'mtls' } }, credentials: { mtls: { p12Path: join(dir, 'test.p12'), p12Password: 'test-password' } } }));
    await writeFile(join(dir, 'template.yaml'), JSON.stringify({ request: { path: '/text' } }));
    const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
    for (const args of [
      ['rest', 'request', '--path', '/text'],
      ['rest', 'poll', '--path', '/text', '--interval', '0.001', '--count', '2'],
      ['run', '--request', join(dir, 'template.yaml')]
    ]) {
      const output = await run(process.execPath, [cli, '--config-dir', dir, ...args, '--profile', 'test', '--http-version', '2', '--show-response'], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, 'cert') }, timeout: 10000 });
      assert.match(output.stdout, /HTTP version: 2/);
      assert.match(output.stdout, /Response:\nplain response/);
      assert.ok(!output.stdout.includes('test-password'));
      const match = /Run ID: ([^\n]+)/.exec(output.stdout); assert.ok(match);
      const events = (await readFile(join(dir, 'logs', match[1]! + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const records = events.filter(event => event.transport === 'rest');
      assert.equal(records.length, args[1] === 'poll' ? 2 : 1);
      assert.ok(records.every(record => record.httpVersion === '2'));
    }
    const redactor = new Redactor();
    const mtls = new MtlsAuthProvider({ p12Path: join(dir, 'test.p12'), p12Password: 'test-password' }, redactor);
    const credentials = await mtls.prepareRequest();
    for (const version of ['1.1', '2'] as const) {
      if (version === '1.1') {
        const mtlsServer = https.createServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: true }, (req, res) => res.end(String((req.socket as import('node:tls').TLSSocket).authorized)));
        const p = await listen(mtlsServer);
        try { assert.equal((await send(new URL(`https://localhost:${p}/`), 'GET', {}, undefined, 1000, { ...tls, ...credentials.tls }, undefined, undefined, false, version)).body, 'true'); }
        finally { mtlsServer.closeAllConnections(); await new Promise<void>(resolve => mtlsServer.close(() => resolve())); }
      } else {
        const response = await send(url, 'POST', { Connection: 'x-hop', 'X-Hop': 'omit', 'Keep-Alive': 'omit', 'Transfer-Encoding': 'chunked', Upgrade: 'omit', 'Proxy-Connection': 'omit', TE: 'gzip', 'Content-Type': 'application/json', 'Content-Length': '7', 'X-Test': 'yes' }, '{"a":1}', 1000, { ...tls, ...credentials.tls }, undefined, undefined, true, version);
        assert.equal(response.httpVersion, '2'); assert.equal(response.headers['x-request-id'], 'h2-id');
        const data = JSON.parse(response.body); assert.equal(data.body, '{"a":1}'); assert.equal(data.authorized, true); assert.equal(data.headers['x-test'], 'yes'); assert.equal(data.headers['content-length'], '7');
        for (const name of ['connection', 'x-hop', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te']) assert.equal(data.headers[name], undefined);
      }
    }
    const oauth = new OAuth2AuthProvider({ clientId: 'test', clientSecret: 'secret', tokenEndpoint: 'https://example.invalid/token', tokenAuthMethod: 'client_secret_basic' }, redactor, async () => ({ status: 200, headers: {}, body: '{"access_token":"test-token","token_type":"Bearer","expires_in":3600}', durationMs: 1 }));
    const auth = { prepareRequest: async () => ({ ...await oauth.prepareRequest({ timeoutMs: 1000 }), tls }) };
    for (const route of ['/', '/text', '/empty', '/failure']) {
      const request = { ...resolveRequest(configSchema.parse({}), profile, {}, { path: route, httpVersion: '2' }), url: new URL(route, url) };
      let shown: string | undefined;
      const result = await executeRequest(auth, request, undefined, undefined, redactor, body => { shown = payloadOutput('Response', body!, redactor); });
      assert.equal(result.httpVersion, '2'); assert.equal(result.statusCode, route === '/failure' ? 500 : 200);
      if (route === '/text') assert.equal(shown, 'Response:\nplain response');
      else if (route === '/empty') assert.equal(shown, 'Response: <empty>');
      else { assert.match(shown!, /\n  "body"/); assert.ok(!shown!.includes('test-token')); }
      if (route === '/failure') assert.equal(result.errorType, 'HTTP_500');
    }
    const versions: string[] = [];
    await poll(async () => { versions.push((await send(url, 'GET', {}, undefined, 1000, tls, undefined, undefined, false, '2')).httpVersion!); }, { intervalMs: 1, count: 3 });
    assert.deepEqual(versions, ['2', '2', '2']);
    for (const route of ['/reset', '/goaway']) await assert.rejects(send(new URL(route, url), 'GET', {}, undefined, 1000, tls, undefined, undefined, false, '2'), error => classifyError(error) === 'HTTP_PROTOCOL_ERROR');
    await assert.rejects(send(new URL('/wait', url), 'GET', {}, undefined, 30, tls, undefined, undefined, false, '2'), error => classifyError(error) === 'TIMEOUT');
    const controller = new AbortController();
    const pending = send(new URL('/wait', url), 'GET', {}, undefined, 1000, tls, controller.signal, undefined, false, '2');
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, error => classifyError(error) === 'TIMEOUT');
    await assert.rejects(send(url, 'GET', {}, undefined, 1000, tls, controller.signal, undefined, false, '2'), error => classifyError(error) === 'TIMEOUT');
    await assert.rejects(send(url, 'GET', {}, undefined, 1000, {}, undefined, undefined, false, '2'), error => classifyError(error) === 'TLS_ERROR');
    let fallbackRequests = 0;
    fallback = https.createServer({ key, cert, ALPNProtocols: [] }, (_req, res) => { fallbackRequests++; res.end(); });
    const fallbackPort = await listen(fallback);
    await assert.rejects(send(new URL(`https://localhost:${fallbackPort}/`), 'GET', {}, undefined, 1000, tls, undefined, undefined, false, '2'), /did not negotiate h2/);
    assert.equal(fallbackRequests, 0);
    const rejectAlpn = https.createServer({ key, cert }, (_req, res) => { fallbackRequests++; res.end(); });
    const rejectPort = await listen(rejectAlpn);
    try { await assert.rejects(send(new URL(`https://localhost:${rejectPort}/`), 'GET', {}, undefined, 1000, tls, undefined, undefined, false, '2'), /HTTP\/2/); assert.equal(fallbackRequests, 0); }
    finally { rejectAlpn.closeAllConnections(); await new Promise<void>(resolve => rejectAlpn.close(() => resolve())); }

    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(sessions.size, 0);
  } finally {
    for (const session of sessions) session.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (fallback) { fallback.closeAllConnections(); await new Promise<void>(resolve => fallback!.close(() => resolve())); }
    await rm(dir, { recursive: true, force: true });
  }
});
