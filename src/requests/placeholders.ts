import type { Profile } from '../profiles/types.js';
import { sharedCredential } from '../profiles/validator.js';
import { randomUUID } from 'node:crypto';
import type { Redactor } from '../logging/redactor.js';

// Replacement values are never interpreted as templates.
export function preparePlaceholders(value: unknown, redactor: Redactor, profile?: Profile): () => unknown {
  if (profile) redactor.register(profile);
  const compile = (input: unknown): ((uuid: string, now: string) => unknown) => {
    if (typeof input === 'string') {
      const parts: Array<string | ((uuid: string, now: string) => string)> = [];
      let cursor = 0;
      for (const match of input.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const literal = input.slice(cursor, match.index);
        if (literal.includes('{{') || literal.includes('}}') || literal.endsWith('{') || input[match.index! + match[0].length] === '}') throw new Error('CONFIG_ERROR: Malformed request placeholder');
        parts.push(literal);
        const token = match[1]!;
        if (token === 'uuid') parts.push(uuid => uuid);
        else if (token === 'nowUtc') parts.push((_uuid, now) => now);
        else if (token.startsWith('profile:')) {
          const key = token === 'profile:credentials.shared.licenceKey' ? 'licenceKey'
            : token === 'profile:credentials.shared.password' ? 'password' : undefined;
          if (!key) throw new Error('CONFIG_ERROR: Profile placeholder is not allowlisted');
          const secret = sharedCredential(profile?.credentials.shared, key);
          redactor.register({ secret }); parts.push(secret);
        }
        else if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
          const name = token.slice(4); const secret = process.env[name];
          if (!secret) throw new Error(`CONFIG_ERROR: Environment variable ${name} is not set or is empty`);
          redactor.register({ secret }); parts.push(secret);
        } else throw new Error('CONFIG_ERROR: Unknown or malformed request placeholder');
        cursor = match.index! + match[0].length;
      }
      const tail = input.slice(cursor);
      if (tail.includes('{{') || tail.includes('}}')) throw new Error('CONFIG_ERROR: Malformed request placeholder');
      parts.push(tail);
      return (uuid, now) => parts.map(part => typeof part === 'string' ? part : part(uuid, now)).join('');
    }
    if (Array.isArray(input)) {
      const children = input.map(compile);
      return (uuid, now) => children.map(child => child(uuid, now));
    }
    if (input && typeof input === 'object') {
      const children = Object.entries(input).map(([key, child]) => {
        if (key.includes('{{') || key.includes('}}')) throw new Error('CONFIG_ERROR: Placeholders are only supported in values');
        return [key, compile(child)] as const;
      });
      return (uuid, now) => Object.fromEntries(children.map(([key, child]) => [key, child(uuid, now)]));
    }
    return () => input;
  };
  const compiled = compile(value);
  return () => compiled(randomUUID(), new Date().toISOString());
}

export function templateBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  // Parse JSON before interpolation so quotes/newlines in secrets remain escaped.
  try { return JSON.parse(body) as unknown; } catch { return body; }
}
