import { MONSTER_HUNT_SPEED, MONSTER_ROAM_SPEED } from '@backrooms/shared';
import type { MonsterState } from '@backrooms/shared';
import { findPath, hasLineOfSight } from './pathfinding.js';
import type { World } from './world.js';
import type { AgentRuntime } from './agents.js';

export interface MonsterRuntime {
  x: number;
  y: number;
  mode: 'roam' | 'hunt' | 'dormant';
  targetAgentId: string | null;
  path: { x: number; y: number }[] | null;
  pathIdx: number;
  repathAt: number;
  huntLostSightAt: number;
  dormantUntil: number;
  /** after a kill it is sated: it ignores prey and wanders off for a while */
  satedUntil: number;
  lastSentX: number;
  lastSentY: number;
  lastSentMode: string;
}

export function createMonster(x: number, y: number): MonsterRuntime {
  return {
    x,
    y,
    mode: 'roam',
    targetAgentId: null,
    path: null,
    pathIdx: 0,
    repathAt: 0,
    huntLostSightAt: 0,
    dormantUntil: 0,
    satedUntil: 0,
    lastSentX: NaN,
    lastSentY: NaN,
    lastSentMode: '',
  };
}

export function toWireMonster(m: MonsterRuntime): MonsterState {
  return {
    x: Math.round(m.x * 100) / 100,
    y: Math.round(m.y * 100) / 100,
    mode: m.mode,
    targetAgentId: m.targetAgentId ?? undefined,
  };
}

const SIGHT_RANGE = 8;
const PERCEIVE_RANGE = 10; // agents feel it from farther than it hunts

export function tickMonster(world: World, dtMs: number, now: number) {
  const m = world.monsterRt;
  const dt = dtMs / 1000;
  world.maze.growAround(Math.floor(m.x), Math.floor(m.y), 1);

  // agents perceive the monster (stress spikes on first sight)
  for (const a of world.agents.values()) {
    if (a.state === 'dead') continue;
    const d = Math.hypot(a.x - m.x, a.y - m.y);
    const visible =
      d <= PERCEIVE_RANGE && hasLineOfSight(m.x, m.y, a.x, a.y, world.maze.canStep);
    if (visible && !a.monsterVisible) {
      a.stress = Math.min(100, a.stress + 30);
      world.addMemoryNote(a, 'Something enormous moved in the dark. You ran.');
    }
    a.monsterVisible = visible;
  }

  if (m.mode === 'dormant') {
    if (now >= m.dormantUntil) m.mode = 'roam';
    return;
  }

  // acquire / keep a hunt target (not while sated after a recent kill).
  // With few residents it hunts lazily — the world should never empty in minutes.
  const living = [...world.agents.values()].filter((a) => a.state !== 'dead').length;
  const sightRange = living <= 2 ? SIGHT_RANGE / 2 : SIGHT_RANGE;
  if (m.mode === 'roam' && now >= m.satedUntil) {
    for (const a of world.agents.values()) {
      if (a.state === 'dead') continue;
      const d = Math.hypot(a.x - m.x, a.y - m.y);
      if (d <= sightRange && hasLineOfSight(m.x, m.y, a.x, a.y, world.maze.canStep)) {
        m.mode = 'hunt';
        m.targetAgentId = a.id;
        m.huntLostSightAt = now;
        m.repathAt = 0;
        break;
      }
    }
  }

  if (m.mode === 'hunt') {
    const target = m.targetAgentId ? world.agents.get(m.targetAgentId) : undefined;
    if (!target || target.state === 'dead') {
      m.mode = 'roam';
      m.targetAgentId = null;
      m.path = null;
    } else {
      const d = Math.hypot(target.x - m.x, target.y - m.y);
      const los = hasLineOfSight(m.x, m.y, target.x, target.y, world.maze.canStep);
      if (los) m.huntLostSightAt = now;
      if (now - m.huntLostSightAt > 10000) {
        // lost the trail
        m.mode = 'roam';
        m.targetAgentId = null;
        m.path = null;
      } else if (d < 1.0) {
        // kill
        world.killAgent(target as AgentRuntime, 'taken by the thing in the halls');
        m.mode = 'dormant';
        m.dormantUntil = now + 60000; // lingers over the corpse
        // then wanders off, uninterested — much longer when few remain
        m.satedUntil = now + (living <= 3 ? 480000 : 240000);
        m.targetAgentId = null;
        m.path = null;
        return;
      } else if (now >= m.repathAt) {
        m.repathAt = now + 1000;
        m.path = findPath({
          startX: Math.floor(m.x),
          startY: Math.floor(m.y),
          goalX: Math.floor(target.x),
          goalY: Math.floor(target.y),
          canStep: world.maze.canStep,
        });
        m.pathIdx = 0;
      }
    }
  }

  if (m.mode === 'roam' && (!m.path || m.pathIdx >= (m.path?.length ?? 0))) {
    // wander toward the neighborhood of the nearest agent cluster
    const agents = [...world.agents.values()].filter((a) => a.state !== 'dead');
    if (agents.length > 0) {
      const anchor = agents[Math.floor(Math.random() * agents.length)]!;
      const tx = Math.floor(anchor.x + (Math.random() - 0.5) * 40);
      const ty = Math.floor(anchor.y + (Math.random() - 0.5) * 40);
      const spot = world.maze.nearestWalkable(tx, ty);
      if (spot) {
        m.path = findPath({
          startX: Math.floor(m.x),
          startY: Math.floor(m.y),
          goalX: spot.x,
          goalY: spot.y,
          canStep: world.maze.canStep,
        });
        m.pathIdx = 0;
      }
    }
  }

  // advance along path
  const speed = m.mode === 'hunt' ? MONSTER_HUNT_SPEED : MONSTER_ROAM_SPEED;
  let remaining = speed * dt;
  while (remaining > 0 && m.path && m.pathIdx < m.path.length) {
    const wp = m.path[m.pathIdx]!;
    const txc = wp.x + 0.5;
    const tyc = wp.y + 0.5;
    const d = Math.hypot(txc - m.x, tyc - m.y);
    if (d <= remaining) {
      m.x = txc;
      m.y = tyc;
      remaining -= d;
      m.pathIdx++;
    } else {
      m.x += ((txc - m.x) / d) * remaining;
      m.y += ((tyc - m.y) / d) * remaining;
      remaining = 0;
    }
  }
}

export function monsterDirty(m: MonsterRuntime): boolean {
  return (
    Math.abs(m.x - m.lastSentX) > 0.01 ||
    Math.abs(m.y - m.lastSentY) > 0.01 ||
    m.mode !== m.lastSentMode
  );
}

export function markMonsterSent(m: MonsterRuntime) {
  m.lastSentX = m.x;
  m.lastSentY = m.y;
  m.lastSentMode = m.mode;
}
