import { z } from 'zod';
import { configSchema } from './schema.js';
export type AppConfig = z.infer<typeof configSchema>;
