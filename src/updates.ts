import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot, toolVersion } from './version.js';

const repository = 'rflx/saf-cli-tester';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a: string, b: string): number {
  if (!stable.test(a) || !stable.test(b)) throw new Error('UPDATE_INVALID_VERSION: Expected a stable SemVer version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function validateTag(tag: unknown): string {
  if (typeof tag !== 'string' || !tag.startsWith('v') || !stable.test(tag.slice(1))) {
    throw new Error('UPDATE_INVALID_TAG: Expected a stable release tag vX.Y.Z');
  }
  return tag;
}
export async function latestRelease(fetcher: typeof fetch = fetch, timeoutMs = 10000): Promise<{ tag: string; version: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
      signal: controller.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': `saf-cli-tester/${toolVersion}` }
    });
    if (response.status === 404) throw new Error('UPDATE_NO_RELEASE: No published release found');
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error('UPDATE_RATE_LIMIT: GitHub API rate limit reached; try later');
    if (!response.ok) throw new Error(`UPDATE_API_ERROR: GitHub returned HTTP ${response.status}`);
    let data: unknown;
    try { data = await response.json(); } catch { if (controller.signal.aborted) throw new Error('UPDATE_TIMEOUT: GitHub request timed out'); throw new Error('UPDATE_RESPONSE_ERROR: Malformed GitHub JSON'); }
    if (!data || typeof data !== 'object' || !('tag_name' in data) || !('draft' in data) || !('prerelease' in data) || data.draft !== false || data.prerelease !== false) throw new Error('UPDATE_RESPONSE_ERROR: Expected a published stable release');
    const tag = validateTag(data.tag_name);
    return { tag, version: tag.slice(1) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('UPDATE_TIMEOUT: GitHub request timed out');
    if (error instanceof Error && error.message.startsWith('UPDATE_')) throw error;
    throw new Error('UPDATE_NETWORK_ERROR: Cannot reach GitHub; check network and DNS');
  } finally { clearTimeout(timer); }
}

export type Execute = (args: string[], capture?: boolean) => Promise<string>;
export const executeNpm: Execute = (args, capture = false) => new Promise((resolve, reject) => {
  // npm.cmd requires a shell on Windows; refuse rather than interpolate remote input.
  if (process.platform === 'win32') { reject(new Error('UPDATE_INSTALL_ERROR: On Windows, run the documented npm install command manually')); return; }
  const child = spawn('npm', args, { shell: false, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.on('error', () => reject(new Error('UPDATE_INSTALL_ERROR: Could not execute npm; check your npm installation')));
  child.on('exit', (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(signal
    ? `UPDATE_INTERRUPTED: npm stopped by ${signal}`
    : `UPDATE_INSTALL_ERROR: npm exited with code ${code}; review npm output and installation permissions`)));
});
export async function isGlobalInstallation(execute: Execute = executeNpm, root = packageRoot): Promise<boolean> {
  if (existsSync(join(root, '.git')) || existsSync(join(root, 'src'))) return false;
  const globalRoot = await execute(['root', '-g'], true);
  try { return realpathSync(join(globalRoot, 'saf-cli-tester')) === realpathSync(root); } catch { return false; }
}
export async function checkUpdate(options: { current?: string; latest?: typeof latestRelease; print?: (value: string) => void; install?: boolean; global?: () => Promise<boolean>; execute?: Execute } = {}): Promise<void> {
  const current = options.current ?? toolVersion;
  const release = await (options.latest ?? latestRelease)();
  // Validate again at the execution boundary, even for injected release providers.
  validateTag(release.tag);
  if (release.version !== release.tag.slice(1)) throw new Error('UPDATE_INVALID_VERSION: Release version/tag mismatch');
  const comparison = compareVersions(current, release.version);
  const print = options.print ?? console.log;
  print(`Installed version: ${current}\nLatest version:    ${release.version}\n`);
  if (comparison >= 0) { print(comparison === 0 ? 'SAF CLI Tester is up to date.' : 'Installed version is newer than the latest published release.'); return; }
  if (!options.install) { print(`Update available: ${release.version}\n\nRun:\nsaf-cli-tester update`); return; }
  if (!await (options.global ?? isGlobalInstallation)()) throw new Error('UPDATE_INSTALLATION_ERROR: This CLI is running from a development checkout or a non-global installation. Use git pull / your normal development workflow, or install globally with npm.');
  print(`Installing ${current} → ${release.version} from ${release.tag}`);
  await (options.execute ?? executeNpm)(['install', '-g', `github:${repository}#${release.tag}`]);
  print(`Installed SAF CLI Tester ${release.version}.`);
}
