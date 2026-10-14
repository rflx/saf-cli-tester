import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { packageRoot } from './version.js';

export type ResourceKind = 'profile' | 'request' | 'template';
export const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export function validateLocalName(name: string, kind: string): void {
  if (!safeName.test(name)) throw new Error(`CONFIG_ERROR: Invalid ${kind} name`);
}

// Dirent checks exclude symlinks; realpath containment also protects reads.
export async function discoverResources(kind: ResourceKind, root = join(packageRoot, kind === 'template' ? 'templates' : 'examples')): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (kind === 'template') {
        if (entry.isDirectory() && safeName.test(entry.name)) await walk(join(directory, entry.name), `${prefix}${entry.name}/`);
        else if (entry.isFile() && prefix && entry.name.endsWith('.yaml') && safeName.test(entry.name.slice(0, -5))) found.set(`${prefix}${entry.name.slice(0, -5)}`, join(directory, entry.name));
      } else if (entry.isFile()) {
        const match = entry.name.match(kind === 'profile' ? /^profile\.([a-zA-Z0-9][a-zA-Z0-9_-]*)\.example\.yaml$/ : /^request(?:\.([a-zA-Z0-9][a-zA-Z0-9_-]*))?\.example\.yaml$/);
        if (match) {
          const name = match[1] ?? 'request';
          if (found.has(name)) throw new Error('CONFIG_ERROR: Duplicate bundled example name');
          found.set(name, join(directory, entry.name));
        }
      }
    }
  }
  await walk(root);
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

export async function resolveResource(kind: ResourceKind, name: string): Promise<string> {
  const parts = name.split('/');
  if (kind === 'template' ? parts.length < 2 || !parts.every(part => safeName.test(part)) : !safeName.test(name)) throw new Error('CONFIG_ERROR: Invalid bundled resource name');
  const path = (await discoverResources(kind)).get(name);
  if (!path) throw new Error(`CONFIG_ERROR: Unknown ${kind} ${name}; list available bundled resources first`);
  const root = await realpath(join(packageRoot, kind === 'template' ? 'templates' : 'examples'));
  const target = await realpath(path);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('CONFIG_ERROR: Unsafe bundled resource path');
  return target;
}

export async function readResource(kind: ResourceKind, name: string): Promise<string> {
  return readFile(await resolveResource(kind, name), 'utf8');
}
