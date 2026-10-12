import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { packageRoot, toolVersion } from '../src/version.js';
import { checkUpdate, compareVersions, latestRelease, isGlobalInstallation } from '../src/updates.js';
import { preparePlaceholders } from '../src/requests/placeholders.js';
import { Redactor } from '../src/logging/redactor.js';

test('package version, CLI and nonsecret runtime placeholder share one source', () => {
  assert.equal(toolVersion, JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version);
  assert.equal(execFileSync(process.execPath, [join(packageRoot, 'dist/cli/index.js'), '--version'], { cwd: '/tmp', encoding: 'utf8' }).trim(), toolVersion);
  const redactor = new Redactor();
  assert.equal(redactor.text(String(preparePlaceholders('{{toolVersion}}', redactor)())), toolVersion);
  for (const name of ['saf-receivers', 'saf-insurers']) assert.match(readFileSync(join(packageRoot, `templates/general-api/${name}.yaml`), 'utf8'), /version: "\{\{toolVersion\}\}"/);
  const walk = (path: string): void => { for (const file of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, file.name);
    if (file.isDirectory()) walk(full);
    else assert.doesNotMatch(readFileSync(full, 'utf8'), /(?:\.version\(|version:\s*)['"]0\.[12]\.0['"]/);
  } };
  walk(join(packageRoot, 'src')); walk(join(packageRoot, 'templates'));
  assert.equal(preparePlaceholders('SAF 1.2.0 / General API 3.0.0', redactor)(), 'SAF 1.2.0 / General API 3.0.0');
});

const mock = (body: string, status = 200, headers?: HeadersInit): typeof fetch => async () => new Response(body, { status, headers });
const release = (tag = 'v0.2.0') => JSON.stringify({ tag_name: tag, draft: false, prerelease: false });
test('GitHub release response and useful unauthenticated headers', async () => {
  const result = await latestRelease(async (url, options) => {
    assert.match(String(url), /releases\/latest$/);
    assert.deepEqual(options?.headers, { Accept: 'application/vnd.github+json', 'User-Agent': `saf-cli-tester/${toolVersion}` });
    return new Response(release());
  });
  assert.deepEqual(result, { tag: 'v0.2.0', version: '0.2.0' });
});
test('semantic comparison handles patch/minor/major, equality and newer installations', async () => {
  for (const [a, b, expected] of [['0.2.0','0.2.0',0], ['0.2.1','0.2.0',1], ['0.3.0','0.2.9',1], ['1.0.0','0.9.9',1], ['0.10.0','0.9.0',1], ['0.1.0','0.2.0',-1]] as const) assert.equal(compareVersions(a,b),expected);
  for (const current of ['0.2.0','0.1.9','0.0.9','0.0.0','0.3.0']) {
    const lines: string[] = [];
    await checkUpdate({ current, latest: () => latestRelease(mock(release())), print: s => lines.push(s) });
    assert.match(lines.join('\n'), current === '0.2.0' ? /up to date/ : current === '0.3.0' ? /newer than/ : /Update available/);
  }
});
test('GitHub failures classified without leaking network errors', async () => {
  for (const [fetcher, code] of [
    [mock('',404),'NO_RELEASE'], [mock('',500),'API_ERROR'], [mock('',429),'RATE_LIMIT'],
    [mock('',403, {'x-ratelimit-remaining':'0'}),'RATE_LIMIT'], [mock('{'),'RESPONSE_ERROR'],
    [mock('{}'),'RESPONSE_ERROR'], [mock(release('v1.2.3;evil')),'INVALID_TAG'],
    [mock(release('1.2.3')),'INVALID_TAG'], [mock(release('v1.2.3-beta.1')),'INVALID_TAG'],
    [async () => { throw new Error('secret DNS detail'); },'NETWORK_ERROR']
  ] as [typeof fetch,string][]) await assert.rejects(latestRelease(fetcher), new RegExp(`UPDATE_${code}`));
  await assert.rejects(latestRelease(async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('abort')))), 5), /UPDATE_TIMEOUT/);
});
test('updates execute exact validated npm arguments and preserve config', async () => {
  const calls: string[][] = [];
  const options = { current: '0.1.0', latest: () => latestRelease(mock(release())), print: () => {}, install: true, global: async () => true, execute: async (args: string[]) => { calls.push(args); return ''; } };
  await checkUpdate(options);
  assert.deepEqual(calls, [['install','-g','github:rflx/saf-cli-tester#v0.2.0']]);
  await checkUpdate({ ...options, current: '0.2.0' });
  await checkUpdate({ ...options, current: '0.3.0' });
  assert.equal(calls.length,1);
  await assert.rejects(checkUpdate({ ...options, latest: async () => ({ tag:'v1.2.3$(evil)',version:'1.2.3' }) }), /INVALID_TAG/);
  assert.equal(calls.length,1);
  await assert.rejects(checkUpdate({ ...options, global: async () => false }), /development checkout/);
  await assert.rejects(checkUpdate({ ...options, execute: async () => { throw new Error('UPDATE_INSTALL_ERROR: npm permission failure'); } }), /npm permission failure/);
  await assert.rejects(checkUpdate({ ...options, execute: async () => { throw new Error('UPDATE_INTERRUPTED: npm stopped'); } }), /UPDATE_INTERRUPTED/);
  assert.equal(await isGlobalInstallation(async () => { throw new Error('must not execute'); }), false);
  assert.doesNotMatch(readFileSync(join(packageRoot,'src/updates.ts'),'utf8'), /writeFile|mkdir|configPaths|shell: true|sudo/);
});
