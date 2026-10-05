import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { expandPath } from '../config/paths.js';
import { secret } from '../profiles/validator.js';
import type { Profile } from '../profiles/types.js';
import type { Redactor } from '../logging/redactor.js';
import type { AuthProvider, AuthResult } from './types.js';
export class MtlsAuthProvider implements AuthProvider {
  private result?: AuthResult;
  constructor(private readonly auth: Extract<Profile['auth'], {mode:'mtls'}>, private readonly redactor: Redactor) {}
  async prepareRequest(): Promise<AuthResult> {
    if (!this.result) {
      const passphrase = secret(this.auth.p12PasswordEnv); this.redactor.add(passphrase);
      let pfx: Buffer;
      try { pfx = await readFile(expandPath(this.auth.p12Path)); }
      catch { throw new Error('AUTH_ERROR: Cannot read configured PKCS#12 certificate'); }
      try { createSecureContext({ pfx, passphrase }); }
      catch { throw new Error('AUTH_ERROR: Cannot use PKCS#12 certificate/password combination'); }
      this.result = { headers: {}, tls: { pfx, passphrase } };
    }
    return this.result;
  }
}
