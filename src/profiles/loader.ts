import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readYaml } from '../config/loader.js';
import { profileSchema } from './types.js';

export async function loadProfile(directory: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('CONFIG_ERROR: Invalid profile name');
  try {
    const profile = profileSchema.parse(await readYaml(join(directory, `${name}.yaml`)));
    if (profile.name !== name) throw new Error();
    return profile;
  } catch { throw new Error(`CONFIG_ERROR: Cannot load profile ${name}; check its name, YAML and required fields`); }
}
export async function listProfiles(directory: string) {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('CONFIG_ERROR: Cannot read profiles directory');
  }
  return Promise.all(names.filter(n => n.endsWith('.yaml')).sort().map(n => loadProfile(directory, n.slice(0, -5))));
}
