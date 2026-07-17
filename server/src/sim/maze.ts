import { CHUNK_SIZE, TILE, WALKABLE_TILES, chunkKey, tileToChunk } from '@backrooms/shared';
import type { MazeChunk } from '@backrooms/shared';
import { chunkRepo } from '../db/repo.js';
import { rngFor, randInt } from './rng.js';

export interface ChunkRuntime {
  cx: number;
  cy: number;
  tiles: Uint8Array; // CHUNK_SIZE^2 row-major
  lightsOn: boolean;
  version: number;
  /** set true when freshly generated this session (evidence decoration pending) */
  freshlyGenerated: boolean;
}

export interface TileChange {
  cx: number;
  cy: number;
  i: number;
  tile: number;
}

/**
 * Infinite chunked maze. Chunks generate lazily and deterministically from the
 * world seed; adjacent chunks agree on edge openings without coordination.
 */
export class Maze {
  private chunks = new Map<string, ChunkRuntime>();
  readonly pendingTileChanges: TileChange[] = [];
  readonly pendingLightChanges: { cx: number; cy: number; on: boolean }[] = [];
  /** chunks generated for the very first time this tick (for decoration) */
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

  /** Get a chunk, loading from DB or generating as needed. */
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
        lightsOn: row.lights_on === 1,
        version: row.version,
        freshlyGenerated: false,
      };
    } else {
      c = this.generateChunk(cx, cy);
      chunkRepo.upsert(key, cx, cy, c.tiles, c.lightsOn, c.version);
      this.newlyGenerated.push(c);
    }
    this.chunks.set(key, c);
    return c;
  }

  /** Tile at global coords; Void if the chunk isn't loaded (never generates). */
  tileAt(gx: number, gy: number): number {
    const c = this.chunks.get(chunkKey(tileToChunk(gx), tileToChunk(gy)));
    if (!c) return TILE.Void;
    const lx = ((gx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((gy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return c.tiles[ly * CHUNK_SIZE + lx]!;
  }

  isWalkable = (gx: number, gy: number): boolean => WALKABLE_TILES.includes(this.tileAt(gx, gy));

  isTransparent = (gx: number, gy: number): boolean => {
    const t = this.tileAt(gx, gy);
    return t !== TILE.Wall && t !== TILE.Void;
  };

  setTile(gx: number, gy: number, tile: number) {
    const cx = tileToChunk(gx);
    const cy = tileToChunk(gy);
    const c = this.ensureChunk(cx, cy);
    const lx = ((gx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((gy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const i = ly * CHUNK_SIZE + lx;
    if (c.tiles[i] === tile) return;
    c.tiles[i] = tile;
    c.version++;
    chunkRepo.upsert(chunkKey(cx, cy), cx, cy, c.tiles, c.lightsOn, c.version);
    this.pendingTileChanges.push({ cx, cy, i, tile });
  }

  setLights(cx: number, cy: number, on: boolean) {
    const c = this.ensureChunk(cx, cy);
    if (c.lightsOn === on) return;
    c.lightsOn = on;
    c.version++;
    chunkRepo.upsert(chunkKey(cx, cy), cx, cy, c.tiles, c.lightsOn, c.version);
    this.pendingLightChanges.push({ cx, cy, on });
  }

  /** Ensure all chunks within `radius` chunks of a tile position exist. */
  growAround(gx: number, gy: number, radius = 1) {
    const ccx = tileToChunk(gx);
    const ccy = tileToChunk(gy);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.ensureChunk(ccx + dx, ccy + dy);
      }
    }
  }

  /** Unload chunks with no anchor (agent/monster/subscription) within `keepRadius` chunks. */
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
    return { cx: c.cx, cy: c.cy, tiles: [...c.tiles], lightsOn: c.lightsOn, version: c.version };
  }

  /**
   * Deterministic chunk generation — backrooms style: open damp floor
   * partitioned by THIN (1-tile) wall lines with doorways, plus pillars.
   *
   * Border walls live on each chunk's TOP row and LEFT column only, so
   * neighbors never double them. Whether a border wall exists and where its
   * openings are comes from hash(seed, edgeId), which both neighbors compute
   * identically.
   */
  private generateChunk(cx: number, cy: number): ChunkRuntime {
    const S = CHUNK_SIZE;
    const rng = rngFor(this.seed, 'chunk', cx, cy);
    const tiles = new Uint8Array(S * S).fill(TILE.Floor);
    const at = (x: number, y: number) => y * S + x;

    // border walls (top edge H:cx:cy owned by this chunk; left edge V:cx:cy)
    const applyEdge = (edgeId: string, place: (offset: number, tile: number) => void) => {
      const erng = rngFor(this.seed, 'edge', edgeId);
      if (erng() > 0.8) return; // some borders are fully open expanses
      for (let i = 0; i < S; i++) place(i, TILE.Wall);
      const count = erng() < 0.4 ? 1 : 2;
      for (let i = 0; i < count; i++) {
        const offset = randInt(erng, 2, S - 3);
        let tile: number = TILE.Floor;
        if (i > 0) {
          const roll = erng();
          if (roll < 0.15) tile = TILE.DoorLocked;
          else if (roll < 0.35) tile = TILE.DoorOpen;
        }
        // doorways are two tiles wide so they read clearly
        place(offset, tile);
        place(Math.min(S - 1, offset + 1), tile === TILE.DoorLocked ? TILE.DoorLocked : TILE.Floor);
      }
    };
    applyEdge(`H:${cx}:${cy}`, (o, t) => (tiles[at(o, 0)] = t));
    applyEdge(`V:${cx}:${cy}`, (o, t) => (tiles[at(0, o)] = t));

    // interior partitions: straight thin wall segments with a gap or doorway
    const partitions = randInt(rng, 2, 4);
    for (let s = 0; s < partitions; s++) {
      const horizontal = rng() < 0.5;
      const len = randInt(rng, 5, 12);
      const x0 = randInt(rng, 2, S - 3);
      const y0 = randInt(rng, 2, S - 3);
      const gapAt = randInt(rng, 1, len - 2);
      const gapTile = rng() < 0.25 ? TILE.DoorOpen : TILE.Floor;
      for (let i = 0; i < len; i++) {
        const x = horizontal ? x0 + i : x0;
        const y = horizontal ? y0 : y0 + i;
        if (x < 1 || y < 1 || x >= S || y >= S) break;
        const isGap = i === gapAt || i === gapAt + 1;
        tiles[at(x, y)] = isGap ? gapTile : TILE.Wall;
      }
    }

    // pillars: lone supports scattered through the open floor
    for (let y = 2; y < S - 2; y++) {
      for (let x = 2; x < S - 2; x++) {
        if (tiles[at(x, y)] === TILE.Floor && rng() < 0.02) tiles[at(x, y)] = TILE.Wall;
      }
    }

    // connectivity: every walkable cell reachable (carves through partitions)
    this.connect(tiles, rng);

    const distFromOrigin = Math.max(Math.abs(cx), Math.abs(cy));
    const lightsOn = distFromOrigin < 2 ? true : rng() < 0.7;

    return { cx, cy, tiles, lightsOn, version: 0, freshlyGenerated: true };
  }

  private connect(tiles: Uint8Array, rng: () => number) {
    const S = CHUNK_SIZE;
    const at = (x: number, y: number) => y * S + x;
    const walkable = (i: number) => WALKABLE_TILES.includes(tiles[i]!);

    for (let guard = 0; guard < 20; guard++) {
      // label components via flood fill
      const label = new Int16Array(S * S).fill(-1);
      let nLabels = 0;
      for (let i = 0; i < S * S; i++) {
        if (!walkable(i) || label[i] !== -1) continue;
        const stack = [i];
        label[i] = nLabels;
        while (stack.length) {
          const cur = stack.pop()!;
          const x = cur % S;
          const y = Math.floor(cur / S);
          for (const [nx, ny] of [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ] as const) {
            if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
            const ni = at(nx, ny);
            if (walkable(ni) && label[ni] === -1) {
              label[ni] = nLabels;
              stack.push(ni);
            }
          }
        }
        nLabels++;
      }
      if (nLabels <= 1) return;

      // carve an L corridor between a cell of component 0 and a cell of component 1
      const cellOf = (l: number): { x: number; y: number } => {
        const candidates: number[] = [];
        for (let i = 0; i < S * S; i++) if (label[i] === l) candidates.push(i);
        const i = candidates[Math.floor(rng() * candidates.length)]!;
        return { x: i % S, y: Math.floor(i / S) };
      };
      const a = cellOf(0);
      const b = cellOf(1);
      const carve = (x: number, y: number) => {
        const i = at(x, y);
        if (tiles[i] === TILE.Wall) tiles[i] = TILE.Floor;
      };
      if (rng() < 0.5) {
        for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, a.y);
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(b.x, y);
      } else {
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(a.x, y);
        for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, b.y);
      }
    }
  }

  /** Find nearest walkable tile to a point, spiraling outward (loaded chunks only). */
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
