import type { Command } from 'commander';
import { configPaths } from '../../config/paths.js';
import { listProfiles, loadProfile } from '../../profiles/loader.js';
import { profileValidation } from '../../profiles/validator.js';
import type { Logger } from '../../logging/logger.js';
import { discoverResources } from '../../resources.js';
import { initProfile } from '../../config/init.js';
export function profilesCommands(program: Command, logger: Logger) {
  const profiles = program.command('profiles').description('Inspect local TechUser profiles');
  const directory = () => configPaths(program.opts().configDir as string | undefined).profiles;
  profiles.command('examples').description('List bundled profile examples').action(async () => logger.console([...(await discoverResources('profile')).keys()].join('\n')));
  profiles.command('init <name>').description('Create a local profile from a bundled placeholder example')
    .requiredOption('--example <name>', 'Bundled profile example')
    .action(async (name: string, options: { example: string }) => {
      const path = await initProfile(program.opts().configDir as string | undefined, name, options.example);
      logger.console(`Created profile: ${path}\nSelected example: ${options.example}\nEdit the file, then run: saf-cli-tester profiles validate ${name}`);
    });
  profiles.command('list').action(async () => logger.console((await listProfiles(directory(), logger.redactor)).map(p => ({ name: p.name, environment: p.environment, rest: p.rest?.auth.mode ?? 'not configured', kafka: p.kafka?.auth.mode ?? 'not configured' }))));
  profiles.command('show <name>').action(async (name: string) => logger.console(await loadProfile(directory(), name, logger.redactor)));
  profiles.command('validate <name>').action(async (name: string) => {
    const profile = await loadProfile(directory(), name, logger.redactor);
    const report = await profileValidation(profile);
    logger.console(report);
    if (report.validation === 'FAILED') throw new Error('CONFIG_ERROR: Profile validation failed; correct the reported credential errors');
  });
}
