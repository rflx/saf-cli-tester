const sensitive = /^(authorization|proxyauthorization|cookie|setcookie|clientsecret|clientid|accesstoken|refreshtoken|password|p12password|privatekey|certificate|certificatecontents|pfx|passphrase|secret|token|apikey|xapikey)$/i;
export class Redactor {
  private readonly secrets = new Set<string>();
  add(value: string) { if (value) this.secrets.add(value); }
  register(value: unknown, seen = new WeakSet<object>()): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (sensitive.test(key.replace(/[-_]/g, '')) && typeof child === 'string') {
        this.add(child);
        this.add(encodeURIComponent(child));
        this.add(new URLSearchParams({ value: child }).toString().slice(6));
        this.add(JSON.stringify(child).slice(1, -1));
      }
      this.register(child, seen);
    }
  }
  text(value: string): string {
    let result = value.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]');
    for (const secret of [...this.secrets].sort((a,b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
    this.register(value);
    if (typeof value === 'string') return this.text(value);
    if (value instanceof Error) return { name: value.name, message: this.text(value.message) };
    if (Buffer.isBuffer(value)) return '[REDACTED]';
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'; seen.add(value);
      if (Array.isArray(value)) return value.map(v => this.sanitize(v, seen));
      return Object.fromEntries(Object.entries(value).map(([key,v]) => [key, sensitive.test(key.replace(/[-_]/g, '')) ? '[REDACTED]' : this.sanitize(v, seen)]));
    }
    return value;
  }
}
