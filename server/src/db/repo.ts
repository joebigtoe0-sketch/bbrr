import { db } from './db.js';
import type { EvidenceArtifact } from '@backrooms/shared';

// ---------- kv ----------
const kvGetStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
const kvSetStmt = db.prepare(
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
export const kv = {
  get(key: string): string | undefined {
    const row = kvGetStmt.get(key) as { value: string } | undefined;
    return row?.value;
  },
  set(key: string, value: string) {
    kvSetStmt.run(key, value);
  },
};

// ---------- chunks ----------
const chunkGetStmt = db.prepare('SELECT * FROM chunks WHERE key = ?');
const chunkUpsertStmt = db.prepare(`
  INSERT INTO chunks (key, cx, cy, tiles, walls_h, walls_v, lights_on, version, updated_at)
  VALUES (@key, @cx, @cy, @tiles, @walls_h, @walls_v, @lights_on, @version, @updated_at)
  ON CONFLICT(key) DO UPDATE SET tiles=excluded.tiles, walls_h=excluded.walls_h,
    walls_v=excluded.walls_v, lights_on=excluded.lights_on,
    version=excluded.version, updated_at=excluded.updated_at
`);
export interface ChunkRow {
  key: string;
  cx: number;
  cy: number;
  tiles: Buffer;
  walls_h: Buffer;
  walls_v: Buffer;
  lights_on: number;
  version: number;
}
export const chunkRepo = {
  get(key: string): ChunkRow | undefined {
    return chunkGetStmt.get(key) as ChunkRow | undefined;
  },
  upsert(
    key: string,
    cx: number,
    cy: number,
    tiles: Uint8Array,
    wallsH: Uint8Array,
    wallsV: Uint8Array,
    lightsOn: boolean,
    version: number,
  ) {
    chunkUpsertStmt.run({
      key,
      cx,
      cy,
      tiles: Buffer.from(tiles),
      walls_h: Buffer.from(wallsH),
      walls_v: Buffer.from(wallsV),
      lights_on: lightsOn ? 1 : 0,
      version,
      updated_at: Date.now(),
    });
  },
};

// ---------- agents ----------
const agentUpsertStmt = db.prepare(`
  INSERT INTO agents (id, name, objective, status, x, y, stress, attention, battery, energy, hue, brain_mode, created_at, died_at, death_cause)
  VALUES (@id, @name, @objective, @status, @x, @y, @stress, @attention, @battery, @energy, @hue, @brain_mode, @created_at, @died_at, @death_cause)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status, x=excluded.x, y=excluded.y,
    stress=excluded.stress, attention=excluded.attention, battery=excluded.battery,
    energy=excluded.energy, died_at=excluded.died_at, death_cause=excluded.death_cause
`);
export interface AgentRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  x: number;
  y: number;
  stress: number;
  attention: number;
  battery: number;
  energy: number;
  hue: number;
  brain_mode: string;
  created_at: number;
  died_at: number | null;
  death_cause: string | null;
}
export const agentRepo = {
  upsert(a: AgentRow) {
    agentUpsertStmt.run(a);
  },
  liveAgents(): AgentRow[] {
    return db.prepare("SELECT * FROM agents WHERE status = 'live'").all() as AgentRow[];
  },
  recentDeaths(limit: number): AgentRow[] {
    return db
      .prepare("SELECT * FROM agents WHERE status = 'dead' ORDER BY died_at DESC LIMIT ?")
      .all(limit) as AgentRow[];
  },
  countToday(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
  },
};

// ---------- memory ----------
const memUpsertStmt = db.prepare(`
  INSERT INTO agent_memory (agent_id, summary, notes_json, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(agent_id) DO UPDATE SET summary=excluded.summary, notes_json=excluded.notes_json, updated_at=excluded.updated_at
`);
export const memoryRepo = {
  get(agentId: string): { summary: string; notes: string[] } {
    const row = db.prepare('SELECT summary, notes_json FROM agent_memory WHERE agent_id = ?').get(agentId) as
      | { summary: string; notes_json: string }
      | undefined;
    if (!row) return { summary: '', notes: [] };
    return { summary: row.summary, notes: JSON.parse(row.notes_json) };
  },
  set(agentId: string, summary: string, notes: string[]) {
    memUpsertStmt.run(agentId, summary, JSON.stringify(notes), Date.now());
  },
};

// ---------- thoughts ----------
const thoughtInsertStmt = db.prepare(
  'INSERT INTO thoughts (agent_id, tick, text, mind_state, created_at) VALUES (?, ?, ?, ?, ?)',
);
export const thoughtRepo = {
  insert(agentId: string, tick: number, text: string, mindState: string) {
    thoughtInsertStmt.run(agentId, tick, text, mindState, Date.now());
  },
  lastN(agentId: string, n: number): { text: string; mind_state: string }[] {
    return db
      .prepare('SELECT text, mind_state FROM thoughts WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
      .all(agentId, n) as { text: string; mind_state: string }[];
  },
};

// ---------- evidence ----------
const evidenceUpsertStmt = db.prepare(`
  INSERT INTO evidence (id, kind, x, y, chunk_key, text, author_agent_id, author_name, meta_json, created_tick, created_at, deleted)
  VALUES (@id, @kind, @x, @y, @chunk_key, @text, @author_agent_id, @author_name, @meta_json, @created_tick, @created_at, 0)
  ON CONFLICT(id) DO UPDATE SET text=excluded.text, meta_json=excluded.meta_json
`);
const evidenceDeleteStmt = db.prepare('UPDATE evidence SET deleted = 1 WHERE id = ?');
export const evidenceRepo = {
  upsert(e: EvidenceArtifact, chunkKey: string) {
    evidenceUpsertStmt.run({
      id: e.id,
      kind: e.kind,
      x: e.x,
      y: e.y,
      chunk_key: chunkKey,
      text: e.text ?? null,
      author_agent_id: e.authorAgentId ?? null,
      author_name: e.authorName ?? null,
      meta_json: e.meta ? JSON.stringify(e.meta) : null,
      created_tick: e.createdTick,
      created_at: Date.now(),
    });
  },
  remove(id: string) {
    evidenceDeleteStmt.run(id);
  },
  byChunk(chunkKey: string): EvidenceArtifact[] {
    const rows = db
      .prepare('SELECT * FROM evidence WHERE chunk_key = ? AND deleted = 0')
      .all(chunkKey) as {
      id: string;
      kind: string;
      x: number;
      y: number;
      text: string | null;
      author_agent_id: string | null;
      author_name: string | null;
      meta_json: string | null;
      created_tick: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as EvidenceArtifact['kind'],
      x: r.x,
      y: r.y,
      text: r.text ?? undefined,
      authorAgentId: r.author_agent_id ?? undefined,
      authorName: r.author_name ?? undefined,
      meta: r.meta_json ? JSON.parse(r.meta_json) : undefined,
      createdTick: r.created_tick,
    }));
  },
};

// ---------- tweets (the maze's internal feed; nothing real is posted) ----------
const tweetInsertStmt = db.prepare(
  'INSERT INTO tweets (text, kind, tick, created_at) VALUES (?, ?, ?, ?)',
);
export const tweetRepo = {
  insert(text: string, kind: string, tick: number) {
    tweetInsertStmt.run(text, kind, tick, Date.now());
  },
  latest(limit: number): { id: number; text: string; kind: string; created_at: number }[] {
    return db
      .prepare('SELECT id, text, kind, created_at FROM tweets ORDER BY id DESC LIMIT ?')
      .all(limit) as { id: number; text: string; kind: string; created_at: number }[];
  },
};

// ---------- case files ----------
const caseInsertStmt = db.prepare(`
  INSERT INTO case_files (agent_id, name, objective, story, born_at, died_at, cause, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(agent_id) DO UPDATE SET story=excluded.story
`);
export const caseFileRepo = {
  insert(
    agentId: string,
    name: string,
    objective: string,
    story: string,
    bornAt: number,
    diedAt: number,
    cause: string,
  ) {
    caseInsertStmt.run(agentId, name, objective, story, bornAt, diedAt, cause, Date.now());
  },
  latest(limit: number): CaseFileRow[] {
    return db
      .prepare('SELECT * FROM case_files ORDER BY died_at DESC LIMIT ?')
      .all(limit) as CaseFileRow[];
  },
};

export interface CaseFileRow {
  agent_id: string;
  name: string;
  objective: string;
  story: string;
  born_at: number;
  died_at: number;
  cause: string | null;
}

// ---------- world events ----------
const eventInsertStmt = db.prepare(
  'INSERT INTO world_events (type, payload_json, tick, created_at) VALUES (?, ?, ?, ?)',
);
export const eventRepo = {
  insert(type: string, payload: unknown, tick: number) {
    eventInsertStmt.run(type, JSON.stringify(payload), tick, Date.now());
  },
};
