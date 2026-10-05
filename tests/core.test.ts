import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { profileSchema, type Profile } from '../src/profiles/types.js';
import { configSchema } from '../src/config/schema.js';
import { loadProfile, listProfiles } from '../src/profiles/loader.js';
import { validateProfile } from '../src/profiles/validator.js';
import { configPaths } from '../src/config/paths.js';
import { Redactor } from '../src/logging/redactor.js';
import { Logger } from '../src/logging/logger.js';
import { openLog } from '../src/logging/jsonl.js';
import { readFile } from 'node:fs/promises';
import { resolveRequest, enforceProdSafety, executeRequest } from '../src/rest/request.js';
import { send } from '../src/rest/client.js';
import { durationMs, poll } from '../src/rest/poller.js';
import { classifyError } from '../src/diagnostics/errors.js';
import { StatsCollector } from '../src/stats/collector.js';
import { OAuth2AuthProvider } from '../src/auth/oauth2.js';
import { MtlsAuthProvider } from '../src/auth/mtls.js';
import { loadTemplate } from '../src/requests/loader.js';
import { loadConfig } from '../src/config/loader.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const raw = { name:'test-iat', environment:'IAT', rest:{baseUrl:'https://example.invalid'}, auth:{mode:'oauth2', clientIdEnv:'TEST_SAF_ID', clientSecretEnv:'TEST_SAF_SECRET', tokenEndpoint:'https://example.invalid/token'} };
const profile = () => profileSchema.parse(raw);
async function temporary(task: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(),'saf-test-'));
  try { await task(dir); } finally { await rm(dir,{recursive:true,force:true}); }
}
test('strict profile parsing requires a bound environment and HTTPS', () => {
  assert.equal(profile().environment,'IAT');
  for (const invalid of [{...raw,environment:undefined}, {...raw,environment:'DEV'}, {...raw,env:'PROD'}, {...raw,rest:{baseUrl:'http://example.invalid'}}, {...raw,auth:{...raw.auth,clientSecret:'unsafe'}}]) assert.equal(profileSchema.safeParse(invalid).success,false);
});
test('profile loading, listing, path traversal and name binding', async () => temporary(async dir => {
  await writeFile(join(dir,'test-iat.yaml'), JSON.stringify(raw));
  assert.equal((await loadProfile(dir,'test-iat')).name,'test-iat');
  assert.equal((await listProfiles(dir)).length,1);
  await assert.rejects(loadProfile(dir,'../test-iat'));
  await writeFile(join(dir,'other.yaml'), JSON.stringify(raw));
  await assert.rejects(loadProfile(dir,'other'));
}));
test('configuration precedence and profile environment cannot be overridden', () => {
  const p = profile(); p.rest.timeoutMs = 2000; p.rest.headers = {Accept:'profile'};
  const config = configSchema.parse({rest:{timeoutMs:1000,headers:{A:'default'}}});
  const request = resolveRequest(config,p,{path:'/a',timeoutMs:3000,headers:{B:'template'}},{timeoutMs:4000,headers:{C:'cli'}});
  assert.equal(request.timeoutMs,4000); assert.deepEqual(request.headers,{a:'default',accept:'profile',b:'template',c:'cli'});
  assert.equal(resolveRequest(config,p,{path:'/a'}).timeoutMs,2000); assert.equal(p.environment,'IAT');
});
test('origin constraints, reserved headers and invalid body combinations', () => {
  for (const path of ['//evil.invalid/a','/\\evil.invalid/a','https://evil.invalid/a','/a#fragment']) assert.throws(() => resolveRequest(configSchema.parse({}),profile(),{path}));
  assert.throws(() => resolveRequest(configSchema.parse({}),profile(),{path:'/a',headers:{Authorization:'secret'}}));
  assert.throws(() => resolveRequest(configSchema.parse({}),profile(),{path:'/a',body:'x'}));
});
test('PROD writes are blocked before authentication', async () => {
  const p = profile(); p.environment = 'PROD';
  for (const method of ['POST','PUT','PATCH','DELETE']) { assert.throws(() => enforceProdSafety(p,method,false)); enforceProdSafety(p,method,true); }
  for (const method of ['GET','HEAD','OPTIONS']) enforceProdSafety(p,method,false);
});
test('profile secret validation never reveals values', async () => {
  delete process.env.TEST_SAF_ID; delete process.env.TEST_SAF_SECRET;
  await assert.rejects(validateProfile(profile()), /Missing environment variable TEST_SAF_ID/);
  process.env.TEST_SAF_ID = 'fake-id'; process.env.TEST_SAF_SECRET = 'fake-password';
  await validateProfile(profile());
});
test('recursive case-insensitive redaction, known values, buffers and cycles', () => {
  const r = new Redactor(); r.add('fake-password');
  assert.deepEqual(r.sanitize({AUTHORIZATION:'Bearer abc',nested:[{client_secret:'abc',note:'fake-password'}],pfx:Buffer.from('abc')}),{AUTHORIZATION:'[REDACTED]',nested:[{client_secret:'[REDACTED]',note:'[REDACTED]'}],pfx:'[REDACTED]'});
  const circular: Record<string,unknown> = {}; circular.self = circular;
  assert.deepEqual(r.sanitize(circular),{self:'[Circular]'});
  assert.equal(r.text('Bearer abc'),'Bearer [REDACTED]');
});
test('JSONL logs are sanitized and created with private permissions', async () => temporary(async dir => {
  const logger = new Logger(new Redactor(),await openLog(dir,'run'));
  await logger.record({password:'hidden',statusCode:500}); await logger.close();
  assert.equal((await stat(join(dir,'run.jsonl'))).mode & 0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'run.jsonl'),'utf8')),{password:'[REDACTED]',statusCode:500});
}));
test('OAuth discovery, credentials, caching and automatic expiry refresh', async () => {
  process.env.TEST_SAF_ID='fake-id'; process.env.TEST_SAF_SECRET='fake-password';
  let calls = 0; let now = 0; const r = new Redactor();
  const p = profile(); if (p.auth.mode !== 'oauth2') throw new Error();
  delete p.auth.tokenEndpoint; p.auth.openIdConfigurationUrl='https://example.invalid/discovery';
  const auth = new OAuth2AuthProvider(p.auth,r,async (url,method,headers,body) => {
    calls++;
    if (url.pathname === '/discovery') return {status:200,headers:{},durationMs:1,body:JSON.stringify({token_endpoint:'https://example.invalid/token'})};
    assert.equal(method,'POST'); assert.match(headers.Authorization!,/^Basic /); assert.equal(body,'grant_type=client_credentials');
    return {status:200,headers:{},durationMs:1,body:JSON.stringify({access_token:`fake-token-${calls}`,token_type:'Bearer',expires_in:10})};
  },() => now);
  const first = await auth.prepareRequest({timeoutMs:100});
  assert.deepEqual(await auth.prepareRequest({timeoutMs:100}),first); assert.equal(calls,2);
  now = 10000; assert.notDeepEqual(await auth.prepareRequest({timeoutMs:100}),first); assert.equal(calls,3);
  assert.equal(r.text('fake-token-2 fake-password'),'[REDACTED] [REDACTED]');
});
test('OAuth failures do not expose token endpoint responses', async () => {
  const p = profile(); if (p.auth.mode !== 'oauth2') throw new Error();
  const auth = new OAuth2AuthProvider(p.auth,new Redactor(),async () => ({status:401,headers:{},body:'fake-password',durationMs:1}));
  await assert.rejects(auth.prepareRequest({timeoutMs:100}), error => error instanceof Error && error.message.startsWith('AUTH_ERROR') && !error.message.includes('fake-password'));
});
test('mTLS loads lazily and reports unreadable or invalid certificates safely', async () => temporary(async dir => {
  process.env.TEST_P12_PASSWORD='fake-cert-password';
  const p: Profile = {...profile(),auth:{mode:'mtls',p12Path:join(dir,'cert.p12'),p12PasswordEnv:'TEST_P12_PASSWORD'}};
  if (p.auth.mode !== 'mtls') throw new Error();
  const auth = new MtlsAuthProvider(p.auth,new Redactor());
  await assert.rejects(auth.prepareRequest(),/Cannot read/);
  await writeFile(p.auth.p12Path,'invalid-test-certificate');
  await assert.rejects(auth.prepareRequest(),/certificate\/password combination/);
}));
test('local HTTP results, no redirects, timeouts and correlation IDs', async () => {
  const server = createServer((req,res) => {
    if (req.url === '/slow') return;
    res.setHeader('x-request-id','test-request');
    if (req.url === '/redirect') {res.statusCode=302; res.setHeader('Location','/ok');}
    else res.statusCode=503;
    res.end('{"access_token":"should-not-be-recorded"}');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const url = new URL(`http://127.0.0.1:${address.port}/fail`);
  try {
    const request = {...resolveRequest(configSchema.parse({}),profile(),{path:'/fail'}),url};
    const result = await executeRequest({prepareRequest:async () => ({headers:{}})},request);
    assert.equal(result.errorType,'HTTP_503'); assert.equal('requestId' in result && result.requestId,'test-request'); assert.ok(!JSON.stringify(result).includes('should-not-be-recorded'));
    assert.equal((await send(new URL('/redirect',url),'GET',{},undefined,1000)).status,302);
    await assert.rejects(send(new URL('/slow',url),'GET',{},undefined,20),error => classifyError(error)==='TIMEOUT');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('diagnostic network classification', () => {
  for (const [code,expected] of [['ENOTFOUND','DNS_ERROR'],['EAI_AGAIN','DNS_ERROR'],['ECONNRESET','CONNECTION_RESET'],['CERT_HAS_EXPIRED','TLS_ERROR'],['ETIMEDOUT','TIMEOUT']]) assert.equal(classifyError({code}),expected);
});
test('poll starts immediately, respects count and avoids overlap with slow calls', async () => {
  let now=0; const sequences:number[]=[]; const delays:number[]=[];
  await poll(async n => {sequences.push(n); now += n === 1 ? 150 : 20;},{intervalMs:100,count:3},() => now,async ms => {delays.push(ms); now+=ms;});
  assert.deepEqual(sequences,[1,2,3]); assert.deepEqual(delays,[0,80]);
});
test('poll duration and cancellation, duration validation', async () => {
  let now=0; let calls=0;
  await poll(async () => {calls++;},{intervalMs:100,durationMs:250},() => now,async ms => {now+=ms;}); assert.equal(calls,3);
  const controller = new AbortController();
  await poll(async () => controller.abort(),{intervalMs:100,count:3,signal:controller.signal});
  assert.equal(durationMs('2h'),7200000); assert.throws(() => durationMs('0s')); assert.throws(() => durationMs('invalid'));
});
test('statistics include failure buckets and nearest-rank percentiles', () => {
  const stats = new StatsCollector(); assert.equal(stats.summary().requests,0);
  stats.add({statusCode:200,durationMs:10,result:'success'});stats.add({statusCode:500,durationMs:20,result:'failure'});stats.add({durationMs:30,result:'failure',errorType:'TIMEOUT'});stats.add({statusCode:404,durationMs:40,result:'failure'});
  const result = stats.summary(); assert.equal(result.successRate,25);assert.equal(result.fiveXXRate,25);assert.equal(result.timeouts,1);assert.equal(result.fourXX,1);
  assert.deepEqual(result.latency,{min:10,avg:25,p50:20,p95:40,max:40});
});
test('template body file paths are relative to template and config path expands home', async () => temporary(async dir => {
  await writeFile(join(dir,'request.yaml'),'request:\n  method: POST\n  path: /test\n  bodyFile: payload.json\npoll:\n  intervalSeconds: 60\n  count: 2\n');
  const template = await loadTemplate(join(dir,'request.yaml')); assert.equal(template.request.bodyFile,join(dir,'payload.json'));
  assert.ok(configPaths().base.endsWith('/.config/saf-cli-tester'));
}));
test('missing application config uses defaults, malformed or unknown fields fail', async () => temporary(async dir => {
  const path = join(dir,'config.yaml'); assert.equal((await loadConfig(path)).rest.timeoutMs,30000);
  await writeFile(path,'rest: [invalid'); await assert.rejects(loadConfig(path),/CONFIG_ERROR/);
  await writeFile(path,'environment: PROD'); await assert.rejects(loadConfig(path),/CONFIG_ERROR/);
}));
test('header precedence is case insensitive', () => {
  const request = resolveRequest(configSchema.parse({rest:{headers:{Accept:'default'}}}),profile(),{path:'/test',headers:{ACCEPT:'template'}},{headers:{accept:'cli'}});
  assert.deepEqual(request.headers,{accept:'cli'});
});
test('OAuth post authentication and invalid expiry', async () => {
  const p = profile(); if (p.auth.mode !== 'oauth2') throw new Error(); p.auth.tokenAuthMethod='client_secret_post';
  process.env.TEST_SAF_ID='fake-id'; process.env.TEST_SAF_SECRET='fake-password';
  const auth = new OAuth2AuthProvider(p.auth,new Redactor(),async (_url,_method,headers,body) => {
    assert.equal(headers.Authorization,undefined); const form = new URLSearchParams(body);
    assert.equal(form.get('client_id'),'fake-id'); assert.equal(form.get('client_secret'),'fake-password');
    return {status:200,headers:{},body:JSON.stringify({token_type:'Bearer',access_token:'fake-token',expires_in:-1}),durationMs:1};
  });
  await assert.rejects(auth.prepareRequest({timeoutMs:100}),/AUTH_ERROR/);
});
test('CLI refuses PROD write before certificate reads or log creation', async () => temporary(async dir => {
  await mkdir(join(dir,'profiles'));
  await writeFile(join(dir,'profiles','test-prod.yaml'),JSON.stringify({...raw,name:'test-prod',environment:'PROD',auth:{mode:'mtls',p12Path:join(dir,'absent.p12'),p12PasswordEnv:'TEST_ABSENT_PASSWORD'}}));
  const cli = fileURLToPath(new URL('../src/cli/index.js',import.meta.url));
  try {
    await promisify(execFile)(process.execPath,[cli,'--config-dir',dir,'rest','request','--profile','test-prod','--method','POST','--path','/test']);
    assert.fail('Expected CLI to reject PROD write');
  } catch (error) {
    assert.match((error as {stderr:string}).stderr,/PROD writes require --allow-prod-write/);
    assert.equal((error as {code:number}).code,1);
  }
  await assert.rejects(stat(join(dir,'logs')), {code:'ENOENT'});
}));
