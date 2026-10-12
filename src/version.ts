import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locate our own package, including the nested dist-tests/src test build.
let root = dirname(fileURLToPath(import.meta.url));
while (true) {
  try {
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (metadata.name === 'saf-cli-tester' && typeof metadata.version === 'string') break;
  } catch { /* Continue towards the package root. */ }
  const parent = dirname(root);
  if (parent === root) throw new Error('VERSION_ERROR: SAF CLI Tester package metadata not found');
  root = parent;
}
export const packageRoot = root;
export const toolVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
