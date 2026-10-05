import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { profileSchema } from '../src/profiles/types.js';
import { validateProfile } from '../src/profiles/validator.js';
import { loadProfile } from '../src/profiles/loader.js';
import { Redactor } from '../src/logging/redactor.js';
import { Logger } from '../src/logging/logger.js';
import { openLog } from '../src/logging/jsonl.js';
import { OAuth2AuthProvider } from '../src/auth/oauth2.js';

const password = 'dummy-direct-secret +/"\\';
const base = { name: 'direct', environment: 'IAT', rest: { baseUrl: 'https://example.invalid' } };
const common = { mode: 'oauth2', tokenEndpoint: 'https://example.invalid/token' };
const direct = { ...base, auth: { ...common, clientId: 'dummy-client', clientSecret: password } };

test('OAuth credential schema accepts complete direct or environment pairs only', async () => {
  await validateProfile(profileSchema.parse(direct));
  process.env.PROFILE_TEST_ID = 'dummy-id'; process.env.PROFILE_TEST_SECRET = 'dummy-env-secret';
  try {
    const env = { clientIdEnv: 'PROFILE_TEST_ID', clientSecretEnv: 'PROFILE_TEST_SECRET' };
    await validateProfile(profileSchema.parse({ ...base, auth: { ...common, ...env } }));
    for (const credentials of [{}, {clientId:'id'}, {clientSecret:password}, {clientIdEnv:env.clientIdEnv}, {clientSecretEnv:env.clientSecretEnv}, {clientId:'',clientSecret:password}, {clientId:'id',clientSecret:''}, {...direct.auth,...env}, {...direct.auth,clientIdEnv:env.clientIdEnv}, {...env,clientSecret:password}, {clientId:'id',clientSecretEnv:env.clientSecretEnv}]) {
      assert.equal(profileSchema.safeParse({...base,auth:{...common,...credentials}}).success,false);
    }
  } finally { delete process.env.PROFILE_TEST_ID; delete process.env.PROFILE_TEST_SECRET; }
});

test('direct credentials are used for both OAuth token authentication methods and errors are safe', async () => {
  for (const tokenAuthMethod of ['client_secret_basic','client_secret_post'] as const) {
    const p = profileSchema.parse({...direct,auth:{...direct.auth,tokenAuthMethod}});
    if (p.auth.mode !== 'oauth2') throw new Error();
    const r = new Redactor();
    const auth = new OAuth2AuthProvider(p.auth,r,async (_url,_method,headers,body) => {
      if (tokenAuthMethod === 'client_secret_basic') assert.equal(headers.Authorization,`Basic ${Buffer.from(`${encodeURIComponent('dummy-client')}:${encodeURIComponent(password)}`).toString('base64')}`);
      else assert.equal(new URLSearchParams(body).get('client_secret'),password);
      throw new Error(password);
    });
    await assert.rejects(auth.prepareRequest({timeoutMs:100}),error => error instanceof Error && !error.message.includes(password) && /AUTH_ERROR/.test(error.message));
    assert.equal(r.text(password),'[REDACTED]');
  }
});

test('loaded direct secrets are centrally redacted before authentication, including JSONL and errors', async () => {
  const dir = await mkdtemp(join(tmpdir(),'saf-direct-'));
  try {
    await writeFile(join(dir,'direct.yaml'),JSON.stringify(direct));
    const r = new Redactor(); await loadProfile(dir,'direct',r);
    assert.equal(r.text(password),'[REDACTED]');
    assert.deepEqual(r.sanitize(new Error(`failure ${password}`)),{name:'Error',message:'failure [REDACTED]'});
    assert.deepEqual(r.sanitize({note:password,auth:direct.auth}),{note:'[REDACTED]',auth:{...direct.auth,clientId:'[REDACTED]',clientSecret:'[REDACTED]'}});
    const fresh = new Redactor();
    assert.equal((fresh.sanitize({note:password,auth:direct.auth}) as {note:string}).note,'[REDACTED]');
    const logger = new Logger(r,await openLog(dir,'run'));
    await logger.record({note:password,error:new Error(password),clientSecret:password}); await logger.close();
    const output = await readFile(join(dir,'run.jsonl'),'utf8');
    assert.ok(!output.includes(JSON.stringify(password).slice(1,-1))); assert.match(output,/\[REDACTED\]/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('profiles show and validate support direct YAML and never disclose secrets in errors', async () => {
  const dir = await mkdtemp(join(tmpdir(),'saf-direct-cli-'));
  const cli = fileURLToPath(new URL('../src/cli/index.js',import.meta.url));
  const run = (command:string) => promisify(execFile)(process.execPath,[cli,'--config-dir',dir,'profiles',command,'direct']);
  try {
    await mkdir(join(dir,'profiles'));
    await writeFile(join(dir,'profiles','direct.yaml'),`name: direct\nenvironment: IAT\nrest:\n  baseUrl: https://example.invalid\nauth:\n  mode: oauth2\n  tokenEndpoint: https://example.invalid/token\n  clientId: dummy-client\n  clientSecret: ${JSON.stringify(password)}\n`);
    const shown = await run('show');
    assert.equal(JSON.parse(shown.stdout).auth.clientSecret,'[REDACTED]'); assert.equal(shown.stderr,'');
    assert.equal(JSON.parse((await run('validate')).stdout).validation,'OK');
    await writeFile(join(dir,'profiles','direct.yaml'),JSON.stringify({...direct,auth:{...direct.auth,clientIdEnv:'PROFILE_TEST_ID'}}));
    await assert.rejects(run('validate'), error => {
      const result = error as {stdout:string;stderr:string};
      assert.match(result.stderr,/CONFIG_ERROR/); assert.ok(!result.stderr.includes(password)); assert.ok(!result.stderr.includes(JSON.stringify(password).slice(1,-1))); return true;
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});
