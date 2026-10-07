export function classifyError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (code === 'HTTP_PROTOCOL_ERROR' || code.startsWith('ERR_HTTP2') || code.includes('NO_APPLICATION_PROTOCOL')) return 'HTTP_PROTOCOL_ERROR';
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_ERROR';
  if (code === 'ECONNRESET') return 'CONNECTION_RESET';
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}
export function classifyStatus(status: number) { return status >= 200 && status < 300 ? undefined : `HTTP_${status}`; }
