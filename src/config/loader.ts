import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { configSchema } from './schema.js';

export async function readYaml(path: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) { throw error; }
  try { return parse(source, { maxAliasCount: 50 }); } catch { throw new Error('CONFIG_ERROR: Invalid YAML'); }
}
export async function loadConfig(path: string) {
  try { return configSchema.parse(await readYaml(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({});
    throw new Error('CONFIG_ERROR: Invalid application configuration');
  }
}
