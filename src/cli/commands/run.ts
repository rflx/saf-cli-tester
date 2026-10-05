import type { Command } from 'commander';
import type { Redactor } from '../../logging/redactor.js';
import { requestFlags, pollFlags, runRequest } from './rest-request.js';
export function templateCommand(program: Command, redactor: Redactor) {
  pollFlags(requestFlags(program.command('run').description('Execute a YAML request template'))).requiredOption('--request <file>', 'Request template')
    .action(async (options: Record<string,unknown>) => runRequest(program, options, redactor, false, String(options.request)));
}
