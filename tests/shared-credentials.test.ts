import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { profileSchema } from '../src/profiles/types.js';
import { validateProfile } from '../src/profiles/validator.js';
import { preparePlaceholders } from '../src/requests/placeholders.js';
import { loadTemplate } from '../src/requests/loader.js';
import { Redactor } from '../src/logging/redactor.js';
import { resolveRequest, executeRequest } from '../src/rest/request.js';
import { configSchema } from '../src/config/schema.js';
import { OAuth2AuthProvider } from '../src/auth/oauth2.js';

const licenceKey = 'dummy-shared-licence+/"';
const password = 'dummy-shared-password+/"';
const base = { name: 'shared', environment: 'IAT', credentials: { oauth2: { clientId: 'dummy-id', clientSecret: 'dummy-oauth', tokenEndpoint: 'https://example.invalid/token' } }, rest: { baseUrl: 'https://example.invalid', auth: { mode: 'oauth2', credential: 'oauth2' } } };
const withShared = (shared: unknown) => ({ ...base, credentials: { ...base.credentials, shared } });
const profile = profileSchema.parse(withShared({ licenceKey, password }));

test('optional shared schema requires exactly one complete nonempty pair', async () => {
  await validateProfile(profileSchema.parse(base));
  await validateProfile(profile);
  process.env.SAF_SHARED_KEY = licenceKey; process.env.SAF_SHARED_PASSWORD = password;
  try {
    await validateProfile(profileSchema.parse(withShared({ licenceKeyEnv: 'SAF_SHARED_KEY', passwordEnv: 'SAF_SHARED_PASSWORD' })));
    for (const shared of [{}, { licenceKey }, { password }, { licenceKey: '', password }, { licenceKey, password: '' }, { licenceKey: ' ', password }, { licenceKey, passwordEnv: 'SAF_SHARED_PASSWORD' }, { licenceKeyEnv: 'SAF_SHARED_KEY', password }, { licenceKey, password, licenceKeyEnv: 'SAF_SHARED_KEY' }, { licenceKeyEnv: 'SAF_SHARED_KEY' }]) assert.equal(profileSchema.safeParse(withShared(shared)).success, false);
    delete process.env.SAF_SHARED_PASSWORD;
    await assert.rejects(validateProfile(profileSchema.parse(withShared({ licenceKeyEnv: 'SAF_SHARED_KEY', passwordEnv: 'SAF_SHARED_PASSWORD' }))), /credentials.shared.password/);
  } finally { delete process.env.SAF_SHARED_KEY; delete process.env.SAF_SHARED_PASSWORD; }
});

test('shared references resolve literally in nested arrays and headers without mutation', () => {
  const redactor = new Redactor();
  const source = { nested: [{ value: '{{profile:credentials.shared.licenceKey}}/{{profile:credentials.shared.password}}' }], header: '{{profile:credentials.shared.password}}' };
  const resolve = preparePlaceholders(source, redactor, profile);
  assert.deepEqual(resolve(), { nested: [{ value: licenceKey + '/' + password }], header: password });
  assert.deepEqual(resolve(), resolve());
  assert.match(source.header, /profile:/);
  for (const secret of [licenceKey, password, encodeURIComponent(licenceKey), JSON.stringify(password).slice(1, -1)]) assert.equal(redactor.text(secret), '[REDACTED]');
  assert.deepEqual((redactor.sanitize(profile) as typeof profile).credentials.shared, { licenceKey: '[REDACTED]', password: '[REDACTED]' });
});

test('only two profile references are allowed and missing credentials precede authentication', async () => {
  for (const path of ['credentials.oauth2.clientSecret', 'credentials.oauth2.clientId', 'credentials.mtls.p12Password', 'credentials.mtls.p12Path', 'rest.baseUrl', 'kafka.brokers', 'credentials.shared.unknown']) assert.throws(() => preparePlaceholders('{{profile:' + path + '}}', new Redactor(), profile), /CONFIG_ERROR/);
  let calls = 0;
  for (const key of ['licenceKey', 'password']) {
    const request = resolveRequest(configSchema.parse({}), profileSchema.parse(base), { method: 'POST', path: '/test', body: '{{profile:credentials.shared.' + key + '}}' });
    const result = await executeRequest({ prepareRequest: async () => { calls++; return { headers: {} }; } }, request);
    assert.equal(result.errorType, 'CONFIG_ERROR'); assert.match(result.configurationError!, new RegExp('credentials.shared.' + key));
  }
  assert.equal(calls, 0);
});

test('generic templates resolve under either REST auth mode', async () => {
  for (const name of ['saf-receivers', 'saf-insurers']) {
    const template = await loadTemplate('templates/general-api/' + name + '.yaml');
    for (const mode of ['oauth2', 'mtls']) {
      const selected = profileSchema.parse({ ...profile, credentials: { ...profile.credentials, mtls: { p12Path: '/unused.p12', p12Password: '' } }, rest: { ...profile.rest, auth: { mode, credential: mode } } });
      const request = resolveRequest(configSchema.parse({}), selected, template.request);
      const body = preparePlaceholders(request.body, new Redactor(), selected)() as Record<string, unknown>;
      assert.equal(body.licenceKey, licenceKey); assert.equal(body.password, password);
      assert.equal(request.url.pathname, '/general/v3/' + name); assert.equal(body.onBehalfOf, undefined);
    }
  }
});

test('shared secrets are registered before OAuth diagnostics', async () => {
  const redactor = new Redactor();
  const auth = new OAuth2AuthProvider(profile.credentials.oauth2!, redactor, async () => ({ status: 401, headers: {}, durationMs: 1, body: JSON.stringify({ error: 'invalid_client', error_description: licenceKey + ' ' + password }) }));
  const result = await executeRequest(auth, resolveRequest(configSchema.parse({}), profile, { path: '/test' }), undefined, undefined, redactor);
  assert.equal(result.errorType, 'AUTH_ERROR');
  assert.ok(!JSON.stringify(result).includes('dummy-shared'));
});

test('profiles show and validate local smoke tests keep shared values secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saf-shared-cli-'));
  const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
  try {
    await mkdir(join(dir, 'profiles')); await writeFile(join(dir, 'profiles/shared.yaml'), JSON.stringify(profile));
    const run = (command: string) => promisify(execFile)(process.execPath, [cli, '--config-dir', dir, 'profiles', command, 'shared']);
    const shown = await run('show');
    assert.deepEqual(JSON.parse(shown.stdout).credentials.shared, { licenceKey: '[REDACTED]', password: '[REDACTED]' });
    assert.ok(!shown.stdout.includes('dummy-shared')); assert.equal(shown.stderr, '');
    assert.equal(JSON.parse((await run('validate')).stdout).validation, 'OK');
    await writeFile(join(dir, 'profiles/shared.yaml'), JSON.stringify(withShared({ licenceKey, password, passwordEnv: 'SAF_SHARED_PASSWORD' })));
    await assert.rejects(run('validate'), error => {
      const output = error as { stdout: string; stderr: string };
      assert.match(output.stderr, /CONFIG_ERROR/);
      assert.ok(!(output.stdout + output.stderr).includes('dummy-shared')); return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
