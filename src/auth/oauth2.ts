import type { Profile } from '../profiles/types.js';
import { secret } from '../profiles/validator.js';
import { httpsUrl } from '../config/schema.js';
import { send } from '../rest/client.js';
import type { Redactor } from '../logging/redactor.js';
import type { AuthProvider, RequestContext } from './types.js';

export class OAuth2AuthProvider implements AuthProvider {
  private token?: string;
  private expiresAt = 0;
  private endpoint?: string;
  constructor(private readonly auth: Extract<Profile['auth'], {mode:'oauth2'}>, private readonly redactor: Redactor, private readonly transport = send, private readonly clock = Date.now) {}
  async prepareRequest(context: RequestContext) {
    if (!this.token || this.clock() >= this.expiresAt) {
      const id = secret(this.auth.clientIdEnv); const password = secret(this.auth.clientSecretEnv);
      this.redactor.add(id); this.redactor.add(password);
      try {
        if (!this.endpoint) {
          if (this.auth.tokenEndpoint) this.endpoint = this.auth.tokenEndpoint;
          else {
            const discovery = await this.transport(new URL(this.auth.openIdConfigurationUrl!), 'GET', { Accept: 'application/json' }, undefined, context.timeoutMs, {}, context.signal);
            if (discovery.status !== 200) throw new Error();
            this.endpoint = httpsUrl.parse(JSON.parse(discovery.body).token_endpoint);
          }
        }
        const form = new URLSearchParams({ grant_type: 'client_credentials' });
        const headers: Record<string,string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (this.auth.scope) form.set('scope', this.auth.scope);
        if (this.auth.tokenAuthMethod === 'client_secret_post') { form.set('client_id', id); form.set('client_secret', password); }
        else { headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(password)}`).toString('base64')}`; this.redactor.add(headers.Authorization); }
        const response = await this.transport(new URL(this.endpoint), 'POST', headers, form.toString(), context.timeoutMs, {}, context.signal);
        if (response.status !== 200) throw new Error();
        const data = JSON.parse(response.body) as Record<string, unknown>;
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') throw new Error();
        this.token = data.access_token; this.redactor.add(this.token);
        this.expiresAt = this.clock() + data.expires_in * 1000 - Math.min(30000, data.expires_in * 100);
      } catch { throw new Error('AUTH_ERROR: OAuth discovery or token acquisition failed; check endpoint and credentials'); }
    }
    return { headers: { Authorization: `Bearer ${this.token}` } };
  }
}
