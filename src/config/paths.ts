import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export function expandPath(path: string): string {
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}
export function configPaths(root = '~/.config/saf-cli-tester') {
  const base = expandPath(root);
  return { base, config: join(base, 'config.yaml'), profiles: join(base, 'profiles'), secrets: join(base, 'secrets'), certificates: join(base, 'certificates'), requests: join(base, 'requests'), logs: join(base, 'logs') };
}
