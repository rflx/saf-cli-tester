import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, npm_config_global: 'false' };

function npm(args) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// npm's Git preparation can inherit global mode and link the checkout without
// installing its dependencies. Populate the checkout locally before building.
if (process.env.npm_config_global === 'true') {
  npm(['ci', '--global=false', '--prefix', root, '--include=dev', '--ignore-scripts']);
}

npm(['run', 'build']);
