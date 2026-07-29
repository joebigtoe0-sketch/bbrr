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
  MAX_AGENTS: z.coerce.number().default(100),
  /** the maze refills itself to this many living agents */
  MIN_POPULATION: z.coerce.number().default(5),
  DECISION_INTERVAL_MS: z.coerce.number().default(15000),
  MAX_CONCURRENT_LLM: z.coerce.number().default(4),
  LLM_RPM_CAP: z.coerce.number().default(60),
  DAILY_USD_BUDGET: z.coerce.number().default(15),
  ADMIN_PASSWORD: z.string().default('change-me'),
  DB_PATH: z.string().default('backrooms.db'),
  NODE_ENV: z.string().default('development'),

  // ---------- X / Twitter integration (ported from the universe project) ----------
  // MASTER SWITCH: 'mock' = no network at all (mentions come only from the admin
  // panel, posts just log). 'live' = the reader/poster below turn on per their keys.
  X_MODE: z.enum(['mock', 'live']).default('mock'),
  X_HANDLE: z.string().default('backrooms'), // our account handle, no '@'
  // -- reader (incoming mentions) --
  X_BEARER_TOKEN: z.string().default(''), // official API app bearer (reads mentions)
  TWITTERAPI_IO_KEY: z.string().default(''), // optional cheaper 3rd-party read proxy
  X_USER_ID: z.string().default(''), // optional; else looked up from the handle + cached
  X_READ_POLL_MIN: z.coerce.number().default(2), // minutes between mention polls
  // -- poster (outgoing tweets, official API + OAuth 1.0a) --
  X_POST: z.enum(['on', 'off']).default('off'), // must be 'on' AND keys set to post
  X_CONSUMER_KEY: z.string().default(''),
  X_CONSUMER_SECRET: z.string().default(''),
  X_ACCESS_TOKEN: z.string().default(''),
  X_ACCESS_SECRET: z.string().default(''),
  X_MAX_POST_LEN: z.coerce.number().default(272), // 280 minus a margin; raise with Premium
});

export const config = EnvSchema.parse(process.env);
export const isDev = config.NODE_ENV !== 'production';
