import type { Command } from 'commander';
import { configPaths } from '../../config/paths.js';
import { listProfiles, loadProfile } from '../../profiles/loader.js';
import { validateProfile } from '../../profiles/validator.js';
import type { Logger } from '../../logging/logger.js';
export function profilesCommands(program: Command, logger: Logger) {
  const profiles = program.command('profiles').description('Inspect local TechUser profiles');
  const directory = () => configPaths(program.opts().configDir as string | undefined).profiles;
  profiles.command('list').action(async () => logger.console((await listProfiles(directory())).map(p => ({ name: p.name, environment: p.environment, auth: p.auth.mode }))));
  profiles.command('show <name>').action(async (name: string) => logger.console(await loadProfile(directory(), name)));
  profiles.command('validate <name>').action(async (name: string) => {
    const profile = await loadProfile(directory(), name); await validateProfile(profile);
    logger.console({ profile: name, environment: profile.environment, validation: 'OK' });
  });
}
