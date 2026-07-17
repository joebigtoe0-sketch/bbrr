/**
 * Bounded 4-directional A* over the maze grid.
 * The search window is WINDOW x WINDOW tiles centered on the start,
 * capping worst-case cost regardless of world size.
 */
export const PATH_WINDOW = 48;

export interface PathQuery {
  startX: number;
  startY: number;
  goalX: number;
  goalY: number;
  isWalkable: (x: number, y: number) => boolean;
}

/** Returns a list of tile coords (excluding start), or null if unreachable in-window. */
export function findPath(q: PathQuery): { x: number; y: number }[] | null {
  const half = PATH_WINDOW / 2;
  const minX = q.startX - half;
  const minY = q.startY - half;
  const w = PATH_WINDOW;

  // Clamp goal into the window; caller re-plans when the edge is reached.
  const gx = Math.max(minX, Math.min(minX + w - 1, q.goalX));
  const gy = Math.max(minY, Math.min(minY + w - 1, q.goalY));

  const idx = (x: number, y: number) => (y - minY) * w + (x - minX);
  const inWindow = (x: number, y: number) =>
    x >= minX && x < minX + w && y >= minY && y < minY + w;

  const size = w * w;
  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const startI = idx(q.startX, q.startY);
  gScore[startI] = 0;

  // Simple binary heap keyed by f-score.
  const heap: number[] = [startI];
  const fScore = new Float64Array(size).fill(Infinity);
  fScore[startI] = Math.abs(gx - q.startX) + Math.abs(gy - q.startY);

  const heapPush = (i: number) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (fScore[heap[p]!]! <= fScore[heap[c]!]!) break;
      [heap[p], heap[c]] = [heap[c]!, heap[p]!];
      c = p;
    }
  };
  const heapPop = (): number | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && fScore[heap[l]!]! < fScore[heap[m]!]!) m = l;
        if (r < heap.length && fScore[heap[r]!]! < fScore[heap[m]!]!) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m]!, heap[p]!];
        p = m;
      }
    }
    return top;
  };

  let bestI = startI;
  let bestH = Math.abs(gx - q.startX) + Math.abs(gy - q.startY);
  const goalI = inWindow(gx, gy) ? idx(gx, gy) : -1;

  while (heap.length > 0) {
    const cur = heapPop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalI) {
      bestI = cur;
      break;
    }
    const cy = Math.floor(cur / w) + minY;
    const cx = (cur % w) + minX;
    const h = Math.abs(gx - cx) + Math.abs(gy - cy);
    if (h < bestH) {
      bestH = h;
      bestI = cur;
    }
    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      if (!inWindow(nx, ny) || !q.isWalkable(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const tentative = gScore[cur]! + 1;
      if (tentative < gScore[ni]!) {
        gScore[ni] = tentative;
        fScore[ni] = tentative + Math.abs(gx - nx) + Math.abs(gy - ny);
        cameFrom[ni] = cur;
        heapPush(ni);
      }
    }
  }

  // Reconstruct to the goal if reached, else to the closest-approach cell.
  const endI = closed[goalI === -1 ? bestI : goalI] ? (goalI === -1 ? bestI : goalI) : bestI;
  if (endI === startI) return null;
  const path: { x: number; y: number }[] = [];
  let cur = endI;
  while (cur !== startI && cur !== -1) {
    path.push({ x: (cur % w) + minX, y: Math.floor(cur / w) + minY });
    cur = cameFrom[cur]!;
  }
  path.reverse();
  return path.length > 0 ? path : null;
}

/** Bresenham line-of-sight between tile centers. */
export function hasLineOfSight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  isTransparent: (x: number, y: number) => boolean,
): boolean {
  let ax = Math.floor(x0);
  let ay = Math.floor(y0);
  const bx = Math.floor(x1);
  const by = Math.floor(y1);
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (ax === bx && ay === by) return true;
    if (!(ax === Math.floor(x0) && ay === Math.floor(y0)) && !isTransparent(ax, ay)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      ax += sx;
    }
    if (e2 < dx) {
      err += dx;
      ay += sy;
    }
  }
}
