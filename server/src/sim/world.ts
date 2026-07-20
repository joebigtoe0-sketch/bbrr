import { nanoid } from 'nanoid';
import {
  CHUNK_SIZE,
  EDGE,
  OBJECTIVES,
  SIM_TICK_MS,
  TILE,
  chunkKey,
  tileToChunk,
} from '@backrooms/shared';
import type {
  Agent,
  DeltaMsg,
  EvidenceArtifact,
  Objective,
  ThoughtEvent,
} from '@backrooms/shared';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/db.js';
import { agentRepo, kv, memoryRepo, thoughtRepo } from '../db/repo.js';
import { Maze } from './maze.js';
import { EvidenceStore } from './evidence.js';
import { EventBus } from './events.js';
import {
  type AgentRuntime,
  agentDirty,
  deriveMindState,
  markSent,
  tickAgent,
  toWireAgent,
} from './agents.js';
import {
  type MonsterRuntime,
  createMonster,
  markMonsterSent,
  monsterDirty,
  tickMonster,
  toWireMonster,
} from './monster.js';
import { type ChaosRuntime, createChaos, tickChaos } from './chaos.js';
import { rollViral } from './social.js';
import { rngFor, randInt, hashStr } from './rng.js';
import { ChaosTextQueue } from '../brain/chaosText.js';

type Delta = Omit<z.infer<typeof DeltaMsg>, 't'>;

const AMBIENT_NOTES = [
  'day 34. the hum changed pitch again. counting doors until it changes back.',
  'if you find this: the water in the walls is not water.',
  'we agreed to meet at the humming room. nobody came. nobody ever came.',
  'DO NOT SLEEP ON THE CARPET',
  'the lights know. keep smiling.',
  'i measured this room twice. it was bigger the second time.',
  'tally marks are useless. the walls erase them when you blink.',
  'to whoever comes after me: the exit signs are a rota. they take turns lying.',
  'heard my own voice two rooms over. did not go look.',
  'inventory: 3 cans, 1 lighter, 0 reasons.',
  'if the printer prints on its own, do not read page two.',
  'someone keeps moving the terminals. or the rooms. or me.',
] as const;

const NAME_POOL = [
  'Vera', 'Kaz', 'Moth', 'Ida', 'Sol', 'Rune', 'Pell', 'Nyx', 'Aster', 'Grey',
  'Wren', 'Tallow', 'Juno', 'Harrow', 'Lux', 'Fen', 'Orrin', 'Sable', 'Quill', 'Vesper',
];

export class World {
  tick = 0;
  readonly seed: string;
  readonly maze: Maze;
  readonly evidence = new EvidenceStore();
  readonly bus: EventBus;
  readonly agents = new Map<string, AgentRuntime>();
  monsterRt: MonsterRuntime;
  chaosRt: ChaosRuntime = createChaos();
  readonly chunkVisits = new Map<string, number>();
  readonly chaosText = new ChaosTextQueue();

  spectatorCount = 0;
  /** wsHub registers this so eviction keeps subscribed chunks alive */
  subscriptionAnchors: () => { cx: number; cy: number }[] = () => [];
  /** wsHub registers this to route thoughts to tuned spectators */
  onThought: (t: ThoughtEvent) => void = () => {};
  /** wsHub registers this; called once at the end of every sim tick */
  afterTick: () => void = () => {};

  private pendingRemovals: string[] = [];
  private pendingSpeech: { agentId: string; text: string }[] = [];
  private agentChunk = new Map<string, string>();
  private lastEvictAt = 0;
  private lastFlushAt = 0;
  private lastViralRollAt = 0;
  private lastRespawnAt = 0;
  private lastTickAt = Date.now();
  private timer: NodeJS.Timeout | null = null;

  get monster() {
    return this.monsterRt;
  }

  constructor() {
    const storedSeed = kv.get('worldSeed');
    this.seed = storedSeed ?? nanoid(12);
    if (!storedSeed) kv.set('worldSeed', this.seed);
    this.tick = Number(kv.get('tick') ?? 0);
    this.maze = new Maze(this.seed);

    // one-time migration: worlds generated before the darkness rework had
    // pre-lit sectors; the maze is dark now unless events power it
    if (!kv.get('darknessMigrated')) {
      db.prepare('UPDATE chunks SET lights_on = 0').run();
      kv.set('darknessMigrated', '1');
    }

    this.bus = new EventBus(() => this.tick);
    this.registerMutators();

    // origin area always exists and is lit — the "lobby" where agents wake up
    this.maze.growAround(8, 8, 1);

    const monsterStored = kv.get('monster');
    if (monsterStored) {
      const m = JSON.parse(monsterStored) as { x: number; y: number };
      this.monsterRt = createMonster(m.x, m.y);
    } else {
      const spot = this.maze.nearestWalkable(40, 40, 30) ?? { x: 8, y: 8 };
      this.maze.growAround(40, 40, 1);
      this.monsterRt = createMonster(spot.x + 0.5, spot.y + 0.5);
    }

    this.recoverAgents();
    this.decorateNewChunks();
  }

  start() {
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.step(), SIM_TICK_MS);
    console.log(
      `[world] seed=${this.seed} tick=${this.tick} liveAgents=${this.agents.size} — simulation running`,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.flush(true);
  }

  private step() {
    const now = Date.now();
    const dtMs = Math.min(500, now - this.lastTickAt);
    this.lastTickAt = now;
    this.tick++;

    for (const a of this.agents.values()) {
      tickAgent(this, a, dtMs, now);
      // chunk visit tracking (feeds 'toward_unexplored')
      const ck = chunkKey(tileToChunk(Math.floor(a.x)), tileToChunk(Math.floor(a.y)));
      if (this.agentChunk.get(a.id) !== ck) {
        this.agentChunk.set(a.id, ck);
        this.chunkVisits.set(ck, (this.chunkVisits.get(ck) ?? 0) + 1);
      }
    }
    tickMonster(this, dtMs, now);
    tickChaos(this, now);

    if (now - this.lastViralRollAt > 120000) {
      this.lastViralRollAt = now;
      rollViral(this);
    }
    // the maze always finds new people: refill toward MIN_POPULATION, one at a time
    if (now - this.lastRespawnAt > 45000) {
      this.lastRespawnAt = now;
      const living = [...this.agents.values()].filter((a) => a.state !== 'dead').length;
      if (living < config.MIN_POPULATION) {
        const objective = OBJECTIVES[Math.floor(Math.random() * OBJECTIVES.length)]!;
        const r = this.spawnAgent(objective);
        if (!('error' in r)) console.log(`[world] the maze found someone new: ${r.name} (${objective})`);
      }
    }
    if (now - this.lastEvictAt > 30000) {
      this.lastEvictAt = now;
      this.evictChunks();
    }
    if (now - this.lastFlushAt > 10000) {
      this.lastFlushAt = now;
      this.flush(false);
    }
    this.decorateNewChunks();
    this.afterTick();
  }

  // ---------- spawning / death ----------

  spawnAgent(objective: Objective, name?: string, brainKind?: 'mock' | 'openai'): AgentRuntime | { error: string } {
    const living = [...this.agents.values()].filter((a) => a.state !== 'dead');
    if (living.length >= config.MAX_AGENTS) return { error: 'world_full' };

    const finalName = (name?.trim() || this.pickName()).slice(0, 24);
    const spot = this.findSpawnSpot();
    const id = nanoid(10);
    const kind =
      brainKind ??
      (config.BRAIN_MODE === 'openai'
        ? 'openai'
        : config.BRAIN_MODE === 'hybrid'
          ? living.filter((a) => a.brainKind === 'openai').length < config.REAL_BRAIN_COUNT
            ? 'openai'
            : 'mock'
          : 'mock');

    const now = Date.now();
    const a: AgentRuntime = {
      id,
      name: finalName,
      objective,
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      facing: 's',
      state: 'idle',
      stress: 10,
      attention: 0,
      mindState: 'calm',
      hue: hashStr(id) % 360,
      brainKind: kind,
      path: null,
      pathIdx: 0,
      currentAction: null,
      followTargetId: null,
      repathAt: 0,
      lastActionResult: 'you just woke up here',
      lastSaid: null,
      heardSinceLastDecision: [],
      nextDecisionAt: now + 2000 + Math.random() * 4000,
      deciding: false,
      memory: { summary: '', notes: [] },
      decisionCount: 0,
      thoughtCount: 0,
      spawnedAtMs: now,
      restUntil: 0,
      interactUntil: 0,
      monsterVisible: false,
      deceiving: false,
      notable: 0,
      createdAt: now,
      lastSentX: NaN,
      lastSentY: NaN,
      lastSentStress: NaN,
      lastSentState: '',
      lastSentMindState: '',
      lastSentAttention: NaN,
    };
    this.agents.set(id, a);
    this.persistAgent(a);
    this.bus.emit('agent_spawned', { agentId: id, name: finalName, objective });
    return a;
  }

  killAgent(a: AgentRuntime, cause: string) {
    if (a.state === 'dead') return;
    a.state = 'dead';
    a.path = null;

    const x = Math.floor(a.x);
    const y = Math.floor(a.y);
    this.evidence.create('corpse', x, y, this.tick, {
      text: `${a.name} — ${cause}`,
      authorAgentId: a.id,
      authorName: a.name,
    });
    // final log: the agent's last thoughts, printed where machines can reach
    const lastThoughts = thoughtRepo.lastN(a.id, 3).reverse();
    if (lastThoughts.length > 0) {
      const machine =
        this.evidence.nearest('printer', a.x, a.y, 30) ?? this.evidence.nearest('crt', a.x, a.y, 30);
      const px = machine ? machine.x : x;
      const py = machine ? machine.y + 1 : y;
      this.evidence.create('printout', px, py, this.tick, {
        text: `FINAL LOG // ${a.name}\n` + lastThoughts.map((t) => `> ${t.text}`).join('\n'),
        authorAgentId: a.id,
        authorName: a.name,
        meta: { finalLog: true },
      });
    }

    // witnesses
    for (const w of this.agents.values()) {
      if (w.id === a.id || w.state === 'dead') continue;
      if (Math.hypot(w.x - a.x, w.y - a.y) <= 12) {
        w.stress = Math.min(100, w.stress + 40);
        this.addMemoryNote(w, `You watched ${a.name} die. It was over in seconds.`);
      }
    }

    const row = {
      ...this.agentRow(a),
      status: 'dead',
      died_at: Date.now(),
      death_cause: cause,
    };
    agentRepo.upsert(row);
    this.bus.emit('agent_died', { agentId: a.id, name: a.name, cause, x: a.x, y: a.y });
    this.pendingRemovals.push(a.id);
  }

  // ---------- world event mutators ----------

  private registerMutators() {
    this.bus.on((e) => {
      switch (e.type) {
        case 'viral_post': {
          const agentId = e.payload.agentId as string | undefined;
          const magnitude = (e.payload.magnitude as number | undefined) ?? 10;
          const a = agentId ? this.agents.get(agentId) : undefined;
          if (!a || a.state === 'dead') break;
          a.attention = Math.min(100, a.attention + magnitude);
          this.addMemoryNote(a, 'You can feel it: attention from outside this place is increasing.');
          const ccx = tileToChunk(Math.floor(a.x));
          const ccy = tileToChunk(Math.floor(a.y));
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) this.maze.setLights(ccx + dx, ccy + dy, true);
          this.unlockDoorNear(a.x, a.y, 6 * CHUNK_SIZE);
          break;
        }
        case 'buyback': {
          const radius = (e.payload.radiusChunks as number | undefined) ?? 3;
          const c = this.activityCentroid();
          const ccx = tileToChunk(Math.floor(c.x));
          const ccy = tileToChunk(Math.floor(c.y));
          for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++) {
              const key = chunkKey(ccx + dx, ccy + dy);
              if (this.maze.getLoaded(key)) this.maze.setLights(ccx + dx, ccy + dy, true);
            }
          break;
        }
        case 'burn':
          this.burnCorridor();
          break;
        case 'airdrop': {
          const count = (e.payload.count as number | undefined) ?? 3;
          const living = [...this.agents.values()].filter((a) => a.state !== 'dead');
          for (let i = 0; i < count && living.length > 0; i++) {
            const a = living[Math.floor(Math.random() * living.length)]!;
            const spot = this.maze.nearestWalkable(
              Math.floor(a.x + (Math.random() - 0.5) * 8),
              Math.floor(a.y + (Math.random() - 0.5) * 8),
            );
            if (spot)
              this.evidence.create('crate', spot.x, spot.y, this.tick, {
                text: 'A sealed supply crate. It was not here before.',
              });
          }
          break;
        }
        case 'liquidity_up': {
          const c = this.activityCentroid();
          const ccx = tileToChunk(Math.floor(c.x));
          const ccy = tileToChunk(Math.floor(c.y));
          const r = 3;
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) === r) this.maze.ensureChunk(ccx + dx, ccy + dy);
            }
          this.bus.emit('map_expand', { cx: ccx, cy: ccy, radius: r });
          break;
        }
      }
    });
  }

  private unlockDoorNear(x: number, y: number, radius: number) {
    const edge = this.maze.findEdge(
      Math.floor(x),
      Math.floor(y),
      radius,
      (v) => v === EDGE.DoorLocked,
    );
    if (edge) {
      this.maze.setEdge(edge.gx, edge.gy, edge.dir, EDGE.DoorOpen);
      this.bus.emit('door_unlock', { x: edge.gx, y: edge.gy });
    }
  }

  private burnCorridor() {
    // collapse floor tiles in a loaded chunk far from every agent, never sealing anyone in
    const living = [...this.agents.values()].filter((a) => a.state !== 'dead');
    const farChunks = this.maze.loadedKeys().filter((key) => {
      const c = this.maze.getLoaded(key)!;
      return living.every(
        (a) =>
          Math.max(
            Math.abs(tileToChunk(Math.floor(a.x)) - c.cx),
            Math.abs(tileToChunk(Math.floor(a.y)) - c.cy),
          ) >= 2,
      );
    });
    if (farChunks.length === 0) return;
    const key = farChunks[Math.floor(Math.random() * farChunks.length)]!;
    const c = this.maze.getLoaded(key)!;
    const changed: { x: number; y: number }[] = [];
    for (let attempts = 0; attempts < 40 && changed.length < 8; attempts++) {
      const lx = Math.floor(Math.random() * CHUNK_SIZE);
      const ly = Math.floor(Math.random() * CHUNK_SIZE);
      const gx = c.cx * CHUNK_SIZE + lx;
      const gy = c.cy * CHUNK_SIZE + ly;
      if (this.maze.tileAt(gx, gy) === TILE.Floor) {
        this.maze.setTile(gx, gy, TILE.Rubble);
        changed.push({ x: gx, y: gy });
      }
    }
    // safety: every living agent must still be able to move at least 20 tiles
    for (const a of living) {
      if (!this.canRoam(Math.floor(a.x), Math.floor(a.y), 20)) {
        for (const t of changed) this.maze.setTile(t.x, t.y, TILE.Floor);
        return;
      }
    }
    if (changed.length > 0)
      this.bus.emit('corridor_collapse', { tiles: changed, chunk: key });
  }

  private canRoam(x: number, y: number, needed: number): boolean {
    const seen = new Set<string>();
    const stack = [[x, y]];
    seen.add(`${x},${y}`);
    while (stack.length > 0 && seen.size < needed) {
      const [cx, cy] = stack.pop()!;
      for (const [nx, ny] of [
        [cx! + 1, cy!],
        [cx! - 1, cy!],
        [cx!, cy! + 1],
        [cx!, cy! - 1],
      ] as const) {
        const k = `${nx},${ny}`;
        if (!seen.has(k) && this.maze.canStep(cx!, cy!, nx, ny)) {
          seen.add(k);
          stack.push([nx, ny]);
        }
      }
    }
    return seen.size >= needed;
  }

  // ---------- thoughts / speech / terminals ----------

  emitThought(a: AgentRuntime, text: string, actionLabel: string) {
    a.thoughtCount++;
    a.mindState = deriveMindState(a);
    const t: ThoughtEvent = {
      id: nanoid(8),
      agentId: a.id,
      text,
      mindState: a.mindState,
      actionLabel,
      tick: this.tick,
    };
    thoughtRepo.insert(a.id, this.tick, text, a.mindState);
    this.onThought(t);
    // every 3rd thought leaks onto the nearest CRT — internal logs left behind
    if (a.thoughtCount % 3 === 0) {
      const crt = this.evidence.nearest('crt', a.x, a.y, 20);
      if (crt) {
        const lines = ((crt.meta?.lines as string[] | undefined) ?? []).slice(-9);
        lines.push(`${a.name}> ${text}`);
        crt.meta = { ...crt.meta, lines };
        this.evidence.update(crt);
      }
    }
  }

  speak(a: AgentRuntime, text: string, toAgentName?: string) {
    a.lastSaid = text;
    a.notable += 0.5;
    a.attention = Math.min(100, a.attention + 0.5);
    this.pendingSpeech.push({ agentId: a.id, text });
    for (const other of this.agents.values()) {
      if (other.id === a.id || other.state === 'dead') continue;
      if (Math.hypot(other.x - a.x, other.y - a.y) <= 8) {
        const directed = toAgentName && other.name.toLowerCase() === toAgentName.toLowerCase();
        other.heardSinceLastDecision.push(`${a.name}${directed ? ' (to you)' : ''}: "${text}"`);
        this.addMemoryNote(other, `${a.name} said: "${text}"`);
      }
    }
  }

  postToTerminal(a: AgentRuntime, crt: EvidenceArtifact, text: string) {
    const lines = ((crt.meta?.lines as string[] | undefined) ?? []).slice(-9);
    lines.push(`${a.name} [POST]> ${text}`);
    crt.meta = { ...crt.meta, lines };
    this.evidence.update(crt);
    a.notable += 1.5;
    a.attention = Math.min(100, a.attention + 3);
    a.lastActionResult = 'you sent your words out through the terminal';
  }

  addMemoryNote(a: AgentRuntime, note: string) {
    a.memory.notes.push(note);
    if (a.memory.notes.length > 12) {
      const folded = a.memory.notes.splice(0, 6);
      a.memory.summary = (a.memory.summary + ' ' + folded.join(' ')).trim().slice(-600);
    }
    memoryRepo.set(a.id, a.memory.summary, a.memory.notes);
  }

  agentByName(name?: string): AgentRuntime | undefined {
    if (!name) return undefined;
    const n = name.toLowerCase();
    for (const a of this.agents.values()) {
      if (a.state !== 'dead' && a.name.toLowerCase() === n) return a;
    }
    return undefined;
  }

  // ---------- helpers ----------

  private pickName(): string {
    const used = new Set([...this.agents.values()].map((a) => a.name));
    const free = NAME_POOL.filter((n) => !used.has(n));
    if (free.length > 0) return free[Math.floor(Math.random() * free.length)]!;
    return `Unit-${randInt(Math.random, 100, 999)}`;
  }

  private findSpawnSpot(): { x: number; y: number } {
    // everyone wakes up near the origin "lobby": keeps a stable hub where
    // spectators can always find activity instead of an ever-sprawling world
    const c = { x: 8, y: 8 };
    for (let attempt = 0; attempt < 30; attempt++) {
      const gx = Math.floor(c.x + (Math.random() - 0.5) * 2 * CHUNK_SIZE);
      const gy = Math.floor(c.y + (Math.random() - 0.5) * 2 * CHUNK_SIZE);
      this.maze.growAround(gx, gy, 0);
      const spot = this.maze.nearestWalkable(gx, gy, 8);
      if (spot) return spot;
    }
    this.maze.growAround(8, 8, 1);
    return this.maze.nearestWalkable(8, 8, 16) ?? { x: 8, y: 8 };
  }

  activityCentroid(): { x: number; y: number } {
    const living = [...this.agents.values()].filter((a) => a.state !== 'dead');
    if (living.length === 0) return { x: 8, y: 8 };
    const x = living.reduce((s, a) => s + a.x, 0) / living.length;
    const y = living.reduce((s, a) => s + a.y, 0) / living.length;
    return { x, y };
  }

  private decorateNewChunks() {
    const fresh = this.maze.newlyGenerated.splice(0);
    for (const c of fresh) {
      const rng = rngFor(this.seed, 'decor', c.cx, c.cy);
      const floorCells: { x: number; y: number }[] = [];
      for (let ly = 0; ly < CHUNK_SIZE; ly++)
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (c.tiles[ly * CHUNK_SIZE + lx] === TILE.Floor)
            floorCells.push({ x: c.cx * CHUNK_SIZE + lx, y: c.cy * CHUNK_SIZE + ly });
        }
      if (floorCells.length === 0) continue;
      const spot = () => floorCells[Math.floor(rng() * floorCells.length)]!;
      if (rng() < 0.55) {
        const s = spot();
        this.evidence.create('crt', s.x, s.y, this.tick, { meta: { lines: [] } });
      }
      if (rng() < 0.3) {
        const s = spot();
        this.evidence.create('printer', s.x, s.y, this.tick, {});
      }
      // ambient litter: somebody was here before, long ago
      if (rng() < 0.35) {
        const s = spot();
        this.evidence.create('note', s.x, s.y, this.tick, {
          text: AMBIENT_NOTES[Math.floor(rng() * AMBIENT_NOTES.length)]!,
        });
      }
      const dist = Math.max(Math.abs(c.cx), Math.abs(c.cy));
      if (rng() < Math.min(0.35, 0.08 + dist * 0.02)) {
        const s = spot();
        // the sign always points away from the origin: deeper, never out
        const arrow =
          Math.abs(c.cx) > Math.abs(c.cy) ? (c.cx > 0 ? '→' : '←') : c.cy > 0 ? '↓' : '↑';
        this.evidence.create('sign', s.x, s.y, this.tick, { text: `EXIT ${arrow}` });
      }
    }
  }

  private evictChunks() {
    const anchors: { cx: number; cy: number }[] = [];
    for (const a of this.agents.values())
      anchors.push({ cx: tileToChunk(Math.floor(a.x)), cy: tileToChunk(Math.floor(a.y)) });
    anchors.push({
      cx: tileToChunk(Math.floor(this.monsterRt.x)),
      cy: tileToChunk(Math.floor(this.monsterRt.y)),
    });
    anchors.push(...this.subscriptionAnchors());
    const evicted = this.maze.evict(anchors, 4);
    for (const key of evicted) this.evidence.unloadChunk(key);
  }

  private agentRow(a: AgentRuntime) {
    return {
      id: a.id,
      name: a.name,
      objective: a.objective,
      status: a.state === 'dead' ? 'dead' : 'live',
      x: a.x,
      y: a.y,
      stress: a.stress,
      attention: a.attention,
      hue: a.hue,
      brain_mode: a.brainKind,
      created_at: a.createdAt,
      died_at: null as number | null,
      death_cause: null as string | null,
    };
  }

  private persistAgent(a: AgentRuntime) {
    agentRepo.upsert(this.agentRow(a));
  }

  private flush(final: boolean) {
    kv.set('tick', String(this.tick));
    kv.set('monster', JSON.stringify({ x: this.monsterRt.x, y: this.monsterRt.y }));
    for (const a of this.agents.values()) {
      if (a.state !== 'dead') this.persistAgent(a);
    }
    if (final) console.log('[world] state flushed');
  }

  private recoverAgents() {
    for (const row of agentRepo.liveAgents()) {
      const mem = memoryRepo.get(row.id);
      const now = Date.now();
      this.maze.growAround(Math.floor(row.x), Math.floor(row.y), 1);
      const a: AgentRuntime = {
        id: row.id,
        name: row.name,
        objective: row.objective as Objective,
        x: row.x,
        y: row.y,
        facing: 's',
        state: 'idle',
        stress: row.stress,
        attention: row.attention,
        mindState: 'calm',
        hue: row.hue,
        brainKind: (row.brain_mode as 'mock' | 'openai') ?? 'mock',
        path: null,
        pathIdx: 0,
        currentAction: null,
        followTargetId: null,
        repathAt: 0,
        lastActionResult: 'you must have dozed off; the rooms feel rearranged',
        lastSaid: null,
        heardSinceLastDecision: [],
        nextDecisionAt: now + 2000 + Math.random() * 8000,
        deciding: false,
        memory: mem,
        decisionCount: 0,
        thoughtCount: 0,
        spawnedAtMs: row.created_at,
        restUntil: 0,
        interactUntil: 0,
        monsterVisible: false,
        deceiving: false,
        notable: 0,
        createdAt: row.created_at,
        lastSentX: NaN,
        lastSentY: NaN,
        lastSentStress: NaN,
        lastSentState: '',
        lastSentMindState: '',
        lastSentAttention: NaN,
      };
      a.mindState = deriveMindState(a);
      this.agents.set(a.id, a);
    }
  }

  // ---------- snapshot / delta for the wire ----------

  snapshotAgents(): Agent[] {
    return [...this.agents.values()].map(toWireAgent);
  }

  buildDelta(): Delta | null {
    const changed: Agent[] = [];
    for (const a of this.agents.values()) {
      if (agentDirty(a)) {
        changed.push(toWireAgent(a));
        markSent(a);
      }
    }
    const removed = this.pendingRemovals.splice(0);
    for (const id of removed) this.agents.delete(id);

    const monsterChanged = monsterDirty(this.monsterRt);
    if (monsterChanged) markMonsterSent(this.monsterRt);

    const chaosChanged = this.chaosRt.dirty;
    this.chaosRt.dirty = false;

    const evidenceAdd = this.evidence.pendingAdd.splice(0);
    const evidenceUpdate = this.evidence.pendingUpdate.splice(0);
    const evidenceRemove = this.evidence.pendingRemove.splice(0);
    const tileUpdates = this.maze.pendingTileChanges.splice(0);
    const edgeUpdates = this.maze.pendingEdgeChanges.splice(0);
    const lightUpdates = this.maze.pendingLightChanges.splice(0);
    const worldEvents = this.bus.pending.splice(0);
    const speech = this.pendingSpeech.splice(0);

    if (
      changed.length === 0 &&
      removed.length === 0 &&
      !monsterChanged &&
      !chaosChanged &&
      evidenceAdd.length === 0 &&
      evidenceUpdate.length === 0 &&
      evidenceRemove.length === 0 &&
      tileUpdates.length === 0 &&
      edgeUpdates.length === 0 &&
      lightUpdates.length === 0 &&
      worldEvents.length === 0 &&
      speech.length === 0
    ) {
      return null;
    }

    return {
      tick: this.tick,
      agents: changed,
      removedAgents: removed,
      monster: monsterChanged ? toWireMonster(this.monsterRt) : undefined,
      chaos: chaosChanged
        ? { x: this.chaosRt.x, y: this.chaosRt.y, visible: this.chaosRt.visible }
        : undefined,
      evidenceAdd,
      evidenceUpdate,
      evidenceRemove,
      tileUpdates,
      edgeUpdates,
      lightUpdates,
      worldEvents,
      speech,
    };
  }
}
