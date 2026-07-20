import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// the .env lives at the repo root; the server's CWD is the server workspace,
// so load the root file explicitly (plus any server-local .env as fallback)
dotenv.config({ path: resolve(fileURLToPath(import.meta.url), '../../../.env') });
dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  BRAIN_MODE: z.enum(['mock', 'openai', 'hybrid']).default('mock'),
  REAL_BRAIN_COUNT: z.coerce.number().default(3),
  MAX_AGENTS: z.coerce.number().default(20),
  /** the maze refills itself to this many living agents */
  MIN_POPULATION: z.coerce.number().default(5),
  DECISION_INTERVAL_MS: z.coerce.number().default(15000),
  MAX_CONCURRENT_LLM: z.coerce.number().default(4),
  LLM_RPM_CAP: z.coerce.number().default(60),
  DAILY_USD_BUDGET: z.coerce.number().default(15),
  ADMIN_PASSWORD: z.string().default('change-me'),
  DB_PATH: z.string().default('backrooms.db'),
  NODE_ENV: z.string().default('development'),
});

export const config = EnvSchema.parse(process.env);
export const isDev = config.NODE_ENV !== 'production';
