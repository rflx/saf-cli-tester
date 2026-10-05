import { dirname, resolve } from 'node:path';
import { expandPath } from '../config/paths.js';
import { readYaml } from '../config/loader.js';
import { templateSchema } from './schema.js';
export async function loadTemplate(path: string) {
  try {
    const absolute = expandPath(path); const template = templateSchema.parse(await readYaml(absolute));
    if (template.request.bodyFile) template.request.bodyFile = template.request.bodyFile.startsWith('~') ? expandPath(template.request.bodyFile) : resolve(dirname(absolute), template.request.bodyFile);
    return template;
  } catch { throw new Error('CONFIG_ERROR: Cannot load request template'); }
}
