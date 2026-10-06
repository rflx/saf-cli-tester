import type { Redactor } from './redactor.js';

/** Presentation only: never pass this output to persistent diagnostics. */
export function payloadOutput(label: string, body: string, redactor: Redactor): string {
  if (!body.length) return `${label}: <empty>`;
  let formatted: string;
  try { formatted = JSON.stringify(redactor.sanitize(JSON.parse(body)), null, 2); }
  catch { formatted = redactor.text(body); }
  return `${label}:\n${redactor.text(formatted)}`;
}

export function kafkaPayloadOutput(value: Buffer | null, redactor: Redactor): string {
  if (value === null) return 'Payload: <null>';
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { return `Payload: <binary, ${value.length} bytes>`; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return `Payload: <binary, ${value.length} bytes>`;
  return payloadOutput('Payload', text, redactor);
}
