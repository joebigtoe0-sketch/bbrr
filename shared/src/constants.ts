export const PROTOCOL_VERSION = 1;

export const CHUNK_SIZE = 16;
export const SIM_TICK_MS = 100;

export const AGENT_SPEED = 2.0; // tiles per second
export const MONSTER_ROAM_SPEED = 1.5;
export const MONSTER_HUNT_SPEED = 2.3;

export const TILE = {
  Void: 0,
  Floor: 1,
  Wall: 2,
  DoorOpen: 3,
  DoorLocked: 4,
  Rubble: 5,
} as const;
export type TileId = (typeof TILE)[keyof typeof TILE];

export const WALKABLE_TILES: readonly number[] = [TILE.Floor, TILE.DoorOpen];

export const OBJECTIVES = [
  'escape',
  'famous',
  'deepest',
  'richest',
  'cult',
  'find_agent',
  'trust_no_one',
  'help_all',
  'destroy_decoys',
] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const OBJECTIVE_LABELS: Record<Objective, string> = {
  escape: 'Escape',
  famous: 'Become famous',
  deepest: 'Reach the deepest level',
  richest: 'Become the richest treasury',
  cult: 'Build a cult',
  find_agent: 'Find another agent',
  trust_no_one: 'Never trust anyone',
  help_all: 'Help everyone',
  destroy_decoys: 'Destroy every decoy token',
};

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function tileToChunk(t: number): number {
  return Math.floor(t / CHUNK_SIZE);
}
