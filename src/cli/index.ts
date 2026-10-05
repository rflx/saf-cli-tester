#!/usr/bin/env node
import { Command } from 'commander';
import { configPaths } from '../config/paths.js';
import { loadConfig } from '../config/loader.js';
import { Logger } from '../logging/logger.js';
import { Redactor } from '../logging/redactor.js';
import { profilesCommands } from './commands/profiles.js';
import { requestFlags, pollFlags, runRequest } from './commands/rest-request.js';
import { templateCommand } from './commands/run.js';

const redactor = new Redactor(); const logger = new Logger(redactor);
const program = new Command().name('saf-cli-tester').description('SAF REST connectivity diagnostics').version('0.1.0')
  .option('--config-dir <directory>', 'Local configuration root', '~/.config/saf-cli-tester');
program.configureOutput({ writeOut: value => process.stdout.write(redactor.text(value)), writeErr: value => process.stderr.write(redactor.text(value)), outputError: () => logger.error('CONFIG_ERROR: Invalid command arguments; use --help') });
const config = program.command('config');
config.command('paths').action(() => logger.console(configPaths(program.opts().configDir as string)));
config.command('show').action(async () => logger.console(await loadConfig(configPaths(program.opts().configDir as string).config)));
profilesCommands(program, logger);
const rest = program.command('rest');
requestFlags(rest.command('request')).action(async (options: Record<string,unknown>) => runRequest(program, options, redactor, false));
pollFlags(requestFlags(rest.command('poll'))).action(async (options: Record<string,unknown>) => runRequest(program, options, redactor, true));
templateCommand(program, redactor);
try { await program.parseAsync(); }
catch (error) {
  // Schema errors may embed untrusted values; emit field paths only.
  if (error && typeof error === 'object' && 'issues' in error) logger.error('CONFIG_ERROR: Invalid request options');
  else logger.error(error instanceof Error ? error.message : 'CONFIG_ERROR: Command failed');
  process.exitCode = 1;
}
