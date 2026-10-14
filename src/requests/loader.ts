import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveResource } from '../resources.js';
import { expandPath } from '../config/paths.js';
import { readYaml } from '../config/loader.js';
import { templateSchema } from './schema.js';
export async function loadTemplate(path: string) {
  try {
    const local = expandPath(path);
    // Preserve local precedence while discovering bundled fallbacks by filename.
    const bundled = path.startsWith('templates/') && path.endsWith('.yaml');
    const absolute = !existsSync(local) && bundled ? await resolveResource('template', path.slice(10, -5)) : local;
    const template = templateSchema.parse(await readYaml(absolute));
    if (template.request.bodyFile) template.request.bodyFile = template.request.bodyFile.startsWith('~') ? expandPath(template.request.bodyFile) : resolve(dirname(absolute), template.request.bodyFile);
    return template;
  } catch { throw new Error('CONFIG_ERROR: Cannot load request template'); }
}
