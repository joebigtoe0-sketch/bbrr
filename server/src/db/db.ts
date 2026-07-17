import Database from 'better-sqlite3';
import { config } from '../config.js';

export const db: Database.Database = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL,
  stress REAL NOT NULL DEFAULT 10,
  attention REAL NOT NULL DEFAULT 0,
  hue INTEGER NOT NULL DEFAULT 0,
  brain_mode TEXT NOT NULL DEFAULT 'mock',
  created_at INTEGER NOT NULL,
  died_at INTEGER,
  death_cause TEXT
);
CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  summary TEXT NOT NULL DEFAULT '',
  notes_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  text TEXT NOT NULL,
  mind_state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS thoughts_agent ON thoughts(agent_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL,
  chunk_key TEXT NOT NULL,
  text TEXT,
  author_agent_id TEXT,
  author_name TEXT,
  meta_json TEXT,
  created_tick INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS evidence_chunk ON evidence(chunk_key);
CREATE TABLE IF NOT EXISTS chunks (
  key TEXT PRIMARY KEY,
  cx INTEGER NOT NULL, cy INTEGER NOT NULL,
  tiles BLOB NOT NULL,
  lights_on INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  tick INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);
