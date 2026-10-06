import type { OAuth2Credential } from '../profiles/types.js';
import { oauthCredentials } from '../profiles/validator.js';
import { httpsUrl } from '../config/schema.js';
import { send } from '../rest/client.js';
import type { Redactor } from '../logging/redactor.js';
import type { AuthProvider, RequestContext } from './types.js';

export interface OAuth2Diagnostics {
  stage: 'discovery' | 'token';
  statusCode: number;
  error?: string;
  error_description?: string;
}
export class OAuth2AuthError extends Error {
  constructor(readonly diagnostics?: OAuth2Diagnostics) {
    super(`AUTH_ERROR: OAuth discovery or token acquisition failed; check endpoint, scope and credentials${diagnostics ? `; ${JSON.stringify(diagnostics)}` : ''}`);
  }
}

export class OAuth2AuthProvider implements AuthProvider {
  private token?: string;
  private expiresAt = 0;
  private endpoint?: string;
  constructor(private readonly auth: OAuth2Credential, private readonly redactor: Redactor, private readonly transport = send, private readonly clock = Date.now) {}
  private httpError(stage: OAuth2Diagnostics['stage'], response: { status: number; body: string }) {
    const diagnostics: OAuth2Diagnostics = { stage, statusCode: response.status };
    try {
      const data: unknown = JSON.parse(response.body);
      this.redactor.register(data);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const key of ['error', 'error_description'] as const) {
          const value = (data as Record<string, unknown>)[key];
          if (typeof value === 'string') diagnostics[key] = this.redactor.text(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1024);
        }
      }
    } catch { /* Non-JSON bodies are never included in diagnostics. */ }
    return new OAuth2AuthError(diagnostics);
  }
  async prepareRequest(context: RequestContext) {
    if (!this.token || this.clock() >= this.expiresAt) {
      const { id, password } = oauthCredentials(this.auth);
      this.redactor.register({ clientId: id, clientSecret: password });
      try {
        if (!this.endpoint) {
          if (this.auth.tokenEndpoint) this.endpoint = this.auth.tokenEndpoint;
          else {
            const discovery = await this.transport(new URL(this.auth.openIdConfigurationUrl!), 'GET', { Accept: 'application/json' }, undefined, context.timeoutMs, {}, context.signal);
            if (discovery.status !== 200) throw this.httpError('discovery', discovery);
            this.endpoint = httpsUrl.parse(JSON.parse(discovery.body).token_endpoint);
          }
        }
        const form = new URLSearchParams({ grant_type: 'client_credentials' });
        const headers: Record<string,string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (this.auth.scope) form.set('scope', this.auth.scope);
        if (this.auth.tokenAuthMethod === 'client_secret_post') { form.set('client_id', id); form.set('client_secret', password); }
        else { headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(password)}`).toString('base64')}`; this.redactor.add(headers.Authorization); }
        const response = await this.transport(new URL(this.endpoint), 'POST', headers, form.toString(), context.timeoutMs, {}, context.signal);
        if (response.status !== 200) throw this.httpError('token', response);
        const data = JSON.parse(response.body) as Record<string, unknown>;
        this.redactor.register(data);
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') throw new Error();
        this.token = data.access_token; this.redactor.add(this.token);
        this.expiresAt = this.clock() + data.expires_in * 1000 - Math.min(30000, data.expires_in * 100);
      } catch (error) { throw error instanceof OAuth2AuthError ? error : new OAuth2AuthError(); }
    }
    return { headers: { Authorization: `Bearer ${this.token}` } };
  }
}
