import type { FileHandle } from 'node:fs/promises';
import { Redactor } from './redactor.js';
export class Logger {
  constructor(readonly redactor: Redactor, private readonly file?: FileHandle) {}
  console(value: unknown) { console.log(typeof value === 'string' ? this.redactor.text(value) : JSON.stringify(this.redactor.sanitize(value), null, 2)); }
  error(value: unknown) { console.error(JSON.stringify(this.redactor.sanitize(value))); }
  async record(value: unknown) { await this.file?.write(`${JSON.stringify(this.redactor.sanitize(value))}\n`); }
  async close() { await this.file?.close(); }
}
