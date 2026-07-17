import { chunkKey, tileToChunk } from '@backrooms/shared';
import type { EvidenceArtifact, EvidenceKind } from '@backrooms/shared';
import { evidenceRepo } from '../db/repo.js';
import { nanoid } from 'nanoid';

/**
 * In-memory evidence for LOADED chunks (sim queries) with write-through to
 * SQLite (the permanent archaeological record). Chunk subscriptions read the
 * DB directly, which is always current because of write-through.
 */
export class EvidenceStore {
  private byChunk = new Map<string, Map<string, EvidenceArtifact>>();

  // per-tick delta accumulators, drained by the broadcaster
  readonly pendingAdd: EvidenceArtifact[] = [];
  readonly pendingUpdate: EvidenceArtifact[] = [];
  readonly pendingRemove: string[] = [];

  loadChunk(key: string) {
    if (this.byChunk.has(key)) return;
    const m = new Map<string, EvidenceArtifact>();
    for (const e of evidenceRepo.byChunk(key)) m.set(e.id, e);
    this.byChunk.set(key, m);
  }

  unloadChunk(key: string) {
    this.byChunk.delete(key);
  }

  create(
    kind: EvidenceKind,
    x: number,
    y: number,
    tick: number,
    opts: { text?: string; authorAgentId?: string; authorName?: string; meta?: Record<string, unknown> } = {},
  ): EvidenceArtifact {
    const e: EvidenceArtifact = {
      id: nanoid(10),
      kind,
      x,
      y,
      createdTick: tick,
      ...opts,
    };
    const key = chunkKey(tileToChunk(x), tileToChunk(y));
    this.loadChunk(key);
    this.byChunk.get(key)!.set(e.id, e);
    evidenceRepo.upsert(e, key);
    this.pendingAdd.push(e);
    return e;
  }

  update(e: EvidenceArtifact) {
    const key = chunkKey(tileToChunk(e.x), tileToChunk(e.y));
    evidenceRepo.upsert(e, key);
    this.pendingUpdate.push(e);
  }

  remove(id: string, x: number, y: number) {
    const key = chunkKey(tileToChunk(x), tileToChunk(y));
    this.byChunk.get(key)?.delete(id);
    evidenceRepo.remove(id);
    this.pendingRemove.push(id);
  }

  /** Nearest artifact of a kind within maxDist tiles (loaded chunks only). */
  nearest(kind: EvidenceKind, x: number, y: number, maxDist: number): EvidenceArtifact | null {
    let best: EvidenceArtifact | null = null;
    let bestD = maxDist;
    const cr = Math.ceil(maxDist / 16) + 1;
    const ccx = tileToChunk(x);
    const ccy = tileToChunk(y);
    for (let dy = -cr; dy <= cr; dy++) {
      for (let dx = -cr; dx <= cr; dx++) {
        const m = this.byChunk.get(chunkKey(ccx + dx, ccy + dy));
        if (!m) continue;
        for (const e of m.values()) {
          if (e.kind !== kind) continue;
          const d = Math.abs(e.x - x) + Math.abs(e.y - y);
          if (d <= bestD) {
            bestD = d;
            best = e;
          }
        }
      }
    }
    return best;
  }

  /** All artifacts within a Chebyshev tile radius (loaded chunks only). */
  within(x: number, y: number, radius: number): EvidenceArtifact[] {
    const out: EvidenceArtifact[] = [];
    const cr = Math.ceil(radius / 16) + 1;
    const ccx = tileToChunk(x);
    const ccy = tileToChunk(y);
    for (let dy = -cr; dy <= cr; dy++) {
      for (let dx = -cr; dx <= cr; dx++) {
        const m = this.byChunk.get(chunkKey(ccx + dx, ccy + dy));
        if (!m) continue;
        for (const e of m.values()) {
          if (Math.abs(e.x - x) <= radius && Math.abs(e.y - y) <= radius) out.push(e);
        }
      }
    }
    return out;
  }
}
