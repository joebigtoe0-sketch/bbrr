export const PROTOCOL_VERSION = 1;

export const CHUNK_SIZE = 16;
export const SIM_TICK_MS = 100;

export const AGENT_SPEED = 1.45; // tiles per second - unhurried, uneasy
export const MONSTER_ROAM_SPEED = 1.2;
export const MONSTER_HUNT_SPEED = 1.9;

export const TILE = {
  Void: 0,
  Floor: 1,
  Rubble: 5,
} as const;
export type TileId = (typeof TILE)[keyof typeof TILE];

export const WALKABLE_TILES: readonly number[] = [TILE.Floor];

/**
 * Walls live on tile EDGES, not tiles. Each tile owns its NORTH edge
 * (between it and the tile above, stored in wallsH) and its WEST edge
 * (between it and the tile left, stored in wallsV).
 */
export const EDGE = {
  None: 0,
  Wall: 1,
  DoorOpen: 2,
  DoorLocked: 3,
} as const;
export type EdgeId = (typeof EDGE)[keyof typeof EDGE];

/** an edge you can walk and see through */
export function edgePassable(e: number): boolean {
  return e === EDGE.None || e === EDGE.DoorOpen;
}

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
