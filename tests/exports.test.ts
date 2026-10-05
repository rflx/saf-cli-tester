import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { requestFlags, pollFlags, runRequest } from '../src/cli/commands/rest-request.js';
import { RunExports, exportFormat } from '../src/logging/exports.js';
import { Redactor } from '../src/logging/redactor.js';
import { StatsCollector } from '../src/stats/collector.js';

test('request CLI preserves JSONL-only behavior and supports all export modes and custom paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saf-exports-'));
  const previousExit = process.exitCode;
  try {
    for (const format of [undefined, 'csv', 'summary', 'both']) {
      const config = join(root, format ?? 'none');
      await mkdir(join(config, 'profiles'), { recursive: true });
      await writeFile(join(config, 'profiles/test.yaml'), JSON.stringify({ name: 'test', environment: 'IAT', rest: { baseUrl: 'https://example.invalid' }, auth: { mode: 'oauth2', clientId: 'test-client', clientSecret: 'test-secret', tokenEndpoint: 'https://127.0.0.1:1/token' } }));
      const program = new Command().option('--config-dir <path>', '', config);
      const polling = format === 'both';
      const command = pollFlags(requestFlags(program.command('request')));
      await program.parseAsync(['request', '--profile', 'test', '--path', '/example?token=test-secret', ...(format ? ['--export', format] : []), ...(polling ? ['--count', '2', '--interval', '0.001'] : [])], { from: 'user' });
      await runRequest(program, command.opts(), new Redactor(), polling);
      const files = await readdir(join(config, 'logs'));
      assert.equal(files.filter(f => f.endsWith('.jsonl')).length, 1);
      assert.equal(files.length, format === 'both' ? 3 : format ? 2 : 1);
      for (const file of files) {
        const content = await readFile(join(config, 'logs', file), 'utf8');
        assert.ok(!content.includes('test-secret'));
        if (file.endsWith('.csv')) { assert.equal(content.split('\r\n').length, polling ? 4 : 3); assert.match(content, /failure,AUTH_ERROR/); assert.ok(!content.includes('?token')); }
        if (file.endsWith('.summary.json')) { const summary = JSON.parse(content); assert.equal(summary.requests, polling ? 2 : 1); assert.equal(summary.successful, 0); assert.equal(summary.profile, 'test'); assert.ok(summary.startTime <= summary.endTime); }
      }
    }
    for (const format of ['csv', 'summary', 'both'] as const) {
      const output = join(root, 'custom', format);
      const exports = await RunExports.open(format, output, root, 'run', new Redactor());
      await exports!.summary({ runId: 'run', profile: 'test', environment: 'IAT', startTime: 'start', endTime: 'end' }, new StatsCollector().summary());
      await exports!.close();
      assert.equal((await stat(output)).isDirectory(), format === 'both');
      if (format === 'both') assert.deepEqual((await readdir(output)).sort(), ['run.csv', 'run.summary.json']);
    }
  } finally { process.exitCode = previousExit; await rm(root, { recursive: true, force: true }); }
});

test('CSV allowlist, escaping, IDs, failed rows, redaction and summary metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saf-export-data-'));
  try {
    const redactor = new Redactor(); redactor.add('hidden');
    const exports = await RunExports.open('both', undefined, root, 'run', redactor);
    const stats = new StatsCollector();
    const samples = [{ statusCode: 200, durationMs: 10, result: 'success' }, { statusCode: 404, durationMs: 20, result: 'failure' }, { statusCode: 500, durationMs: 30, result: 'failure' }, { durationMs: 40, result: 'failure', errorType: 'TIMEOUT' }];
    for (const [index, sample] of samples.entries()) {
      stats.add(sample);
      await exports!.record({ timestamp: 'now', runId: 'run', sequenceNumber: index + 1, profile: 'test', environment: 'IAT', method: 'GET', path: '/hidden', ...sample, requestId: 'id,"quoted"', correlationId: ['first', 'hidden'], authorization: 'Bearer hidden', body: 'payload-never-exported', certificate: 'certificate-never-exported', responseBody: 'response-never-exported' });
    }
    await exports!.summary({ runId: 'run', profile: 'hidden', environment: 'IAT', startTime: 'start', endTime: 'end' }, stats.summary());
    await exports!.close();
    const csv = await readFile(join(root, 'run.csv'), 'utf8');
    assert.equal(csv.split('\r\n').length, 6);
    assert.match(csv, /"id,""quoted"""/); assert.match(csv, /first/); assert.match(csv, /failure,TIMEOUT/);
    for (const value of ['hidden', 'payload-never-exported', 'certificate-never-exported', 'response-never-exported', 'authorization']) assert.ok(!csv.includes(value));
    const summary = JSON.parse(await readFile(join(root, 'run.summary.json'), 'utf8'));
    assert.deepEqual(summary, { runId: 'run', profile: '[REDACTED]', environment: 'IAT', startTime: 'start', endTime: 'end', requests: 4, successful: 1, fourXX: 1, fiveXX: 1, http500: 1, timeouts: 1, successRate: 25, fiveXXRate: 25, latency: { min: 10, avg: 25, p50: 20, p95: 40, max: 40 } });
    assert.equal((await stat(join(root, 'run.csv'))).mode & 0o777, 0o600);
    await assert.rejects(RunExports.open('csv', undefined, root, 'run', redactor), /EEXIST/);
    assert.equal(await RunExports.open(undefined, undefined, root, 'none', redactor), undefined);
    await assert.rejects(RunExports.open(undefined, root, root, 'none', redactor), /requires --export/);
    assert.throws(() => exportFormat('xml'), /csv, summary or both/);
    await assert.rejects(RunExports.open('csv', undefined, join(process.cwd(), 'logs'), 'blocked', redactor), /outside Git repositories/);
    await symlink(process.cwd(), join(root, 'checkout'));
    await assert.rejects(RunExports.open('csv', undefined, join(root, 'checkout', 'logs'), 'blocked', redactor), /outside Git repositories/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
