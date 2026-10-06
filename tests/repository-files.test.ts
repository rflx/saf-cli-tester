import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { profileSchema } from '../src/profiles/types.js';
import { loadTemplate } from '../src/requests/loader.js';
import { preparePlaceholders } from '../src/requests/placeholders.js';
import { Redactor } from '../src/logging/redactor.js';

async function yamlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? yamlFiles(join(root, entry.name))
    : Promise.resolve(/\.ya?ml$/.test(entry.name) ? [join(root, entry.name)] : [])));
  return nested.flat().sort();
}
const fakeProfile = profileSchema.parse({ name: 'fake-profile', environment: 'IAT',
  credentials: { shared: { licenceKey: 'fake-licence', password: 'fake-password' },
    oauth2: { clientId: 'fake-client', clientSecret: 'fake-secret', tokenEndpoint: 'https://example.invalid/token' } },
  rest: { baseUrl: 'https://example.invalid', auth: { mode: 'oauth2', credential: 'oauth2' } } });

for (const mode of ['oauth2', 'mtls', 'full']) {
  test(`${mode} profile reference matches Profile/Auth v2 schema`, async () => {
    const profile = profileSchema.parse(parse(await readFile(`examples/profile.${mode}.example.yaml`, 'utf8')));
    assert.equal(profile.rest?.auth.mode, mode === 'mtls' ? 'mtls' : 'oauth2');
    if (mode === 'full') {
      assert.ok(profile.credentials.shared);
      assert.ok(profile.credentials.oauth2);
      assert.ok(profile.credentials.mtls);
      assert.equal(profile.kafka?.auth.mode, 'mtls');
      assert.ok(profileSchema.safeParse({ ...profile, rest: { ...profile.rest, auth: { mode: 'mtls', credential: 'mtls' } } }).success);
    }
  });
}

test('generic request reference parses and resolves runtime values', async () => {
  const template = await loadTemplate('examples/request.example.yaml');
  const resolved = preparePlaceholders(template.request, new Redactor(), fakeProfile)() as typeof template.request;
  assert.equal(resolved.path, '/example/path');
  assert.doesNotMatch(JSON.stringify(resolved), /\{\{/);
});

test('all repository templates validate, resolve, and keep credentials as placeholders', async () => {
  const files = await yamlFiles('templates');
  for (const required of ['saf-receivers', 'saf-insurers']) {
    assert.ok(files.includes(`templates/general-api/${required}.yaml`));
  }
  for (const file of files) {
    const template = await loadTemplate(file);
    const redactor = new Redactor();
    const resolved = preparePlaceholders(template.request, redactor, fakeProfile)() as typeof template.request;
    assert.doesNotMatch(JSON.stringify(resolved), /\{\{/, file);
    assert.doesNotMatch(JSON.stringify(redactor.sanitize(resolved)), /fake-licence|fake-password/, file);
    if (file.startsWith('templates/general-api/')) {
      const body = template.request.body as Record<string, unknown>;
      assert.equal(body.licenceKey, '{{profile:credentials.shared.licenceKey}}');
      assert.equal(body.password, '{{profile:credentials.shared.password}}');
      assert.equal(body.requestId, '{{uuid}}');
      assert.equal(body.requestTime, '{{nowUtc}}');
      assert.equal(body.onBehalfOf, undefined);
      assert.equal(template.request.path, `/general/v3/${template.name}`);
      const resultBody = resolved.body as Record<string, unknown>;
      assert.equal(resultBody.licenceKey, 'fake-licence');
      assert.equal(resultBody.password, 'fake-password');
      assert.match(String(resultBody.requestId), /^[0-9a-f-]{14}4[0-9a-f-]{21}$/i);
      assert.equal(new Date(String(resultBody.requestTime)).toISOString(), resultBody.requestTime);
    }
  }
});

test('reference inventory contains no duplicate General API executable examples', async () => {
  assert.deepEqual(await yamlFiles('examples'), [
    'examples/profile.full.example.yaml', 'examples/profile.mtls.example.yaml',
    'examples/profile.oauth2.example.yaml', 'examples/request.example.yaml'
  ]);
});

test('repository YAML uses obvious placeholders for sensitive fields and fake endpoints', async () => {
  const sensitive = /^(clientId|clientSecret|licenceKey|password|p12Password|token|accessToken|refreshToken|privateKey)$/i;
  const inspect = (value: unknown, file: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (sensitive.test(key)) assert.ok(typeof child === 'string' && /^(<[^<>]+>|\{\{(?:profile:credentials\.shared\.(?:licenceKey|password)|env:[A-Za-z_][A-Za-z0-9_]*)\}\})$/.test(child), `${file}: ${key} must be an obvious placeholder`);
      if (['baseUrl', 'openIdConfigurationUrl', 'tokenEndpoint'].includes(key)) assert.equal(new URL(String(child)).hostname, 'example.invalid', `${file}: ${key}`);
      if (key === 'brokers') assert.deepEqual(child, ['<kafka-broker>:9092'], file);
      inspect(child, file);
    }
  };
  for (const file of [...await yamlFiles('examples'), ...await yamlFiles('templates')]) {
    const source = await readFile(file, 'utf8');
    assert.ok(!/-----BEGIN|\beyJ[A-Za-z0-9_-]+\./.test(source), `${file}: key/token material`);
    inspect(parse(source), file);
  }
});
