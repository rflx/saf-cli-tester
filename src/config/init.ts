import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, isScalar, stringify } from 'yaml';
import { configPaths } from './paths.js';
import { configSchema } from './schema.js';
import { readResource, validateLocalName } from '../resources.js';

async function createLocalFile(root: string | undefined, path: string, content: string): Promise<string> {
  const paths = configPaths(root);
  for (const directory of [paths.base, paths.profiles, paths.requests, paths.certificates]) await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`CONFIG_ERROR: Destination already exists: ${path}`);
    throw error;
  }
  return path;
}

export async function initProfile(root: string | undefined, name: string, example: string): Promise<string> {
  validateLocalName(name, 'profile');
  const source = await readResource('profile', example);
  // Change only the scalar's source range, keeping comments and formatting intact.
  const document = parseDocument(source);
  const node = document.get('name', true);
  if (document.errors.length || !isScalar(node) || !node.range) throw new Error('CONFIG_ERROR: Bundled profile must contain a scalar name');
  const content = source.slice(0, node.range[0]) + JSON.stringify(name) + source.slice(node.range[1]);
  return createLocalFile(root, join(configPaths(root).profiles, `${name}.yaml`), content);
}

export async function initRequest(root: string | undefined, name: string, options: { example?: string; template?: string }): Promise<string> {
  validateLocalName(name, 'request');
  if (!!options.example === !!options.template) throw new Error('CONFIG_ERROR: Provide exactly one of --example or --template');
  const content = await readResource(options.example ? 'request' : 'template', options.example ?? options.template!);
  return createLocalFile(root, join(configPaths(root).requests, `${name}.yaml`), content);
}

export async function initConfig(root?: string): Promise<string> {
  const content = '# Optional application settings. Delete this file to restore default-only behavior.\n# REST timeout and diagnostic body limit are in milliseconds and bytes respectively.\n# Polling interval is in seconds.\n' + stringify(configSchema.parse({}));
  return createLocalFile(root, configPaths(root).config, content);
}
