import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { initConfig, initProfile, initRequest } from '../src/config/init.js';
import { configSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/loader.js';
import { profileSchema } from '../src/profiles/types.js';
import { discoverResources, readResource } from '../src/resources.js';
import { packageRoot } from '../src/version.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
async function temporary(task: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'saf-init-'));
  try { await task(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function structure(root: string) {
  assert.deepEqual((await readdir(root)).sort(), ['certificates', 'profiles', 'requests']);
  for (const path of [root, ...['certificates', 'profiles', 'requests'].map(name => join(root, name))]) {
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
}

for (const example of ['full', 'oauth2', 'mtls']) {
  test(`profile init ${example}: name, content, destination, permissions and no overwrite`, async () => temporary(async directory => {
    const root = join(directory, 'config');
    const path = await initProfile(root, 'custom-name', example);
    assert.equal(path, join(root, 'profiles', 'custom-name.yaml'));
    const source = await readResource('profile', example);
    const content = await readFile(path, 'utf8');
    assert.equal(profileSchema.parse(parse(content)).name, 'custom-name');
    assert.equal(content.replace(/^name:.*$/m, 'NAME'), source.replace(/^name:.*$/m, 'NAME'));
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await structure(root);
    await assert.rejects(initProfile(root, 'custom-name', example), /already exists/);
    assert.equal(await readFile(path, 'utf8'), content);
  }));
}

test('discovery derives examples and template names from packaged filenames', async () => {
  const entries = await readdir(join(packageRoot, 'examples'));
  assert.deepEqual([...(await discoverResources('profile')).keys()].sort(), entries.filter(name => /^profile\..+\.example\.yaml$/.test(name)).map(name => name.slice(8, -13)).sort());
  assert.ok((await discoverResources('request')).has('request'));
  for (const name of ['general-api/saf-receivers', 'general-api/saf-insurers']) assert.ok((await discoverResources('template')).has(name));
});

test('new filenames are discovered automatically, including named requests and nested categories', async () => temporary(async directory => {
  for (const name of ['profile.new-profile.example.yaml', 'request.example.yaml', 'request.new-request.example.yaml', 'profile.bad.name.example.yaml', 'unrelated.yaml']) await writeFile(join(directory, name), 'name: placeholder\n');
  await symlink(join(directory, 'profile.new-profile.example.yaml'), join(directory, 'profile.link.example.yaml'));
  assert.deepEqual([...(await discoverResources('profile', directory)).keys()], ['new-profile']);
  assert.deepEqual([...(await discoverResources('request', directory)).keys()], ['new-request', 'request']);
  await mkdir(join(directory, 'category', 'nested'), { recursive: true });
  await writeFile(join(directory, 'category', 'nested', 'new-template.yaml'), 'request: {}\n');
  assert.deepEqual([...(await discoverResources('template', directory)).keys()], ['category/nested/new-template']);
  await writeFile(join(directory, 'request.request.example.yaml'), 'name: duplicate\n');
  await assert.rejects(discoverResources('request', directory), /Duplicate/);
}));

test('request examples and executable templates copy exactly, privately and exclusively', async () => temporary(async directory => {
  for (const [kind, names] of [['request', ['request']], ['template', ['general-api/saf-receivers', 'general-api/saf-insurers']]] as const) {
    for (const resource of names) {
      const root = join(directory, resource.replaceAll('/', '-'));
      const options = kind === 'request' ? { example: resource } : { template: resource };
      const path = await initRequest(root, 'local', options);
      assert.equal(path, join(root, 'requests', 'local.yaml'));
      assert.equal(await readFile(path, 'utf8'), await readResource(kind, resource));
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
      await structure(root);
      await assert.rejects(initRequest(root, 'local', options), /already exists/);
    }
  }
}));

test('invalid local names, resource traversal, missing sources and mutual exclusion fail before writing', async () => temporary(async directory => {
  const root = join(directory, 'absent');
  for (const name of ['../escape', '/absolute', 'a/b', 'a\\b', '..', '', 'bad.name']) {
    await assert.rejects(initProfile(root, name, 'full'), /Invalid profile name/);
    await assert.rejects(initRequest(root, name, { example: 'request' }), /Invalid request name/);
  }
  for (const source of ['../full', '/full', 'a/b', 'a\\b', 'missing']) {
    await assert.rejects(initProfile(root, 'valid', source), /CONFIG_ERROR/);
    await assert.rejects(initRequest(root, 'valid', { example: source }), /CONFIG_ERROR/);
  }
  for (const source of ['../general-api/saf-receivers', '/general-api/saf-receivers', 'general-api/../saf-receivers', 'general-api\\saf-receivers', 'general-api/missing']) await assert.rejects(initRequest(root, 'valid', { template: source }), /CONFIG_ERROR/);
  for (const options of [{}, { example: 'request', template: 'general-api/saf-receivers' }]) await assert.rejects(initRequest(root, 'valid', options), /exactly one/);
  await assert.rejects(stat(root), { code: 'ENOENT' });
}));

test('destination symlink is rejected without changing its target', async () => temporary(async directory => {
  await initRequest(directory, 'target', { example: 'request' });
  const target = join(directory, 'requests', 'target.yaml');
  const content = await readFile(target, 'utf8');
  await symlink(target, join(directory, 'requests', 'link.yaml'));
  await assert.rejects(initRequest(directory, 'link', { example: 'request' }), /already exists/);
  assert.equal(await readFile(target, 'utf8'), content);
}));

test('config remains optional; explicit init writes schema defaults without overwriting', async () => temporary(async directory => {
  const root = join(directory, 'config');
  const expected = configSchema.parse({});
  assert.deepEqual(await loadConfig(join(root, 'config.yaml')), expected);
  await assert.rejects(stat(root), { code: 'ENOENT' });
  const path = await initConfig(root);
  assert.equal(path, join(root, 'config.yaml'));
  assert.deepEqual(configSchema.parse(parse(await readFile(path, 'utf8'))), expected);
  assert.deepEqual(await loadConfig(path), expected);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['certificates', 'config.yaml', 'profiles', 'requests']);
  await assert.rejects(initConfig(root), /already exists/);
}));

test('CLI discovery and initialization work outside checkout; help exposes all new commands', async () => temporary(async directory => {
  const root = join(directory, 'config');
  const run = (...args: string[]) => exec(process.execPath, [cli, '--config-dir', root, ...args], { cwd: directory });
  assert.match((await run('profiles', 'examples')).stdout, /full/);
  assert.match((await run('requests', 'examples')).stdout, /request/);
  assert.match((await run('requests', 'templates')).stdout, /general-api\/saf-receivers/);
  await assert.rejects(stat(root), { code: 'ENOENT' });
  assert.match((await run('profiles', 'init', 'example-profile', '--example', 'full')).stdout, /profiles validate example-profile/);
  assert.match((await run('profiles', 'show', 'example-profile')).stdout, /REDACTED/);
  await run('requests', 'init', 'receivers', '--template', 'general-api/saf-receivers');
  assert.match((await run('config', 'init')).stdout, /optional.*Deleting/s);
  for (const args of [['requests', 'init', 'bad'], ['requests', 'init', 'bad', '--example', 'request', '--template', 'general-api/saf-receivers']]) await assert.rejects(run(...args));
  assert.match((await run('--help')).stdout, /requests/);
  for (const group of ['profiles', 'requests', 'config']) assert.match((await run(group, '--help')).stdout, /init/);
  assert.match((await run('profiles', '--help')).stdout, /examples/);
  assert.match((await run('requests', '--help')).stdout, /examples[\s\S]*templates/);
}));

test('package dry run contains bundled references and excludes development and local artifacts', async () => {
  const { stdout } = await exec('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: packageRoot });
  const files = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map(file => file.path);
  for (const path of ['examples/profile.full.example.yaml', 'examples/profile.oauth2.example.yaml', 'examples/profile.mtls.example.yaml', 'examples/request.example.yaml', 'templates/general-api/saf-receivers.yaml', 'templates/general-api/saf-insurers.yaml', 'LICENSE', 'README.md', 'package.json']) assert.ok(files.includes(path), path);
  assert.ok(files.every(path => /^(dist\/|templates\/|examples\/|LICENSE$|README.md$|package.json$)/.test(path)), files.join('\n'));
  assert.ok(files.every(path => !/\.(tgz|p12|pfx)$/.test(path)));
});
