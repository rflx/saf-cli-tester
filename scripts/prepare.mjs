import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// npm installs development dependencies before preparing a Git dependency.
// The build also makes dist/cli/index.js executable.
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
