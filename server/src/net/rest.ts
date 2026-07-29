import express from 'express';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Request, Response, NextFunction } from 'express';
import { db } from '../db/db.js';
import { AdminDebugBody, AdminEventBody, AdminTweetBody, SpawnAgentBody } from '@nightrooms/shared';
import { config, isDev } from '../config.js';
import { agentRepo, caseFileRepo, eventRepo, kv, thoughtRepo, tweetRepo } from '../db/repo.js';
import type { World } from '../sim/world.js';
import type { BrainScheduler } from '../brain/scheduler.js';
import type { XClient } from '../social/x.js';

// each IP may have exactly ONE agent inside at a time; when it dies they may
// send another. A generous hourly cap remains as an anti-spam backstop.
const ipAgent = new Map<string, string>(); // ip -> the agent id they own
const spawnBuckets = new Map<string, number[]>();
const SPAWNS_PER_HOUR = 20;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const times = (spawnBuckets.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (times.length >= SPAWNS_PER_HOUR) {
    spawnBuckets.set(ip, times);
    return true;
  }
  times.push(now);
  spawnBuckets.set(ip, times);
  return false;
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.header('authorization') ?? '';
  if (auth !== `Bearer ${config.ADMIN_PASSWORD}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function buildRest(world: World, scheduler: BrainScheduler, x?: XClient): Express {
  const app = express();
  app.use(express.json());

  app.post('/api/agents', (req, res) => {
    const parsed = SpawnAgentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', detail: parsed.error.issues[0]?.message });
      return;
    }
    const ip = req.ip ?? 'unknown';
    // one living agent per IP
    const owned = ipAgent.get(ip);
    if (owned) {
      const a = world.agents.get(owned);
      if (a && a.state !== 'dead') {
        res.status(429).json({ error: 'already_inside' });
        return;
      }
    }
    if (rateLimited(ip)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const result = world.spawnAgent(parsed.data.objective, parsed.data.name);
    if ('error' in result) {
      res.status(429).json({ error: result.error });
      return;
    }
    ipAgent.set(ip, result.id);
    res.status(201).json({ agentId: result.id, name: result.name });
  });

  app.get('/api/agents', (_req, res) => {
    res.json({
      living: world.snapshotAgents(),
      recentDeaths: agentRepo.recentDeaths(20).map((r) => ({
        id: r.id,
        name: r.name,
        objective: r.objective,
        diedAt: r.died_at,
        cause: r.death_cause,
      })),
    });
  });

  app.post('/api/admin/event', requireAdmin, (req, res) => {
    const parsed = AdminEventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const { type, payload } = parsed.data;
    // viral_post without an agent targets the most notable living agent
    const finalPayload: Record<string, unknown> = { ...payload, source: 'admin' };
    if (type === 'viral_post' && !payload.agentId) {
      const top = [...world.agents.values()]
        .filter((a) => a.state !== 'dead')
        .sort((a, b) => b.notable - a.notable)[0];
      if (top) finalPayload.agentId = top.id;
    }
    const event = world.bus.emit(type, finalPayload);
    res.json({ ok: true, eventId: event.id });
  });

  // inject an inbound tweet — a mock mention/reply for testing how the agents
  // react. In live X mode real mentions arrive automatically via the poller;
  // this endpoint remains handy for manual injection.
  app.post('/api/admin/tweet', requireAdmin, (req, res) => {
    const parsed = AdminTweetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    world.announceTweet(parsed.data.handle, parsed.data.text);
    res.json({ ok: true });
  });

  // post out to our X account manually (also fired automatically for maze tweets)
  app.post('/api/admin/post', requireAdmin, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const id = await x?.postTweet(text.trim());
    res.json({ ok: true, mode: config.X_MODE, id });
  });

  app.get('/api/tweets', (_req, res) => {
    res.json({ tweets: tweetRepo.latest(50) });
  });

  // public runtime config the client reads (currently just the contract address).
  // stored in the DB so it survives restarts and needs no redeploy to change.
  app.get('/api/meta', (_req, res) => {
    res.json({ contractAddress: kv.get('contractAddress') ?? '' });
  });

  // set/clear the contract address at runtime from the admin panel
  app.post('/api/admin/ca', requireAdmin, (req, res) => {
    const ca = typeof req.body?.ca === 'string' ? req.body.ca.trim() : '';
    kv.set('contractAddress', ca);
    console.log(`[admin] contract address ${ca ? `set to ${ca}` : 'cleared'}`);
    res.json({ ok: true, contractAddress: ca });
  });

  // the LOG's back-history: recent thoughts + world events merged chronologically,
  // so a spectator who just tuned in still sees what led up to now
  app.get('/api/log', (_req, res) => {
    const N = 160;
    const thoughts = thoughtRepo.recent(N).map((r) => ({
      kind: 'thought' as const,
      at: r.created_at,
      name: r.name,
      hue: r.hue,
      text: r.text,
      mindState: r.mind_state,
    }));
    const events = eventRepo.recent(N).map((r) => ({
      kind: 'event' as const,
      at: r.created_at,
      type: r.type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
    const entries = [...thoughts, ...events].sort((a, b) => a.at - b.at).slice(-N);
    res.json({ entries });
  });

  app.get('/api/records', (_req, res) => {
    res.json({ records: caseFileRepo.latest(30) });
  });

  // FULL RESET: wipe the world file and exit — the process supervisor
  // (Railway / whatever runs `npm start`) boots a fresh maze with a new seed.
  app.post('/api/admin/reset', requireAdmin, (_req, res) => {
    res.json({ ok: true, note: 'world wiped — server restarting with a fresh maze' });
    console.log('[admin] FULL RESET requested — wiping the world');
    setTimeout(() => {
      try {
        world.stop();
        db.close();
        for (const suffix of ['', '-wal', '-shm']) {
          const f = config.DB_PATH + suffix;
          if (existsSync(f)) unlinkSync(f);
        }
      } catch (err) {
        console.error('[admin] reset cleanup failed:', err);
      }
      process.exit(1); // non-zero so ON_FAILURE restart policies respawn us
    }, 300);
  });

  app.post('/api/admin/debug', requireAdmin, (req, res) => {
    if (!isDev) {
      res.status(403).json({ error: 'debug disabled in production' });
      return;
    }
    const parsed = AdminDebugBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const d = parsed.data;
    switch (d.action) {
      case 'teleport_monster': {
        if (d.x === undefined || d.y === undefined) break;
        world.maze.growAround(Math.floor(d.x), Math.floor(d.y), 1);
        const spot = world.maze.nearestWalkable(Math.floor(d.x), Math.floor(d.y));
        if (spot) {
          world.monsterRt.x = spot.x + 0.5;
          world.monsterRt.y = spot.y + 0.5;
          world.monsterRt.mode = 'roam';
          world.monsterRt.path = null;
        }
        break;
      }
      case 'force_stress': {
        const a = d.agentId ? world.agents.get(d.agentId) : undefined;
        if (a) a.stress = Math.max(0, Math.min(100, d.value ?? 90));
        break;
      }
      case 'force_deceiving': {
        const a = d.agentId ? world.agents.get(d.agentId) : undefined;
        if (a) a.deceiving = (d.value ?? 1) > 0;
        break;
      }
    }
    res.json({ ok: true });
  });

  // production: serve the built client from the same port (Railway runs one service)
  const clientDist = resolve(fileURLToPath(import.meta.url), '../../../../client/dist');
  if (existsSync(clientDist)) {
    app.get('/admin', (_req, res) => res.redirect('/admin.html'));
    app.use(express.static(clientDist));
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      tick: world.tick,
      seed: world.seed,
      agents: [...world.agents.values()].filter((a) => a.state !== 'dead').length,
      spectators: world.spectatorCount,
      loadedChunks: world.maze.loadedChunkCount,
      llm: {
        mode: config.BRAIN_MODE,
        model: config.OPENAI_MODEL,
        budgetExceeded: scheduler.budgetExceeded,
        ...scheduler.stats,
        usdToday: Math.round(scheduler.stats.usdToday * 10000) / 10000,
      },
    });
  });

  return app;
}
