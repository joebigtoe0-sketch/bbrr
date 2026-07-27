import { EDGE, AGENT_SPEED } from '@backrooms/shared';
import type { World } from './world.js';
import { findPath } from './pathfinding.js';

/**
 * The Chaos Agent: a glitchy body that sabotages the maze. Normally an
 * autonomous mischief scheduler, but a watcher can POSSESS it for a timed
 * session — steering it by clicking and choosing each act. While possessed
 * the autonomous scheduler is suspended.
 */
export interface ChaosRuntime {
  x: number;
  y: number;
  visible: boolean;
  nextActAt: number;
  actUntil: number;
  dirty: boolean;
  // ---- possession ----
  possessedBy: string | null; // ws client id holding control
  possessedUntil: number;
  cooldownUntil: number; // autonomous scheduler waits after a possession ends
  moveTarget: { x: number; y: number } | null;
  path: { x: number; y: number }[] | null;
  pathIdx: number;
  lastSentPossessed: boolean;
  /** nobody may claim the chaos again until this time (global cooldown) */
  claimCooldownUntil: number;
  /** false until the possessor's first click places the body */
  placed: boolean;
}

export function createChaos(): ChaosRuntime {
  return {
    x: 0,
    y: 0,
    visible: false,
    nextActAt: Date.now() + 30000,
    actUntil: 0,
    dirty: false,
    possessedBy: null,
    possessedUntil: 0,
    cooldownUntil: 0,
    moveTarget: null,
    path: null,
    pathIdx: 0,
    lastSentPossessed: false,
    claimCooldownUntil: 0,
    placed: false,
  };
}

export const CHAOS_SESSION_MS = 20_000;

// ---------------- possession API (called from wsHub) ----------------

/** Try to seize control. Returns the session end time, or an error. */
export function claimChaos(
  world: World,
  clientId: string,
  now: number,
): { ok: true; until: number } | { ok: false; error: string } {
  const c = world.chaosRt;
  if (c.possessedBy && c.possessedBy !== clientId && now < c.possessedUntil) {
    return { ok: false, error: 'someone else is the chaos right now' };
  }
  if (now < c.claimCooldownUntil) {
    const secs = Math.ceil((c.claimCooldownUntil - now) / 1000);
    return { ok: false, error: `the chaos is still settling. wait ${secs}s` };
  }
  // global lockout: this session (20s) plus a 20s cool-off afterwards
  c.claimCooldownUntil = now + CHAOS_SESSION_MS + 20_000;
  c.possessedBy = clientId;
  c.possessedUntil = now + CHAOS_SESSION_MS;
  c.moveTarget = null;
  c.path = null;
  c.placed = false; // it does not exist until the possessor clicks the map
  c.visible = false;
  c.dirty = true;
  return { ok: true, until: c.possessedUntil };
}

export function releaseChaos(world: World, clientId: string, now: number) {
  const c = world.chaosRt;
  if (c.possessedBy !== clientId) return;
  c.possessedBy = null;
  c.possessedUntil = 0;
  c.moveTarget = null;
  c.path = null;
  c.cooldownUntil = now + 20000;
  c.nextActAt = now + 20000;
  c.actUntil = now + 1500; // fade out shortly
  c.dirty = true;
}

export function moveChaos(world: World, clientId: string, x: number, y: number) {
  const c = world.chaosRt;
  if (c.possessedBy !== clientId) return;
  const spot = world.maze.nearestWalkable(Math.floor(x), Math.floor(y), 6);
  if (!spot) return;
  if (!c.placed) {
    // materialise where the watcher first clicks
    c.x = spot.x + 0.5;
    c.y = spot.y + 0.5;
    c.placed = true;
    c.visible = true;
    c.path = null;
    c.moveTarget = null;
    c.dirty = true;
    return;
  }
  c.moveTarget = spot;
  const path = findPath({
    startX: Math.floor(c.x),
    startY: Math.floor(c.y),
    goalX: spot.x,
    goalY: spot.y,
    canStep: world.maze.canStep,
  });
  c.path = path;
  c.pathIdx = 0;
}

/** Perform a mischief act at the chaos body's current tile. */
export function actChaos(
  world: World,
  clientId: string,
  kind: 'sign' | 'note' | 'lock' | 'terminal' | 'graffiti',
  text: string | undefined,
  now: number,
) {
  const c = world.chaosRt;
  if (c.possessedBy !== clientId || !c.placed) return;
  c.visible = true;
  c.actUntil = Math.max(c.actUntil, now + 1500);
  c.dirty = true;
  performChaosAct(world, kind, text);
  // one act per possession — acting ends the session immediately
  releaseChaos(world, clientId, now);
}

type ChaosKind = 'sign' | 'note' | 'lock' | 'terminal' | 'graffiti';

/** the actual mischief, shared by possession and the autonomous scheduler */
function performChaosAct(world: World, kind: ChaosKind, text: string | undefined) {
  const c = world.chaosRt;
  const gx = Math.floor(c.x);
  const gy = Math.floor(c.y);
  const tick = world.tick;
  switch (kind) {
    case 'sign':
      world.evidence.create('sign', gx, gy, tick, {
        text: (text || 'EXIT →').slice(0, 40),
        meta: { fake: true },
      });
      break;
    case 'note':
      world.evidence.create('note', gx, gy, tick, {
        text: (text || world.chaosText.next('note')).slice(0, 160),
      });
      break;
    case 'lock': {
      const edge = world.maze.findEdge(gx, gy, 4, (v) => v === EDGE.DoorOpen);
      if (edge) world.maze.setEdge(edge.gx, edge.gy, edge.dir, EDGE.DoorLocked);
      break;
    }
    case 'terminal': {
      const crt = world.evidence.nearest('crt', c.x, c.y, 6);
      if (crt) {
        const lines = ((crt.meta?.lines as string[] | undefined) ?? []).slice(-9);
        lines.push(`[SYS] ${(text || world.chaosText.next('terminal')).slice(0, 120)}`);
        crt.meta = { ...crt.meta, lines };
        world.evidence.update(crt);
      }
      break;
    }
    case 'graffiti': {
      // sign it with the nearest living agent's name — impersonation
      const victims = [...world.agents.values()]
        .filter((a) => a.state !== 'dead')
        .map((a) => ({ a, d: Math.hypot(a.x - c.x, a.y - c.y) }))
        .sort((p, q) => p.d - q.d);
      const impersonated = victims[0]?.a.name;
      world.evidence.create('graffiti', gx, gy, tick, {
        text: (text || world.chaosText.next('graffiti')).slice(0, 120),
        authorName: impersonated,
        meta: { impersonation: !!impersonated },
      });
      break;
    }
  }
}

// ---------------- per-tick ----------------

export function tickChaos(world: World, now: number, dtMs: number) {
  const c = world.chaosRt;

  // ---- possessed: steer, don't schedule ----
  if (c.possessedBy) {
    if (now >= c.possessedUntil) {
      releaseChaos(world, c.possessedBy, now);
    } else {
      c.visible = true;
      // walk toward the click target
      if (c.path && c.pathIdx < c.path.length) {
        let remaining = (AGENT_SPEED * 1.15 * dtMs) / 1000;
        while (remaining > 0 && c.path && c.pathIdx < c.path.length) {
          const wp = c.path[c.pathIdx]!;
          const tx = wp.x + 0.5;
          const ty = wp.y + 0.5;
          const d = Math.hypot(tx - c.x, ty - c.y);
          if (d <= remaining) {
            c.x = tx;
            c.y = ty;
            remaining -= d;
            c.pathIdx++;
          } else {
            c.x += ((tx - c.x) / d) * remaining;
            c.y += ((ty - c.y) / d) * remaining;
            remaining = 0;
          }
        }
        c.dirty = true;
      }
      return;
    }
  }

  // ---- autonomous mischief (when nobody's possessing it) ----
  // every so often it materialises near someone, defaces something, then fades.
  if (now >= c.cooldownUntil && now >= c.nextActAt) {
    const targets = [...world.agents.values()].filter((a) => a.state !== 'dead');
    if (targets.length === 0) {
      c.nextActAt = now + 20000;
    } else {
      const a = targets[Math.floor(Math.random() * targets.length)]!;
      const ox = Math.floor(a.x + (Math.random() - 0.5) * 10);
      const oy = Math.floor(a.y + (Math.random() - 0.5) * 10);
      const spot = world.maze.nearestWalkable(ox, oy, 8);
      if (spot) {
        c.x = spot.x + 0.5;
        c.y = spot.y + 0.5;
        c.placed = true;
        c.visible = true;
        c.dirty = true;
        const kinds: ChaosKind[] = ['sign', 'note', 'note', 'graffiti', 'graffiti', 'terminal', 'lock'];
        performChaosAct(world, kinds[Math.floor(Math.random() * kinds.length)]!, undefined);
        c.actUntil = now + 4000; // linger a few seconds, then vanish
        c.nextActAt = now + 45000 + Math.random() * 45000; // 45-90s between visits
      } else {
        c.nextActAt = now + 15000;
      }
    }
  }

  // fade the body out once its lingering time is up
  if (!c.possessedBy && c.visible && now >= c.actUntil) {
    c.visible = false;
    c.dirty = true;
  }
}
