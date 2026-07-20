export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;
/** wall plane height (walls live on tile edges, like room partitions) */
export const WALL_H = 34;
/** edge-wall texture canvas: 32 wide, 16 (edge drop) + WALL_H + 2 (top lip) */
export const WALL_TEX_W = 32;
export const WALL_TEX_H = 16 + WALL_H + 2;

/** Screen position of a tile's diamond center (grid coords may be floats). */
export function gridToScreen(x: number, y: number): { sx: number; sy: number } {
  return { sx: (x - y) * HALF_W, sy: (x + y) * HALF_H };
}

/**
 * Screen position for a CONTINUOUS world position (entities live at
 * tile+0.5 coords). Tiles draw their diamond center at gridToScreen(gx, gy),
 * so a continuous position must shift up one half-tile to land on the same
 * grid — without this, entities render half a tile down-screen and appear to
 * walk through walls beside doorways.
 */
export function entityToScreen(x: number, y: number): { sx: number; sy: number } {
  return { sx: (x - y) * HALF_W, sy: (x + y) * HALF_H - HALF_H };
}

/** Inverse of gridToScreen. */
export function screenToGrid(sx: number, sy: number): { x: number; y: number } {
  return { x: sy / TILE_H + sx / TILE_W, y: sy / TILE_H - sx / TILE_W };
}

/** Global depth for feet-anchored sprites. bias: objects 0, agents 2, labels 4. */
export function depthOf(x: number, y: number, bias = 0): number {
  return (x + y) * 10 + bias;
}

export const FLOOR_DEPTH = -1_000_000;
