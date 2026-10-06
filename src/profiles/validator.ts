import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { expandPath } from '../config/paths.js';
import type { Profile, OAuth2Credential, MtlsCredential, SharedCredential } from './types.js';

export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_ERROR: Missing environment variable ${name}`);
  return value;
}
export function sharedCredential(auth: SharedCredential | undefined, key: 'licenceKey' | 'password'): string {
  const value = auth?.[key] ?? (auth?.[`${key}Env`] ? process.env[auth[`${key}Env`]!] : undefined);
  if (!value || !value.trim()) throw new Error(`CONFIG_ERROR: Missing profile credential: credentials.shared.${key}`);
  return value;
}
export function oauthCredentials(auth: OAuth2Credential) {
  return auth.clientId !== undefined && auth.clientSecret !== undefined
    ? { id: auth.clientId, password: auth.clientSecret }
    : { id: secret(auth.clientIdEnv!), password: secret(auth.clientSecretEnv!) };
}
export function p12Password(auth: MtlsCredential): string {
  return auth.p12Password !== undefined ? auth.p12Password : secret(auth.p12PasswordEnv!);
}
async function validateMtls(auth: MtlsCredential): Promise<void> {
  const passphrase = p12Password(auth);
  let pfx: Buffer;
  try { pfx = await readFile(expandPath(auth.p12Path)); }
  catch { throw new Error('CONFIG_ERROR: Cannot read credentials.mtls.p12Path; check the configured PKCS#12 certificate path'); }
  try { createSecureContext({ pfx, passphrase }); }
  catch { throw new Error('CONFIG_ERROR: Cannot use credentials.mtls PKCS#12 certificate/password combination; check p12Password or p12PasswordEnv'); }
}

export async function profileValidation(profile: Profile) {
  const errors: Partial<Record<'shared' | 'oauth2' | 'mtls', string>> = {};
  // Validate credentials independently and check shared certificate material once.
  for (const mode of ['shared', 'oauth2', 'mtls'] as const) {
    try {
      if (mode === 'shared' && profile.credentials.shared) { sharedCredential(profile.credentials.shared, 'licenceKey'); sharedCredential(profile.credentials.shared, 'password'); }
      if (mode === 'oauth2' && profile.credentials.oauth2) oauthCredentials(profile.credentials.oauth2);
      if (mode === 'mtls' && profile.credentials.mtls) await validateMtls(profile.credentials.mtls);
    } catch (error) { errors[mode] = (error as Error).message; }
  }
  const transport = (name: 'rest' | 'kafka') => {
    const auth = profile[name]?.auth;
    return { configured: !!auth, authentication: auth?.mode,
      validation: !auth ? 'not configured' : errors[auth.mode] ? 'FAILED' : name === 'kafka' ? 'OK (local only)' : 'OK',
      ...(auth && errors[auth.mode] ? { error: errors[auth.mode] } : {}) };
  };
  return {
    profile: profile.name, environment: profile.environment,
    credentials: { shared: profile.credentials.shared ? 'configured' : 'not configured', oauth2: profile.credentials.oauth2 ? 'configured' : 'not configured', mtls: profile.credentials.mtls ? 'configured' : 'not configured' },
    rest: transport('rest'), kafka: transport('kafka'),
    validation: Object.keys(errors).length ? 'FAILED' : 'OK', errors
  };
}
export async function validateProfile(profile: Profile): Promise<void> {
  const report = await profileValidation(profile);
  if (report.validation === 'FAILED') throw new Error(Object.values(report.errors).join('; '));
}
