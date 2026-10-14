import type { Command } from 'commander';
import type { Logger } from '../../logging/logger.js';
import { discoverResources } from '../../resources.js';
import { initRequest } from '../../config/init.js';

export function requestsCommands(program: Command, logger: Logger) {
  const requests = program.command('requests').description('Initialize local requests from bundled references or executable templates');
  requests.command('examples').description('List bundled request examples').action(async () => logger.console([...(await discoverResources('request')).keys()].join('\n')));
  requests.command('templates').description('List bundled executable templates').action(async () => logger.console([...(await discoverResources('template')).keys()].join('\n')));
  requests.command('init <name>').description('Create a local request without overwriting existing files')
    .option('--example <name>', 'Bundled request example (choose exactly one source)')
    .option('--template <category/name>', 'Bundled executable template (choose exactly one source)')
    .action(async (name: string, options: { example?: string; template?: string }) => {
      const path = await initRequest(program.opts().configDir as string | undefined, name, options);
      logger.console(`Created request: ${path}\nSelected ${options.example ? 'example' : 'template'}: ${options.example ?? options.template}\nEdit the file as needed, then run: saf-cli-tester run --profile <profile-name> --request ${path}`);
    });
}
