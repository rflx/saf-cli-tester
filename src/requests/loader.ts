import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { packageRoot } from '../version.js';
import { expandPath } from '../config/paths.js';
import { readYaml } from '../config/loader.js';
import { templateSchema } from './schema.js';
export async function loadTemplate(path: string) {
  try {
    const local = expandPath(path);
    // Only known bundled template paths fall back; custom files retain existing semantics.
    const bundled = /^templates\/general-api\/saf-(receivers|insurers)\.yaml$/.test(path);
    const absolute = !existsSync(local) && bundled ? resolve(packageRoot, path) : local;
    const template = templateSchema.parse(await readYaml(absolute));
    if (template.request.bodyFile) template.request.bodyFile = template.request.bodyFile.startsWith('~') ? expandPath(template.request.bodyFile) : resolve(dirname(absolute), template.request.bodyFile);
    return template;
  } catch { throw new Error('CONFIG_ERROR: Cannot load request template'); }
}
