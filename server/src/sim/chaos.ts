import { EDGE } from '@backrooms/shared';
import type { World } from './world.js';
import { randInt } from './rng.js';

/**
 * The Chaos Agent: a scripted mischief scheduler wearing a glitchy body.
 * Text content comes from a queue refilled by one batched LLM call every
 * ~5 minutes (or a canned library in mock mode) — see brain/chaosText.ts.
 */
export interface ChaosRuntime {
  x: number;
  y: number;
  visible: boolean;
  nextActAt: number;
  actUntil: number;
  dirty: boolean;
}

export function createChaos(): ChaosRuntime {
  return { x: 0, y: 0, visible: false, nextActAt: Date.now() + 30000, actUntil: 0, dirty: false };
}

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

export function tickChaos(world: World, now: number) {
  const c = world.chaosRt;

  // finish an act: vanish
  if (c.visible && now >= c.actUntil) {
    c.visible = false;
    c.dirty = true;
  }
  if (now < c.nextActAt) return;

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
      // lock an open door near the victim
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
