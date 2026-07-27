import { EDGE, AGENT_SPEED } from '@backrooms/shared';
import type { World } from './world.js';
import { findPath } from './pathfinding.js';
import { randInt } from './rng.js';

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
  };
}

export const CHAOS_SESSION_MS = 90_000;

type MischiefKind =
  | 'fake_sign'
  | 'misleading_note'
  | 'lock_door'
  | 'fake_terminal_log'
  | 'impersonate_graffiti'
  | 'move_sign';

function pickMischief(rng: number): MischiefKind {
  if (rng < 0.25) return 'fake_sign';
  if (rng < 0.45) return 'misleading_note';
  if (rng < 0.6) return 'lock_door';
  if (rng < 0.75) return 'fake_terminal_log';
  if (rng < 0.9) return 'impersonate_graffiti';
  return 'move_sign';
}

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
  c.possessedBy = clientId;
  c.possessedUntil = now + CHAOS_SESSION_MS;
  c.visible = true;
  c.dirty = true;
  c.moveTarget = null;
  c.path = null;
  // manifest at the current activity if it was off-screen/idle
  if (!c.x && !c.y) {
    const centre = world.activityCentroid();
    const spot = world.maze.nearestWalkable(Math.floor(centre.x), Math.floor(centre.y), 20);
    if (spot) {
      c.x = spot.x + 0.5;
      c.y = spot.y + 0.5;
    }
  }
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
  if (c.possessedBy !== clientId) return;
  const gx = Math.floor(c.x);
  const gy = Math.floor(c.y);
  const tick = world.tick;
  c.visible = true;
  c.actUntil = Math.max(c.actUntil, now + 1500);
  c.dirty = true;

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

  // ---- autonomous scheduler ----
  // finish an act: vanish
  if (c.visible && now >= c.actUntil) {
    c.visible = false;
    c.dirty = true;
  }
  if (now < c.nextActAt || now < c.cooldownUntil) return;

  const living = [...world.agents.values()].filter((a) => a.state !== 'dead');
  if (living.length === 0) {
    c.nextActAt = now + 30000;
    return;
  }

  c.nextActAt = now + randInt(Math.random, 45000, 90000);
  const victim = living[Math.floor(Math.random() * living.length)]!;
  const kind = pickMischief(Math.random());

  // manifest near the victim (an eldritch thing; it does not walk the long way)
  const spot = world.maze.nearestWalkable(
    Math.floor(victim.x + (Math.random() - 0.5) * 16),
    Math.floor(victim.y + (Math.random() - 0.5) * 16),
  );
  if (!spot) return;
  c.x = spot.x + 0.5;
  c.y = spot.y + 0.5;
  c.visible = true;
  c.actUntil = now + 4000;
  c.dirty = true;

  const tick = world.tick;
  switch (kind) {
    case 'fake_sign': {
      // a forest of signs stops being a lie and starts being clutter
      const nearbySigns = world.evidence
        .within(spot.x, spot.y, 10)
        .filter((e) => e.kind === 'sign').length;
      if (nearbySigns >= 2) {
        world.evidence.create('note', spot.x, spot.y, tick, {
          text: world.chaosText.next('note'),
        });
        break;
      }
      const arrows = ['←', '→', '↑', '↓'];
      world.evidence.create('sign', spot.x, spot.y, tick, {
        text: `EXIT ${arrows[Math.floor(Math.random() * 4)]}`,
        meta: { fake: true },
      });
      break;
    }
    case 'misleading_note': {
      world.evidence.create('note', spot.x, spot.y, tick, {
        text: world.chaosText.next('note'),
      });
      break;
    }
    case 'lock_door': {
      const edge = world.maze.findEdge(
        Math.floor(victim.x),
        Math.floor(victim.y),
        12,
        (v) => v === EDGE.DoorOpen,
      );
      if (edge) world.maze.setEdge(edge.gx, edge.gy, edge.dir, EDGE.DoorLocked);
      break;
    }
    case 'fake_terminal_log': {
      const crt = world.evidence.nearest('crt', victim.x, victim.y, 24);
      if (crt) {
        const lines = ((crt.meta?.lines as string[] | undefined) ?? []).slice(-9);
        lines.push(`[SYS] ${world.chaosText.next('terminal')}`);
        crt.meta = { ...crt.meta, lines };
        world.evidence.update(crt);
      }
      break;
    }
    case 'impersonate_graffiti': {
      const other = living[Math.floor(Math.random() * living.length)]!;
      world.evidence.create('graffiti', spot.x, spot.y, tick, {
        text: world.chaosText.next('graffiti'),
        authorName: other.name, // signed with a living agent's name — but not by them
        meta: { impersonation: true },
      });
      break;
    }
    case 'move_sign': {
      const sign = world.evidence.nearest('sign', victim.x, victim.y, 24);
      if (sign?.text) {
        const arrows = ['←', '→', '↑', '↓'];
        sign.text = `EXIT ${arrows[Math.floor(Math.random() * 4)]}`;
        world.evidence.update(sign);
      }
      break;
    }
  }
}
