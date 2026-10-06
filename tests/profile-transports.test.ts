import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { profileSchema, restCredential } from '../src/profiles/types.js';
import { validateProfile, profileValidation } from '../src/profiles/validator.js';
import { OAuth2AuthProvider } from '../src/auth/oauth2.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { Redactor } from '../src/logging/redactor.js';
import { Logger } from '../src/logging/logger.js';
import { openLog } from '../src/logging/jsonl.js';
import { RunExports } from '../src/logging/exports.js';
import { StatsCollector } from '../src/stats/collector.js';
import { loadProfile } from '../src/profiles/loader.js';
import { configSchema } from '../src/config/schema.js';
import { executeRequest, resolveRequest } from '../src/rest/request.js';

const oauth2 = { clientId: 'transport-client', clientSecret: 'transport-secret', tokenEndpoint: 'https://example.invalid/token', scope: 'https://graph.microsoft.com/.default' };
const mtls = { p12Path: '/absent/example.p12', p12Password: 'transport-p12-secret' };
const identity = { name: 'transport-test', environment: 'IAT' };
const rest = (mode: string) => ({ baseUrl: 'https://example.invalid', auth: { mode, credential: mode } });
const kafka = { brokers: ['example.invalid:9092'], auth: { mode: 'mtls', credential: 'mtls' } };

test('transport combinations, shared credentials, references and legacy normalization', async () => {
  for (const transports of [{ rest: rest('oauth2') }, { rest: rest('mtls') }, { kafka }, { rest: rest('oauth2'), kafka }, { rest: rest('mtls'), kafka }]) {
    const p = profileSchema.parse({ ...identity, credentials: { oauth2, mtls }, ...transports });
    assert.deepEqual(p.credentials.mtls, mtls);
    if (p.rest) { const selected = restCredential(p); if (selected.mode === 'mtls') assert.equal(selected.p12Path, p.credentials.mtls?.p12Path); }
  }
  await validateProfile(profileSchema.parse({ ...identity, credentials: { oauth2 }, rest: rest('oauth2') }));
  const onlyKafka = profileSchema.parse({ ...identity, credentials: { mtls }, kafka });
  assert.throws(() => resolveRequest(configSchema.parse({}), onlyKafka, { path: '/' }), /no REST transport/);
  const legacy = { ...identity, rest: { baseUrl: 'https://example.invalid' }, auth: { mode: 'oauth2', ...oauth2 } };
  assert.deepEqual(profileSchema.parse(legacy), profileSchema.parse({ ...identity, credentials: { oauth2 }, rest: rest('oauth2') }));
  assert.equal(profileSchema.parse({ ...legacy, auth: { mode: 'mtls', p12Path: mtls.p12Path, p12PasswordEnv: 'TEST_P12' } }).rest?.auth.mode, 'mtls');
  for (const invalid of [
    { credentials: { mtls }, rest: { ...rest('mtls'), auth: { mode: 'mtls', credential: 'does-not-exist' } } },
    { credentials: { oauth2 }, rest: rest('mtls') },
    { credentials: {}, rest: rest('oauth2') },
    { credentials: { oauth2 }, kafka: { ...kafka, auth: { mode: 'oauth2', credential: 'oauth2' } } },
    { credentials: { oauth2: { ...oauth2, clientIdEnv: 'TEST_ID', clientSecretEnv: 'TEST_SECRET' } }, rest: rest('oauth2') },
    { credentials: { mtls: { ...mtls, p12PasswordEnv: 'TEST_PASSWORD' } }, kafka },
    { credentials: { oauth2 } },
    { credentials: { mtls }, kafka: { ...kafka, brokers: ['example.invalid:99999'] } }
  ]) assert.equal(profileSchema.safeParse({ ...identity, ...invalid }).success, false);
  for (const extra of [{ credentials: { oauth2 } }, { rest: rest('oauth2') }]) {
    const parsed = profileSchema.safeParse({ ...legacy, ...extra });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.match(parsed.error.message, /Ambiguous legacy/);
  }
});

test('new nested credentials are redacted in CLI display, errors, JSONL and exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-nested-'));
  try {
    const raw = { ...identity, credentials: { oauth2, mtls }, rest: rest('oauth2'), kafka };
    await mkdir(join(dir, 'profiles'));
    await writeFile(join(dir, 'profiles/transport-test.yaml'), JSON.stringify(raw));
    const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
    const shown = await promisify(execFile)(process.execPath, [cli, '--config-dir', dir, 'profiles', 'show', identity.name]);
    const p = JSON.parse(shown.stdout);
    assert.equal(p.credentials.oauth2.clientId, '[REDACTED]');
    assert.equal(p.credentials.oauth2.clientSecret, '[REDACTED]');
    assert.equal(p.credentials.mtls.p12Password, '[REDACTED]');
    const r = new Redactor(); r.register(raw);
    assert.equal((r.sanitize(new Error(mtls.p12Password)) as { message: string }).message, '[REDACTED]');
    const logger = new Logger(r, await openLog(dir, 'nested'));
    await logger.record({ profile: raw, note: `${oauth2.clientSecret} ${mtls.p12Password}` }); await logger.close();
    const exports = await RunExports.open('both', dir, dir, 'nested', r);
    await exports!.record({ profile: oauth2.clientSecret, path: mtls.p12Password });
    await exports!.summary({ runId: 'nested', profile: mtls.p12Password, environment: 'IAT', startTime: '', endTime: '' }, new StatsCollector().summary());
    await exports!.close();
    for (const file of ['nested.jsonl', 'nested.csv', 'nested.summary.json']) {
      const content = await readFile(join(dir, file), 'utf8');
      for (const value of [oauth2.clientId, oauth2.clientSecret, mtls.p12Password]) assert.ok(!content.includes(value));
    }
    await writeFile(join(dir, 'profiles/transport-test.yaml'), JSON.stringify({ ...raw, kafka: { ...kafka, auth: { mode: 'oauth2', credential: 'oauth2' } } }));
    await assert.rejects(promisify(execFile)(process.execPath, [cli, '--config-dir', dir, 'profiles', 'validate', identity.name]), error => {
      const stderr = (error as { stderr: string }).stderr;
      assert.match(stderr, /kafka.auth.mode/); assert.ok(!stderr.includes(oauth2.clientSecret)); return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local P12 validation and real HTTPS REST requests with OAuth2 and mTLS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-cert-'));
  const exec = promisify(execFile);
  try {
    const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem'), p12Path = join(dir, 'cert.p12');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    await exec('openssl', ['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-out', p12Path, '-passout', `pass:${mtls.p12Password}`]);
    const credential = { ...mtls, p12Path };
    for (const transports of [{ rest: rest('mtls') }, { kafka }, { rest: rest('oauth2'), kafka }, { rest: rest('mtls'), kafka }]) {
      await validateProfile(profileSchema.parse({ ...identity, credentials: { oauth2, mtls: credential }, ...transports }));
    }
    await assert.rejects(validateProfile(profileSchema.parse({ ...identity, credentials: { mtls }, kafka })), /Cannot read/);
    await assert.rejects(validateProfile(profileSchema.parse({ ...identity, credentials: { mtls: { ...credential, p12Password: 'wrong' } }, kafka })), /certificate\/password/);
    process.env.TRANSPORT_P12_PASSWORD = mtls.p12Password;
    try { await validateProfile(profileSchema.parse({ ...identity, credentials: { mtls: { p12Path, p12PasswordEnv: 'TRANSPORT_P12_PASSWORD' } }, kafka })); }
    finally { delete process.env.TRANSPORT_P12_PASSWORD; }
    const cert = await readFile(certPath);
    for (const mode of ['oauth2', 'mtls'] as const) {
      const server = createServer({ key: await readFile(keyPath), cert, ca: cert, requestCert: mode === 'mtls', rejectUnauthorized: true }, (req, res) => {
        if (req.url === '/token' && mode === 'oauth2') {
          const chunks: Buffer[] = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => {
            assert.equal(new URLSearchParams(Buffer.concat(chunks).toString()).get('scope'), oauth2.scope);
            assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${oauth2.clientId}:${oauth2.clientSecret}`).toString('base64')}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'local-token', token_type: 'Bearer', expires_in: 60 }));
          });
          return;
        }
        if (mode === 'mtls') assert.equal((req.socket as import('node:tls').TLSSocket).authorized, true);
        else assert.equal(req.headers.authorization, 'Bearer local-token');
        res.writeHead(200); res.end('ok');
      });
      server.listen(0, 'localhost'); await once(server, 'listening');
      try {
        const address = server.address() as import('node:net').AddressInfo;
        const p = profileSchema.parse({ ...identity, credentials: { oauth2, mtls: credential }, rest: { ...rest(mode), baseUrl: `https://localhost:${address.port}` } });
        const selected = restCredential(p), r = new Redactor();
        const provider: import('../src/auth/types.js').AuthProvider = selected.mode === 'mtls' ? new MtlsAuthProvider(selected, r) : new OAuth2AuthProvider(selected, r, async (_url, _method, _headers, body) => {
          assert.equal(new URLSearchParams(body).get('scope'), oauth2.scope);
          return { status: 200, headers: {}, durationMs: 1, body: JSON.stringify({ access_token: 'local-token', token_type: 'Bearer', expires_in: 60 }) };
        });
        const trusted = { prepareRequest: async (context: { timeoutMs: number }) => { const prepared = await provider.prepareRequest(context); return { ...prepared, tls: { ...prepared.tls, ca: cert } }; } };
        const result = await executeRequest(trusted, resolveRequest(configSchema.parse({}), p, { path: '/', timeoutMs: 1000 }), undefined, undefined, r);
        assert.equal(result.statusCode, 200); assert.equal(result.result, 'success');
        // Exercise the actual CLI factory, template/polling path and all exports.
        const configDir = join(dir, mode);
        await mkdir(join(configDir, 'profiles'), { recursive: true });
        await writeFile(join(configDir, 'profiles/transport-test.yaml'), JSON.stringify({ ...p, credentials: { ...p.credentials, oauth2: { ...p.credentials.oauth2, tokenEndpoint: `https://localhost:${address.port}/token` } } }));
        const template = join(dir, `${mode}.yaml`);
        await writeFile(template, JSON.stringify({ request: { path: '/', timeoutMs: 1000 }, poll: { count: 2, intervalSeconds: 0.001 } }));
        const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
        for (const args of [['rest', 'request', '--path', '/'], ['rest', 'poll', '--path', '/', '--count', '2', '--interval', '0.001'], ['run', '--request', template]]) {
          const output = join(configDir, `export-${args[0]}-${args[1]}`);
          const completed = await exec(process.execPath, [cli, '--config-dir', configDir, ...args, '--profile', identity.name, '--export', 'both', '--output', output], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath } });
          assert.match(completed.stdout, /Successful: [12]/);
          for (const secret of [oauth2.clientSecret, mtls.p12Password, 'local-token']) assert.ok(!completed.stdout.includes(secret));
        }
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('nested environment credential resolution and registration before REST auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-env-'));
  process.env.TRANSPORT_ID = 'environment-client'; process.env.TRANSPORT_SECRET = 'environment-secret'; process.env.TRANSPORT_P12 = 'environment-p12-secret';
  try {
    await writeFile(join(dir, 'transport-test.yaml'), JSON.stringify({ ...identity, credentials: {
      oauth2: { clientIdEnv: 'TRANSPORT_ID', clientSecretEnv: 'TRANSPORT_SECRET', tokenEndpoint: oauth2.tokenEndpoint },
      mtls: { p12Path: mtls.p12Path, p12PasswordEnv: 'TRANSPORT_P12' }
    }, rest: rest('oauth2') }));
    const r = new Redactor(); const p = await loadProfile(dir, identity.name, r);
    assert.equal(r.text('environment-client environment-secret environment-p12-secret'), '[REDACTED] [REDACTED] [REDACTED]');
    const credential = restCredential(p); if (credential.mode !== 'oauth2') throw new Error();
    const provider = new OAuth2AuthProvider(credential, r, async (_url, _method, headers) => {
      assert.equal(headers.Authorization, `Basic ${Buffer.from('environment-client:environment-secret').toString('base64')}`);
      return { status: 200, headers: {}, durationMs: 1, body: JSON.stringify({ access_token: 'env-token', token_type: 'Bearer', expires_in: 60 }) };
    });
    await provider.prepareRequest({ timeoutMs: 100 });
  } finally { delete process.env.TRANSPORT_ID; delete process.env.TRANSPORT_SECRET; delete process.env.TRANSPORT_P12; await rm(dir, { recursive: true, force: true }); }
});

test('transport validation reports REST success independently of Kafka certificate failure', async () => {
  const report = await profileValidation(profileSchema.parse({ ...identity, credentials: { oauth2, mtls }, rest: rest('oauth2'), kafka }));
  assert.equal(report.rest.validation, 'OK');
  assert.equal(report.kafka.validation, 'FAILED');
  assert.equal(report.validation, 'FAILED');
  assert.match(report.kafka.error!, /credentials.mtls.p12Path/);
});
