import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePlaceholders, templateBody } from '../src/requests/placeholders.js';
import { loadTemplate } from '../src/requests/loader.js';
import { configSchema } from '../src/config/schema.js';
import { profileSchema } from '../src/profiles/types.js';
import { executeRequest, resolveRequest } from '../src/rest/request.js';
import { poll } from '../src/rest/poller.js';
import { Redactor } from '../src/logging/redactor.js';
import { Logger } from '../src/logging/logger.js';
import { openLog } from '../src/logging/jsonl.js';
import { RunExports } from '../src/logging/exports.js';
import { StatsCollector } from '../src/stats/collector.js';

const profile = profileSchema.parse({ name: 'test', environment: 'IAT', rest: { baseUrl: 'https://example.invalid' }, auth: { mode: 'oauth2', clientId: 'dummy', clientSecret: 'dummy', tokenEndpoint: 'https://example.invalid/token' } });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('recursive values, arrays, UUID v4 and RFC3339 UTC timestamps', () => {
  const source = { id: '{{uuid}}', nested: { values: ['prefix-{{uuid}}', '{{nowUtc}}', 42, null, true] } };
  const before = Date.now();
  const result = preparePlaceholders(source, new Redactor())() as typeof source;
  assert.match(result.id, uuidPattern);
  assert.equal(result.nested.values[0], 'prefix-' + result.id);
  const timestamp = String(result.nested.values[1]);
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(timestamp) >= before && Date.parse(timestamp) <= Date.now());
  assert.deepEqual(result.nested.values.slice(2), [42, null, true]);
  assert.equal(source.id, '{{uuid}}');
});

test('environment values are literal, escaped in JSON and centrally redacted', () => {
  const name = 'SAF_PLACEHOLDER_TEST'; const secret = 'dummy-"quote"\n{{foo}}&';
  process.env[name] = secret;
  try {
    const redactor = new Redactor();
    const result = preparePlaceholders(templateBody('{"nested":{"value":"{{env:SAF_PLACEHOLDER_TEST}}"}}'), redactor)();
    assert.deepEqual(result, { nested: { value: secret } });
    const json = JSON.stringify(result);
    assert.equal(JSON.parse(json).nested.value, secret);
    assert.equal(preparePlaceholders(templateBody('"{{env:SAF_PLACEHOLDER_TEST}}"'), redactor)(), secret);
    for (const value of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]) assert.equal(redactor.text(value), '[REDACTED]');
  } finally { delete process.env[name]; }
});

test('missing and empty env references fail with variable name only', () => {
  for (const value of [undefined, '']) {
    if (value === undefined) delete process.env.SAF_PLACEHOLDER_MISSING;
    else process.env.SAF_PLACEHOLDER_MISSING = value;
    assert.throws(() => preparePlaceholders('{{env:SAF_PLACEHOLDER_MISSING}}', new Redactor()), /CONFIG_ERROR: Environment variable SAF_PLACEHOLDER_MISSING is not set or is empty/);
  }
  delete process.env.SAF_PLACEHOLDER_MISSING;
});

test('unknown, malformed and executable placeholders fail safely', () => {
  for (const value of ['{{foo}}', '{{uuid', 'uuid}}', '{{}}', '{{{uuid}}}', '{{uuid}}}', '{{env:}}', '{{env:BAD-NAME}}', '{{ env:NAME }}', '{{$(echo secret)}}', '{{uuid}}{{bad}}']) {
    assert.throws(() => preparePlaceholders(value, new Redactor()), /CONFIG_ERROR/);
  }
  assert.throws(() => preparePlaceholders({ '{{uuid}}': 'value' }, new Redactor()), /CONFIG_ERROR/);
});

test('static bodies and template files remain compatible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-template-'));
  try {
    for (const body of ['  { "static": true }\n', '{"nested":{"static":true}}', 'plain text', '"string"', 'null']) {
      let expected: unknown = body;
      try { expected = JSON.parse(body) as unknown; } catch { /* Plain text stays literal. */ }
      assert.deepEqual(preparePlaceholders(templateBody(body), new Redactor())(), expected);
    }
    const file = join(dir, 'template.yaml');
    await writeFile(file, 'request:\n  method: POST\n  path: /general\n  body:\n    requestId: "{{uuid}}"\n    nested:\n      - "{{nowUtc}}"\n');
    const template = await loadTemplate(file);
    assert.deepEqual(template.request.body, { requestId: '{{uuid}}', nested: ['{{nowUtc}}'] });
    await writeFile(file, 'request:\n  method: POST\n  path: /general\n  body: static\n');
    assert.equal((await loadTemplate(file)).request.body, 'static');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('poll resolves each request freshly and protects echoed secrets in diagnostics and exports', async () => {
  process.env.SAF_PLACEHOLDER_POLL = 'dummy-runtime-licence';
  const received: Array<{ id: string; time: string; secret: string; header?: string }> = [];
  const rawBodies: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    rawBodies.push(body);
    received.push({ ...JSON.parse(body), header: req.headers['x-runtime'] });
    res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': process.env.SAF_PLACEHOLDER_POLL ?? 'static' });
    res.end(JSON.stringify({ echoed: process.env.SAF_PLACEHOLDER_POLL }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = await mkdtemp(join(tmpdir(), 'saf-runtime-'));
  const redactor = new Redactor(); const logger = new Logger(redactor, await openLog(dir, 'runtime'));
  const exports = await RunExports.open('both', dir, dir, 'runtime', redactor);
  const stats = new StatsCollector();
  let preparations = 0;
  const auth = { prepareRequest: async () => { preparations++; return { headers: {} }; } };
  const request = { ...resolveRequest(configSchema.parse({}), profile, { method: 'POST', path: '/general', headers: { 'X-Runtime': '{{uuid}}' }, body: { id: '{{uuid}}', time: '{{nowUtc}}', secret: '{{env:SAF_PLACEHOLDER_POLL}}' } }), url: new URL(`http://127.0.0.1:${address.port}/general`) };
  try {
    await poll(async sequenceNumber => {
      const result = await executeRequest(auth, request, undefined, undefined, redactor);
      assert.equal(result.errorType, 'HTTP_500'); stats.add(result);
      await logger.record(result); await exports?.record({ sequenceNumber, ...result });
      assert.ok(!JSON.stringify(redactor.sanitize(result)).includes(process.env.SAF_PLACEHOLDER_POLL!));
    }, { count: 2, intervalMs: 20 });
    assert.equal(received.length, 2);
    for (const entry of received) { assert.match(entry.id, uuidPattern); assert.equal(entry.header, entry.id); assert.equal(entry.secret, 'dummy-runtime-licence'); }
    assert.notEqual(received[0]!.id, received[1]!.id);
    assert.notEqual(received[0]!.time, received[1]!.time);
    assert.equal((request.body as { id: string }).id, '{{uuid}}');
    // The environment is read again for the next execution.
    process.env.SAF_PLACEHOLDER_POLL = 'dummy-new-licence';
    await executeRequest(auth, request, undefined, undefined, redactor);
    assert.equal(received[2]!.secret, 'dummy-new-licence');
    delete process.env.SAF_PLACEHOLDER_POLL;
    const staticBody = '  {"nested": {"static": true}}\n';
    const staticRequest = { ...request, body: staticBody };
    await executeRequest(auth, staticRequest, undefined, undefined, redactor);
    assert.equal(received.length, 4);
    assert.equal(rawBodies[3], staticBody);
    const missing = await executeRequest(auth, request, undefined, undefined, redactor);
    assert.equal(missing.errorType, 'CONFIG_ERROR'); assert.match(missing.configurationError!, /SAF_PLACEHOLDER_POLL/);
    for (const body of ['{{foo}}', '{{uuid']) {
      assert.equal((await executeRequest(auth, { ...request, body }, undefined, undefined, redactor)).errorType, 'CONFIG_ERROR');
    }
    process.env.SAF_PLACEHOLDER_POLL = 'dummy\r\nInjected: value';
    const unsafe = await executeRequest(auth, { ...request, headers: { 'x-runtime': '{{env:SAF_PLACEHOLDER_POLL}}' } }, undefined, undefined, redactor);
    assert.equal(unsafe.errorType, 'CONFIG_ERROR'); assert.ok(!JSON.stringify(unsafe).includes('Injected'));
    assert.equal(received.length, 4); assert.equal(preparations, 5);
    await exports?.summary({ runId: 'runtime', profile: 'test', environment: 'IAT', startTime: '', endTime: '' }, stats.summary());
    await logger.close(); await exports?.close();
    for (const file of ['runtime.jsonl', 'runtime.csv', 'runtime.summary.json']) {
      const text = await readFile(join(dir, file), 'utf8');
      assert.ok(!text.includes('dummy-runtime-licence')); assert.ok(!text.includes('dummy-new-licence'));
    }
  } finally {
    delete process.env.SAF_PLACEHOLDER_POLL;
    await logger.close(); await exports?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});
