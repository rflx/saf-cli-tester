import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { expandPath } from '../config/paths.js';
import type { Profile } from './types.js';

export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_ERROR: Missing environment variable ${name}`);
  return value;
}
export async function validateProfile(profile: Profile): Promise<void> {
  if (profile.auth.mode === 'oauth2') {
    secret(profile.auth.clientIdEnv); secret(profile.auth.clientSecretEnv);
  } else {
    const passphrase = secret(profile.auth.p12PasswordEnv);
    let pfx: Buffer;
    try { pfx = await readFile(expandPath(profile.auth.p12Path)); }
    catch { throw new Error('CONFIG_ERROR: Cannot read configured PKCS#12 certificate'); }
    try { createSecureContext({ pfx, passphrase }); }
    catch { throw new Error('CONFIG_ERROR: Cannot use PKCS#12 certificate/password combination'); }
  }
}
