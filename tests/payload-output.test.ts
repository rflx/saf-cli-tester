import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { payloadOutput, kafkaPayloadOutput } from '../src/logging/payload.js';
import { Redactor } from '../src/logging/redactor.js';
import { executeRequest, resolveRequest } from '../src/rest/request.js';
import { configSchema } from '../src/config/schema.js';
import { profileSchema } from '../src/profiles/types.js';

const credentials = { shared: { licenceKey: 'licence-value', password: 'shared-value' }, oauth2: { clientId: 'client-value', clientSecret: 'oauth-value', tokenEndpoint: 'https://example.invalid/token' }, mtls: { p12Path: '/unused', p12Password: 'p12-value' } };
function redactor() { const r = new Redactor(); r.register({ credentials }); r.add('token-value'); return r; }

test('payload presentation preserves JSON arrays/nesting, plain text, empty bodies and central redaction', () => {
  const r = redactor();
  assert.equal(payloadOutput('Response', '[{"nested":[1,true]}]', r), 'Response:\n[\n  {\n    "nested": [\n      1,\n      true\n    ]\n  }\n]');
  assert.equal(payloadOutput('Response', 'plain text', r), 'Response:\nplain text');
  assert.equal(payloadOutput('Response', '', r), 'Response: <empty>');
  const values = ['licence-value', 'shared-value', 'oauth-value', 'p12-value', 'token-value'];
  for (const body of [JSON.stringify({ note: values.join(' '), Authorization: 'Bearer other-token' }), values.join(' ') + ' Bearer other-token']) {
    const output = payloadOutput('Response', body, r);
    for (const secret of [...values, 'other-token']) assert.ok(!output.includes(secret));
  }
});

test('Kafka presentation decodes JSON/text safely without changing message bytes', () => {
  const r = redactor();
  for (const text of ['[{"nested":{"items":[1,2]}}]', 'plain text', '"JSON scalar"', 'shared-value oauth-value p12-value licence-value token-value']) {
    const value = Buffer.from(text), original = Buffer.from(value);
    const output = kafkaPayloadOutput(value, r);
    assert.deepEqual(value, original);
    if (text === 'plain text') assert.equal(output, 'Payload:\nplain text');
    if (text.startsWith('[')) assert.match(output, /\n      "items": \[/);
    for (const secret of ['shared-value', 'oauth-value', 'p12-value', 'licence-value', 'token-value']) assert.ok(!output.includes(secret));
  }
  for (const value of [Buffer.from([0xff, 0xfe]), Buffer.from([0, 1, 2]), Buffer.from('text\x1b[31m')]) assert.equal(kafkaPayloadOutput(value, r), `Payload: <binary, ${value.length} bytes>`);
  assert.equal(kafkaPayloadOutput(null, r), 'Payload: <null>');
  assert.equal(kafkaPayloadOutput(Buffer.alloc(0), r), 'Payload: <empty>');
});

test('REST console capture covers HTTP statuses independently of bounded persistent diagnostics', async () => {
  const server = createServer((req, res) => {
    const route = req.url!.slice(1);
    res.statusCode = /^\d+$/.test(route) ? Number(route) : 200;
    res.end(route === 'empty' ? '' : route === 'text' ? 'plain response' : JSON.stringify({ nested: [{ visible: 'console-unique', echoed: 'shared-value' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const profile = profileSchema.parse({ name: 'test', environment: 'IAT', credentials, rest: { baseUrl: 'https://example.invalid', auth: { mode: 'oauth2', credential: 'oauth2' } } });
  try {
    for (const route of ['200', '302', '404', '500', 'empty', 'text']) {
      const request = { ...resolveRequest(configSchema.parse({ rest: { diagnosticBodyMaxBytes: 8 } }), profile, { path: '/' + route }), url: new URL(`http://127.0.0.1:${address.port}/${route}`) };
      const auth = { prepareRequest: async () => ({ headers: {} }) };
      const normal = await executeRequest(auth, request, undefined, undefined, redactor());
      let shown: string | undefined;
      const displayed = await executeRequest(auth, request, undefined, undefined, redactor(), body => { shown = payloadOutput('Response', body!, redactor()); });
      assert.equal(displayed.statusCode, normal.statusCode);
      assert.equal(displayed.errorType, normal.errorType);
      assert.equal(displayed.result, normal.result);
      assert.deepEqual(displayed.responseBody, normal.responseBody);
      assert.ok(!JSON.stringify(displayed).includes('console-unique'));
      assert.ok(!shown!.includes('shared-value'));
      if (route === 'empty') assert.equal(shown, 'Response: <empty>');
      else if (route === 'text') assert.equal(shown, 'Response:\nplain response');
      else assert.match(shown!, /\n      "visible": "console-unique"/);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
