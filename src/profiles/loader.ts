import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readYaml } from '../config/loader.js';
import type { Redactor } from '../logging/redactor.js';
import { profileSchema } from './types.js';

export async function loadProfile(directory: string, name: string, redactor?: Redactor) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('CONFIG_ERROR: Invalid profile name');
  try {
    const raw = await readYaml(join(directory, `${name}.yaml`));
    redactor?.register(raw);
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'profile'}: ${issue.code === 'custom' ? issue.message : issue.path.join('.') === 'kafka.auth.mode' ? 'Kafka supports mTLS only; use mode: mtls and credential: mtls' : 'Invalid or missing configuration; check field type and allowed values'}`).join('; ');
      throw new Error(`CONFIG_ERROR: Invalid profile ${name}; ${issues}`);
    }
    const profile = parsed.data;
    redactor?.register(profile);
    if (profile.name !== name) throw new Error();
    return profile;
  } catch (error) { if (error instanceof Error && error.message.startsWith('CONFIG_ERROR: Invalid profile')) throw error; throw new Error(`CONFIG_ERROR: Cannot load profile ${name}; check its name, YAML and required fields`); }
}
export async function listProfiles(directory: string, redactor?: Redactor) {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('CONFIG_ERROR: Cannot read profiles directory');
  }
  return Promise.all(names.filter(n => n.endsWith('.yaml')).sort().map(n => loadProfile(directory, n.slice(0, -5), redactor)));
}
