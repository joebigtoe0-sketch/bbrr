import { chunkKey, tileToChunk } from '@backrooms/shared';
import type { World } from '../sim/world.js';
import type { AgentRuntime } from '../sim/agents.js';
import type { Observation } from './brain.js';

function stressWord(s: number): string {
  if (s > 85) return 'your hands are shaking; it is hard to think in full sentences';
  if (s > 70) return 'your pulse is loud in your ears';
  if (s > 45) return 'you feel watched and uneasy';
  if (s > 25) return 'you are tense but holding together';
  return 'you feel almost calm';
}

function batteryWord(b: number): string {
  if (b <= 0) return 'your flashlight is DEAD. the dark is total';
  if (b < 15) return 'your flashlight is dying - the beam is brown and guttering';
  if (b < 40) return 'your flashlight is weakening';
  return 'your flashlight is steady';
}

function energyWord(e: number): string {
  if (e <= 0) return 'you are utterly spent; walking is like wading';
  if (e < 20) return 'your legs are heavy; you need food and rest';
  if (e < 50) return 'you are getting tired and hungry';
  return 'your body is holding up';
}

function attentionWord(att: number): string {
  if (att > 60) return 'the pressure of outside attention is intense right now';
  if (att > 25) return 'you can feel attention from outside this place, faint but real';
  if (att > 5) return 'once in a while you feel briefly... noticed';
  return 'you feel unnoticed';
}

const DIRS = [
  { name: 'north', dx: 0, dy: -1 },
  { name: 'east', dx: 1, dy: 0 },
  { name: 'south', dx: 0, dy: 1 },
  { name: 'west', dx: -1, dy: 0 },
] as const;

export function buildObservation(world: World, a: AgentRuntime): Observation {
  const ax = Math.floor(a.x);
  const ay = Math.floor(a.y);

  // exits: probe a few tiles out in each cardinal direction (edge-aware)
  const ways: string[] = [];
  for (const d of DIRS) {
    let open = 0;
    for (let i = 1; i <= 4; i++) {
      const px = ax + d.dx * (i - 1);
      const py = ay + d.dy * (i - 1);
      if (world.maze.canStep(px, py, px + d.dx, py + d.dy)) open++;
      else break;
    }
    if (open >= 2) {
      const c = world.maze.getLoaded(
        chunkKey(tileToChunk(ax + d.dx * 6), tileToChunk(ay + d.dy * 6)),
      );
      const light = c ? (c.lightsOn ? 'lit' : 'dark') : 'dark';
      ways.push(`${d.name} (${light})`);
    }
  }
  const here = world.maze.getLoaded(chunkKey(tileToChunk(ax), tileToChunk(ay)));
  const locationLine =
    `yellow rooms, ${here?.lightsOn ? 'humming fluorescent light' : 'the lights here are OFF'}. ` +
    (ways.length > 0 ? `Ways on: ${ways.join(', ')}.` : 'You are boxed in; only tight gaps remain.');

  // visible evidence
  const seen = world.evidence
    .within(a.x, a.y, 8)
    .sort(
      (e1, e2) =>
        Math.hypot(e1.x - a.x, e1.y - a.y) - Math.hypot(e2.x - a.x, e2.y - a.y),
    )
    .slice(0, 6);
  const visibleEvidence: string[] = [];
  let hasTerminalNearby = false;
  let hasPrinterNearby = false;
  let hasCrateNearby = false;
  for (const e of seen) {
    const d = Math.round(Math.hypot(e.x - a.x, e.y - a.y));
    switch (e.kind) {
      case 'crt':
        hasTerminalNearby = true;
        visibleEvidence.push(`a humming terminal ${d} steps away`);
        break;
      case 'printer':
        hasPrinterNearby = true;
        visibleEvidence.push(`an old printer ${d} steps away`);
        break;
      case 'crate':
        hasCrateNearby = true;
        visibleEvidence.push(`a sealed supply crate ${d} steps away`);
        break;
      case 'corpse':
        visibleEvidence.push(`a body on the floor: ${e.text ?? 'unrecognizable'}`);
        break;
      case 'anomaly':
        if (e.text) visibleEvidence.push(`something wrong ${d} steps away: ${e.text}`);
        break;
      case 'graffiti':
      case 'note':
      case 'sign':
      case 'printout':
      case 'poster':
        if (e.text)
          visibleEvidence.push(
            `${e.kind} ${d} steps away: "${e.text}"${e.authorName ? ` — ${e.authorName}` : ''}`,
          );
        break;
    }
  }

  const nearbyAgents = [...world.agents.values()]
    .filter((o) => o.id !== a.id && o.state !== 'dead')
    .map((o) => ({ o, d: Math.hypot(o.x - a.x, o.y - a.y) }))
    .filter(({ d }) => d <= 9)
    .sort((p, q) => p.d - q.d)
    .slice(0, 4)
    .map(({ o, d }) => ({ name: o.name, distance: Math.round(d), lastSaid: o.lastSaid }));

  const md = Math.hypot(world.monster.x - a.x, world.monster.y - a.y);

  return {
    name: a.name,
    objective: a.objective,
    stress: Math.round(a.stress),
    stressWord: stressWord(a.stress),
    attentionWord: attentionWord(a.attention),
    batteryWord: batteryWord(a.battery),
    energyWord: energyWord(a.energy),
    aliveMinutes: Math.floor((Date.now() - a.spawnedAtMs) / 60000),
    locationLine,
    visibleEvidence,
    nearbyAgents,
    monsterNearby: a.monsterVisible || md < 12,
    heard: a.heardSinceLastDecision.slice(-4),
    memorySummary: a.memory.summary,
    memoryNotes: a.memory.notes.slice(-8),
    lastActionResult: a.lastActionResult,
    recentActions: a.recentActions.slice(-3),
    hasTerminalNearby,
    hasPrinterNearby,
    hasCrateNearby,
  };
}
