import { CHUNK_SIZE, EDGE, TILE, WALKABLE_TILES, chunkKey, edgePassable, tileToChunk } from '@backrooms/shared';
import type { MazeChunk } from '@backrooms/shared';
import { chunkRepo } from '../db/repo.js';
import { rngFor, randInt } from './rng.js';

export interface ChunkRuntime {
  cx: number;
  cy: number;
  tiles: Uint8Array; // CHUNK_SIZE^2 row-major (Floor/Rubble)
  wallsH: Uint8Array; // EDGE value on each tile's NORTH edge
  wallsV: Uint8Array; // EDGE value on each tile's WEST edge
  lightsOn: boolean;
  version: number;
  freshlyGenerated: boolean;
}

export interface TileChange {
  cx: number;
  cy: number;
  i: number;
  tile: number;
}

export interface EdgeChange {
  cx: number;
  cy: number;
  i: number;
  dir: 'h' | 'v';
  value: number;
}

/**
 * Infinite chunked maze. Walls live on tile EDGES (backrooms-style thin
 * partitions): each tile owns its north (wallsH) and west (wallsV) edge.
 * Chunks generate lazily and deterministically; the border wall line between
 * two chunks is owned by the south/east chunk and both sides agree on its
 * doorways via hash(seed, edgeId).
 */
export class Maze {
  private chunks = new Map<string, ChunkRuntime>();
  readonly pendingTileChanges: TileChange[] = [];
  readonly pendingEdgeChanges: EdgeChange[] = [];
  readonly pendingLightChanges: { cx: number; cy: number; on: boolean }[] = [];
  readonly newlyGenerated: ChunkRuntime[] = [];

  constructor(private seed: string) {}

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  getLoaded(key: string): ChunkRuntime | undefined {
    return this.chunks.get(key);
  }

  loadedKeys(): string[] {
    return [...this.chunks.keys()];
  }

  ensureChunk(cx: number, cy: number): ChunkRuntime {
    const key = chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (c) return c;

    const row = chunkRepo.get(key);
    if (row) {
      c = {
        cx,
        cy,
        tiles: new Uint8Array(row.tiles),
        wallsH: new Uint8Array(row.walls_h),
        wallsV: new Uint8Array(row.walls_v),
        lightsOn: row.lights_on === 1,
        version: row.version,
        freshlyGenerated: false,
      };
    } else {
      c = this.generateChunk(cx, cy);
      this.persist(c);
      this.newlyGenerated.push(c);
    }
    this.chunks.set(key, c);
    return c;
  }

  private persist(c: ChunkRuntime) {
    chunkRepo.upsert(chunkKey(c.cx, c.cy), c.cx, c.cy, c.tiles, c.wallsH, c.wallsV, c.lightsOn, c.version);
  }

  private local(g: number): number {
    return ((g % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  }

  tileAt(gx: number, gy: number): number {
    const c = this.chunks.get(chunkKey(tileToChunk(gx), tileToChunk(gy)));
    if (!c) return TILE.Void;
    return c.tiles[this.local(gy) * CHUNK_SIZE + this.local(gx)]!;
  }

  /** EDGE value on the north edge of tile (gx,gy). Void chunks read as Wall. */
  edgeH(gx: number, gy: number): number {
    const c = this.chunks.get(chunkKey(tileToChunk(gx), tileToChunk(gy)));
    if (!c) return EDGE.Wall;
    return c.wallsH[this.local(gy) * CHUNK_SIZE + this.local(gx)]!;
  }

  /** EDGE value on the west edge of tile (gx,gy). */
  edgeV(gx: number, gy: number): number {
    const c = this.chunks.get(chunkKey(tileToChunk(gx), tileToChunk(gy)));
    if (!c) return EDGE.Wall;
    return c.wallsV[this.local(gy) * CHUNK_SIZE + this.local(gx)]!;
  }

  isWalkable = (gx: number, gy: number): boolean => WALKABLE_TILES.includes(this.tileAt(gx, gy));

  /** Can you move (or see) between two ORTHOGONALLY adjacent tiles? */
  canStep = (fx: number, fy: number, tx: number, ty: number): boolean => {
    if (!this.isWalkable(tx, ty)) return false;
    const dx = tx - fx;
    const dy = ty - fy;
    if (dx === 1) return edgePassable(this.edgeV(tx, ty));
    if (dx === -1) return edgePassable(this.edgeV(fx, fy));
    if (dy === 1) return edgePassable(this.edgeH(tx, ty));
    if (dy === -1) return edgePassable(this.edgeH(fx, fy));
    return false;
  };

  setTile(gx: number, gy: number, tile: number) {
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    const c = this.ensureChunk(cx, cy);
    const i = this.local(gy) * CHUNK_SIZE + this.local(gx);
    if (c.tiles[i] === tile) return;
    c.tiles[i] = tile;
    c.version++;
    this.persist(c);
    this.pendingTileChanges.push({ cx, cy, i, tile });
  }

  setEdge(gx: number, gy: number, dir: 'h' | 'v', value: number) {
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    const c = this.ensureChunk(cx, cy);
    const i = this.local(gy) * CHUNK_SIZE + this.local(gx);
    const arr = dir === 'h' ? c.wallsH : c.wallsV;
    if (arr[i] === value) return;
    arr[i] = value;
    c.version++;
    this.persist(c);
    this.pendingEdgeChanges.push({ cx, cy, i, dir, value });
  }

  /** Find a nearby edge matching a predicate; returns its tile+direction. */
  findEdge(
    gx: number,
    gy: number,
    radius: number,
    pred: (value: number) => boolean,
  ): { gx: number; gy: number; dir: 'h' | 'v'; value: number } | null {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = gx + dx;
          const y = gy + dy;
          const h = this.edgeH(x, y);
          if (pred(h)) return { gx: x, gy: y, dir: 'h', value: h };
          const v = this.edgeV(x, y);
          if (pred(v)) return { gx: x, gy: y, dir: 'v', value: v };
        }
      }
    }
    return null;
  }

  setLights(cx: number, cy: number, on: boolean) {
    const c = this.ensureChunk(cx, cy);
    if (c.lightsOn === on) return;
    c.lightsOn = on;
    c.version++;
    this.persist(c);
    this.pendingLightChanges.push({ cx, cy, on });
  }

  growAround(gx: number, gy: number, radius = 1) {
    const ccx = tileToChunk(gx);
    const ccy = tileToChunk(gy);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.ensureChunk(ccx + dx, ccy + dy);
      }
    }
  }

  evict(anchors: { cx: number; cy: number }[], keepRadius = 4): string[] {
    const evicted: string[] = [];
    for (const [key, c] of this.chunks) {
      let keep = false;
      for (const a of anchors) {
        if (Math.abs(a.cx - c.cx) <= keepRadius && Math.abs(a.cy - c.cy) <= keepRadius) {
          keep = true;
          break;
        }
      }
      if (!keep) {
        this.chunks.delete(key);
        evicted.push(key);
      }
    }
    return evicted;
  }

  toWire(c: ChunkRuntime): MazeChunk {
    return {
      cx: c.cx,
      cy: c.cy,
      tiles: [...c.tiles],
      wallsH: [...c.wallsH],
      wallsV: [...c.wallsV],
      lightsOn: c.lightsOn,
      version: c.version,
    };
  }

  /**
   * Deterministic generation — Found-Footage backrooms:
   * every tile is floor; walls are edge lines. Chunk borders get partial
   * wall lines with doorways (owned by this chunk's row 0 / col 0, agreed
   * via hash(seed, edgeId)); the interior is BSP-subdivided into small
   * rooms (3–7 tiles) with a doorway per split. Connectivity is guaranteed
   * by construction: every split and every border line carves an opening.
   */
  private generateChunk(cx: number, cy: number): ChunkRuntime {
    const S = CHUNK_SIZE;
    const rng = rngFor(this.seed, 'chunk', cx, cy);
    const tiles = new Uint8Array(S * S).fill(TILE.Floor);
    const wallsH = new Uint8Array(S * S).fill(EDGE.None);
    const wallsV = new Uint8Array(S * S).fill(EDGE.None);
    const at = (x: number, y: number) => y * S + x;

    // ---- border wall lines (deterministic per shared edge id) ----
    const border = (edgeId: string, set: (i: number, v: number) => void) => {
      const erng = rngFor(this.seed, 'edge', edgeId);
      if (erng() > 0.85) return; // occasional fully open border
      for (let i = 0; i < S; i++) set(i, EDGE.Wall);
      const doorways = erng() < 0.5 ? 1 : 2;
      for (let d = 0; d < doorways; d++) {
        const off = randInt(erng, 1, S - 2);
        let v: number = EDGE.None;
        if (d > 0) {
          const roll = erng();
          if (roll < 0.2) v = EDGE.DoorLocked;
          else if (roll < 0.45) v = EDGE.DoorOpen;
        } else if (erng() < 0.2) {
          v = EDGE.DoorOpen;
        }
        set(off, v);
      }
    };
    border(`H:${cx}:${cy}`, (i, v) => (wallsH[at(i, 0)] = v));
    border(`V:${cx}:${cy}`, (i, v) => (wallsV[at(0, i)] = v));

    // ---- BSP subdivision into small rooms ----
    const subdivide = (x0: number, y0: number, w: number, h: number, depth: number) => {
      const canV = w >= 6;
      const canH = h >= 6;
      if ((!canV && !canH) || depth > 6) return;
      if (depth > 0 && rng() < 0.12) return; // occasional larger hall
      const vertical = canV && (!canH || w >= h ? true : rng() < 0.5);
      if (vertical) {
        const sx = x0 + randInt(rng, 3, w - 3);
        for (let y = y0; y < y0 + h; y++) wallsV[at(sx, y)] = EDGE.Wall;
        const dy = randInt(rng, y0, y0 + h - 1);
        wallsV[at(sx, dy)] = rng() < 0.22 ? EDGE.DoorOpen : EDGE.None;
        // rare extra locked door elsewhere on the line
        if (h >= 5 && rng() < 0.15) {
          const ly = randInt(rng, y0, y0 + h - 1);
          if (ly !== dy) wallsV[at(sx, ly)] = EDGE.DoorLocked;
        }
        subdivide(x0, y0, sx - x0, h, depth + 1);
        subdivide(sx, y0, w - (sx - x0), h, depth + 1);
      } else {
        const sy = y0 + randInt(rng, 3, h - 3);
        for (let x = x0; x < x0 + w; x++) wallsH[at(x, sy)] = EDGE.Wall;
        const dx = randInt(rng, x0, x0 + w - 1);
        wallsH[at(dx, sy)] = rng() < 0.22 ? EDGE.DoorOpen : EDGE.None;
        if (w >= 5 && rng() < 0.15) {
          const lx = randInt(rng, x0, x0 + w - 1);
          if (lx !== dx) wallsH[at(lx, sy)] = EDGE.DoorLocked;
        }
        subdivide(x0, y0, w, sy - y0, depth + 1);
        subdivide(x0, sy, w, h - (sy - y0), depth + 1);
      }
    };
    subdivide(0, 0, S, S, 0);

    const distFromOrigin = Math.max(Math.abs(cx), Math.abs(cy));
    const lightsOn = distFromOrigin < 2 ? true : rng() < 0.7;

    return { cx, cy, tiles, wallsH, wallsV, lightsOn, version: 0, freshlyGenerated: true };
  }

  /** Nearest walkable tile (spiral, loaded chunks only). */
  nearestWalkable(gx: number, gy: number, maxR = 12): { x: number; y: number } | null {
    if (this.isWalkable(gx, gy)) return { x: gx, y: gy };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isWalkable(gx + dx, gy + dy)) return { x: gx + dx, y: gy + dy };
        }
      }
    }
    return null;
  }
}
