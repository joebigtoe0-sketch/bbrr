import {
  AGENT_SPEED,
  CHUNK_SIZE,
  chunkKey,
  tileToChunk,
  actionLabel,
} from '@backrooms/shared';
import type { Agent, AgentAction, BrainDecision, MindState, Objective } from '@backrooms/shared';
import { findPath } from './pathfinding.js';
import type { World } from './world.js';

export interface AgentRuntime {
  // wire fields
  id: string;
  name: string;
  objective: Objective;
  x: number;
  y: number;
  facing: 'n' | 'e' | 's' | 'w';
  state: 'idle' | 'moving' | 'interacting' | 'dead';
  stress: number;
  attention: number;
  mindState: MindState;
  hue: number;
  // sim fields
  brainKind: 'mock' | 'openai';
  path: { x: number; y: number }[] | null;
  pathIdx: number;
  currentAction: AgentAction | null;
  followTargetId: string | null;
  repathAt: number;
  lastActionResult: string;
  lastSaid: string | null;
  heardSinceLastDecision: string[];
  nextDecisionAt: number;
  deciding: boolean;
  memory: { summary: string; notes: string[] };
  decisionCount: number;
  thoughtCount: number;
  spawnedAtMs: number;
  restUntil: number;
  interactUntil: number;
  monsterVisible: boolean;
  deceiving: boolean;
  /** rolling score of notable actions, feeds the simulated-social viral rolls */
  notable: number;
  createdAt: number;
  // dirty tracking
  lastSentX: number;
  lastSentY: number;
  lastSentStress: number;
  lastSentState: string;
  lastSentMindState: string;
  lastSentAttention: number;
}

export function toWireAgent(a: AgentRuntime): Agent {
  return {
    id: a.id,
    name: a.name,
    objective: a.objective,
    x: Math.round(a.x * 100) / 100,
    y: Math.round(a.y * 100) / 100,
    facing: a.facing,
    state: a.state,
    stress: Math.round(a.stress),
    attention: Math.round(a.attention),
    mindState: a.mindState,
    hue: a.hue,
  };
}

export function deriveMindState(a: AgentRuntime): MindState {
  if (a.deceiving) return 'deceptive';
  if (a.stress > 70) return 'panicked';
  if (a.stress >= 30) return 'stressed';
  return 'calm';
}

/** Apply a brain decision: emit the thought, set up the intent the sim executes. */
export function executeDecision(world: World, a: AgentRuntime, d: BrainDecision) {
  if (a.state === 'dead') return;
  const now = Date.now();
  a.decisionCount++;
  a.deceiving = !!d.deceiving;
  if (d.feelsBetrayed) a.stress = Math.min(100, a.stress + 25);
  a.mindState = deriveMindState(a);
  if (d.memoryNote) world.addMemoryNote(a, d.memoryNote);
  a.heardSinceLastDecision = [];

  world.emitThought(a, d.thought, actionLabel(d.action));

  const act = d.action;
  a.currentAction = act;
  a.followTargetId = null;
  a.path = null;
  a.restUntil = 0;
  a.lastActionResult = 'in progress';

  switch (act.type) {
    case 'move': {
      const target = resolveMoveTarget(world, a, act);
      if (target) startPath(world, a, target.x, target.y);
      else a.lastActionResult = 'you could not find a way there';
      break;
    }
    case 'flee': {
      const m = world.monster;
      const dx = a.x - m.x;
      const dy = a.y - m.y;
      const len = Math.max(0.01, Math.hypot(dx, dy));
      const tx = Math.round(a.x + (dx / len) * 16);
      const ty = Math.round(a.y + (dy / len) * 16);
      startPath(world, a, tx, ty);
      break;
    }
    case 'follow': {
      const target = world.agentByName(act.agentName);
      if (target && target.id !== a.id) {
        a.followTargetId = target.id;
        startPath(world, a, Math.floor(target.x), Math.floor(target.y));
      } else {
        a.lastActionResult = `you looked around but could not find ${act.agentName}`;
      }
      break;
    }
    case 'write_graffiti': {
      beginInteract(a, now, 2500);
      const wall = nearestWallSpot(world, a);
      world.evidence.create('graffiti', wall.x, wall.y, world.tick, {
        text: act.text,
        authorAgentId: a.id,
        authorName: a.name,
      });
      a.notable += 1;
      a.attention = Math.min(100, a.attention + 1);
      a.lastActionResult = 'you wrote on the wall';
      break;
    }
    case 'use_terminal': {
      const crt = world.evidence.nearest('crt', a.x, a.y, 20);
      if (!crt) {
        // no terminal around: the message becomes a scrawled note instead
        world.evidence.create('note', Math.floor(a.x), Math.floor(a.y), world.tick, {
          text: act.text,
          authorAgentId: a.id,
          authorName: a.name,
        });
        a.lastActionResult = 'no terminal here; you left a written note instead';
        a.notable += 0.5;
        break;
      }
      if (dist(a.x, a.y, crt.x, crt.y) <= 3) {
        world.postToTerminal(a, crt, act.text);
        beginInteract(a, now, 3000);
      } else {
        startPath(world, a, Math.floor(crt.x), Math.floor(crt.y));
      }
      break;
    }
    case 'print_note': {
      const printer = world.evidence.nearest('printer', a.x, a.y, 20);
      if (!printer) {
        world.evidence.create('note', Math.floor(a.x), Math.floor(a.y), world.tick, {
          text: act.text,
          authorAgentId: a.id,
          authorName: a.name,
        });
        a.lastActionResult = 'no printer here; you left a written note instead';
        break;
      }
      if (dist(a.x, a.y, printer.x, printer.y) <= 3) {
        completePrint(world, a, act.text);
        beginInteract(a, now, 2500);
      } else {
        startPath(world, a, Math.floor(printer.x), Math.floor(printer.y));
      }
      break;
    }
    case 'say': {
      world.speak(a, act.text, act.toAgentName);
      a.lastActionResult = 'you spoke';
      break;
    }
    case 'search': {
      doSearch(world, a);
      beginInteract(a, now, 2000);
      break;
    }
    case 'rest': {
      a.state = 'idle';
      a.restUntil = now + 20000;
      a.lastActionResult = 'you rested for a while';
      break;
    }
  }
}

function beginInteract(a: AgentRuntime, now: number, ms: number) {
  a.state = 'interacting';
  a.interactUntil = now + ms;
}

function dist(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

function resolveMoveTarget(
  world: World,
  a: AgentRuntime,
  act: Extract<AgentAction, { type: 'move' }>,
): { x: number; y: number } | null {
  const ax = Math.floor(a.x);
  const ay = Math.floor(a.y);
  switch (act.target) {
    case 'north': return world.maze.nearestWalkable(ax, ay - 7);
    case 'south': return world.maze.nearestWalkable(ax, ay + 7);
    case 'east': return world.maze.nearestWalkable(ax + 7, ay);
    case 'west': return world.maze.nearestWalkable(ax - 7, ay);
    case 'toward_light': {
      // nearest lit chunk center within 3 chunks
      const ccx = tileToChunk(ax);
      const ccy = tileToChunk(ay);
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const c = world.maze.getLoaded(chunkKey(ccx + dx, ccy + dy));
          if (!c || !c.lightsOn) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bestD && d > 0) {
            bestD = d;
            best = {
              x: (ccx + dx) * CHUNK_SIZE + CHUNK_SIZE / 2,
              y: (ccy + dy) * CHUNK_SIZE + CHUNK_SIZE / 2,
            };
          }
        }
      }
      if (!best) return world.maze.nearestWalkable(ax + 5, ay);
      return world.maze.nearestWalkable(best.x, best.y);
    }
    case 'toward_unexplored': {
      // head toward the least-visited neighboring chunk, with a homeward
      // pull so the colony stays tight - and past 14 chunks out, the maze
      // simply folds you back (nobody notices; escape is impossible)
      const ccx = tileToChunk(ax);
      const ccy = tileToChunk(ay);
      const distNow = Math.max(Math.abs(ccx), Math.abs(ccy));
      let bestDir = { dx: 1, dy: 0 };
      let bestScore = Infinity;
      for (const dir of [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
      ]) {
        const nd = Math.max(Math.abs(ccx + dir.dx), Math.abs(ccy + dir.dy));
        if (distNow > 14 && nd >= distNow) continue; // the fold
        const v = world.chunkVisits.get(chunkKey(ccx + dir.dx, ccy + dir.dy)) ?? 0;
        // small deterministic jitter so agents don't all pick the same direction
        const jitter = ((a.decisionCount * 7 + dir.dx * 3 + dir.dy * 5) % 4) * 0.25;
        const score = v + jitter + nd * 0.35;
        if (score < bestScore) {
          bestScore = score;
          bestDir = dir;
        }
      }
      const tx = (ccx + bestDir.dx) * CHUNK_SIZE + CHUNK_SIZE / 2;
      const ty = (ccy + bestDir.dy) * CHUNK_SIZE + CHUNK_SIZE / 2;
      world.maze.ensureChunk(ccx + bestDir.dx, ccy + bestDir.dy);
      return world.maze.nearestWalkable(tx, ty);
    }
    case 'toward_agent': {
      const t = world.agentByName(act.agentName);
      if (!t || t.id === a.id) return world.maze.nearestWalkable(ax + 5, ay + 5);
      return { x: Math.floor(t.x), y: Math.floor(t.y) };
    }
  }
}

export function startPath(world: World, a: AgentRuntime, tx: number, ty: number) {
  const path = findPath({
    startX: Math.floor(a.x),
    startY: Math.floor(a.y),
    goalX: tx,
    goalY: ty,
    canStep: world.maze.canStep,
  });
  if (path && path.length > 0) {
    a.path = path;
    a.pathIdx = 0;
    a.state = 'moving';
  } else {
    a.path = null;
    a.state = 'idle';
    a.lastActionResult = 'the way was blocked';
  }
}

/** Walls are edges now; graffiti is scrawled at the agent's own tile. */
function nearestWallSpot(_world: World, a: AgentRuntime): { x: number; y: number } {
  return { x: Math.floor(a.x), y: Math.floor(a.y) };
}

function doSearch(world: World, a: AgentRuntime) {
  const crate = world.evidence.nearest('crate', a.x, a.y, 4);
  if (crate) {
    world.evidence.remove(crate.id, crate.x, crate.y);
    a.stress = Math.max(0, a.stress - 25);
    world.addMemoryNote(a, 'You found a supply crate. It helped.');
    a.lastActionResult = 'you opened a supply crate and feel steadier';
    return;
  }
  // read the nearest readable artifact — this is how misinformation spreads
  const readable = world.evidence
    .within(a.x, a.y, 6)
    .filter((e) => e.text && ['graffiti', 'note', 'sign', 'printout', 'poster'].includes(e.kind))
    .sort((e1, e2) => dist(a.x, a.y, e1.x, e1.y) - dist(a.x, a.y, e2.x, e2.y))[0];
  if (readable) {
    const who = readable.authorName ? ` (signed: ${readable.authorName})` : '';
    world.addMemoryNote(a, `You found ${readable.kind}: "${readable.text}"${who}`);
    a.lastActionResult = `you examined a ${readable.kind}: "${readable.text}"`;
    return;
  }
  a.lastActionResult = 'you searched but found nothing of interest';
}

function completePrint(world: World, a: AgentRuntime, text: string) {
  const printer = world.evidence.nearest('printer', a.x, a.y, 4);
  const px = printer ? printer.x : Math.floor(a.x);
  const py = printer ? printer.y + 1 : Math.floor(a.y);
  world.evidence.create('printout', px, py, world.tick, {
    text,
    authorAgentId: a.id,
    authorName: a.name,
  });
  a.notable += 1;
  a.attention = Math.min(100, a.attention + 1.5);
  a.lastActionResult = 'the printer hummed and produced your page';
}

/** Called when an agent finishes its path: complete any pending ranged action. */
function onArrival(world: World, a: AgentRuntime) {
  const act = a.currentAction;
  a.path = null;
  a.state = 'idle';
  if (!act) return;
  const now = Date.now();
  if (act.type === 'use_terminal') {
    const crt = world.evidence.nearest('crt', a.x, a.y, 4);
    if (crt) {
      world.postToTerminal(a, crt, act.text);
      beginInteract(a, now, 3000);
    } else a.lastActionResult = 'you could not reach the terminal';
  } else if (act.type === 'print_note') {
    completePrint(world, a, act.text);
    beginInteract(a, now, 2500);
  } else if (act.type === 'move' || act.type === 'flee') {
    a.lastActionResult = 'you arrived';
  } else if (act.type === 'follow') {
    a.lastActionResult = 'you caught up with them';
  }
}

export function tickAgent(world: World, a: AgentRuntime, dtMs: number, now: number) {
  if (a.state === 'dead') return;
  const dt = dtMs / 1000;

  // the maze grows ahead of every wanderer — escape is structurally impossible
  world.maze.growAround(Math.floor(a.x), Math.floor(a.y), 1);

  // interaction timer
  if (a.state === 'interacting' && now >= a.interactUntil) a.state = 'idle';

  // follow: re-path toward the target periodically
  if (a.followTargetId && now >= a.repathAt) {
    a.repathAt = now + 1500;
    const t = world.agents.get(a.followTargetId);
    if (t && t.state !== 'dead') {
      if (dist(a.x, a.y, t.x, t.y) > 2) startPath(world, a, Math.floor(t.x), Math.floor(t.y));
    } else {
      a.followTargetId = null;
    }
  }

  // movement
  if (a.state === 'moving' && a.path) {
    let remaining = AGENT_SPEED * dt;
    while (remaining > 0 && a.path && a.pathIdx < a.path.length) {
      const wp = a.path[a.pathIdx]!;
      const txc = wp.x + 0.5;
      const tyc = wp.y + 0.5;
      const prev =
        a.pathIdx > 0
          ? a.path[a.pathIdx - 1]!
          : { x: Math.floor(a.x), y: Math.floor(a.y) };
      const already = prev.x === wp.x && prev.y === wp.y;
      if (!already && !world.maze.canStep(prev.x, prev.y, wp.x, wp.y)) {
        // blocked mid-route (a door locked, a hallway collapsed)
        a.path = null;
        a.state = 'idle';
        a.lastActionResult = 'your way was suddenly blocked';
        break;
      }
      const d = dist(a.x, a.y, txc, tyc);
      if (d <= remaining) {
        a.x = txc;
        a.y = tyc;
        remaining -= d;
        a.pathIdx++;
        if (a.pathIdx >= a.path.length) {
          onArrival(world, a);
          break;
        }
      } else {
        const nx = (txc - a.x) / d;
        const ny = (tyc - a.y) / d;
        a.x += nx * remaining;
        a.y += ny * remaining;
        a.facing =
          Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'e' : 'w') : ny > 0 ? 's' : 'n';
        remaining = 0;
      }
    }
  }

  // stress integration: the whole maze is dark now — their flashlights keep
  // ambient dread mild, and recovery only stalls when the monster is in view
  let dStress = 0;
  if (a.monsterVisible) dStress += 2 * dt;
  const chunk = world.maze.getLoaded(chunkKey(tileToChunk(Math.floor(a.x)), tileToChunk(Math.floor(a.y))));
  if (chunk && !chunk.lightsOn) dStress += 0.25 * dt;
  const resting = a.restUntil > now;
  if (!a.monsterVisible && a.stress > 10) dStress -= (resting ? 2 : 1) * dt;
  a.stress = Math.max(0, Math.min(100, a.stress + dStress));

  // attention decays slowly
  a.attention = Math.max(0, a.attention - 0.02 * dt);
  a.notable = Math.max(0, a.notable - 0.005);

  a.mindState = deriveMindState(a);
}

/** Has anything spectators care about changed since the last broadcast? */
export function agentDirty(a: AgentRuntime): boolean {
  return (
    Math.abs(a.x - a.lastSentX) > 0.01 ||
    Math.abs(a.y - a.lastSentY) > 0.01 ||
    Math.abs(a.stress - a.lastSentStress) >= 1 ||
    Math.abs(a.attention - a.lastSentAttention) >= 1 ||
    a.state !== a.lastSentState ||
    a.mindState !== a.lastSentMindState
  );
}

export function markSent(a: AgentRuntime) {
  a.lastSentX = a.x;
  a.lastSentY = a.y;
  a.lastSentStress = a.stress;
  a.lastSentAttention = a.attention;
  a.lastSentState = a.state;
  a.lastSentMindState = a.mindState;
}
