import type { Command } from 'commander';
import { configPaths } from '../../config/paths.js';
import { listProfiles, loadProfile } from '../../profiles/loader.js';
import { profileValidation } from '../../profiles/validator.js';
import type { Logger } from '../../logging/logger.js';
export function profilesCommands(program: Command, logger: Logger) {
  const profiles = program.command('profiles').description('Inspect local TechUser profiles');
  const directory = () => configPaths(program.opts().configDir as string | undefined).profiles;
  profiles.command('list').action(async () => logger.console((await listProfiles(directory(), logger.redactor)).map(p => ({ name: p.name, environment: p.environment, rest: p.rest?.auth.mode ?? 'not configured', kafka: p.kafka?.auth.mode ?? 'not configured' }))));
  profiles.command('show <name>').action(async (name: string) => logger.console(await loadProfile(directory(), name, logger.redactor)));
  profiles.command('validate <name>').action(async (name: string) => {
    const profile = await loadProfile(directory(), name, logger.redactor);
    const report = await profileValidation(profile);
    logger.console(report);
    if (report.validation === 'FAILED') throw new Error('CONFIG_ERROR: Profile validation failed; correct the reported credential errors');
  });
}
