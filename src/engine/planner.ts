import {
  Action,
  CellType,
  Coord,
  GridMap,
  PlanResult,
  PlanStep,
} from './types';

export function coordKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function isCellTraversable(
  grid: GridMap,
  blockedSet: ReadonlySet<string>,
  x: number,
  y: number
): boolean {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
  if (blockedSet.has(coordKey(x, y))) return false;
  const cell: CellType = grid.cells[y]![x]!;
  return cell !== 'wall' && cell !== 'shelf';
}

/**
 * Spatial hash index for O(1) cell-bucketed robot proximity lookups at scale (100+ robots).
 */
export class SpatialRobotIndex {
  private readonly buckets = new Map<string, string[]>();

  clear(): void {
    this.buckets.clear();
  }

  insert(robotId: string, cell: Coord): void {
    const key = coordKey(cell.x, cell.y);
    let list = this.buckets.get(key);
    if (!list) {
      list = [];
      this.buckets.set(key, list);
    }
    list.push(robotId);
  }

  queryRadius(center: Coord, radius: number): string[] {
    const found: string[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > radius) continue;
        const list = this.buckets.get(coordKey(center.x + dx, center.y + dy));
        if (list) {
          for (const id of list) found.push(id);
        }
      }
    }
    return found;
  }
}

export class ReservationTable {
  private readonly vertices = new Map<string, string>();
  private readonly edges = new Map<string, string>();

  private vKey(x: number, y: number, t: number): string {
    return `${x},${y},${t}`;
  }

  private eKey(x1: number, y1: number, x2: number, y2: number, t: number): string {
    return `${x1},${y1}>${x2},${y2}@${t}`;
  }

  reserveVertex(x: number, y: number, t: number, robotId: string): void {
    if (!this.vertices.has(this.vKey(x, y, t))) {
      this.vertices.set(this.vKey(x, y, t), robotId);
    }
  }

  reserveEdge(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    t: number,
    robotId: string
  ): void {
    this.edges.set(this.eKey(x1, y1, x2, y2, t), robotId);
  }

  getVertexOwner(x: number, y: number, t: number): string | undefined {
    return this.vertices.get(this.vKey(x, y, t));
  }

  isVertexReserved(x: number, y: number, t: number, ignoreRobotId?: string): boolean {
    const owner = this.vertices.get(this.vKey(x, y, t));
    return owner !== undefined && owner !== ignoreRobotId;
  }

  isEdgeSwapReserved(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    t: number,
    ignoreRobotId?: string
  ): boolean {
    if (fromX === toX && fromY === toY) return false;
    const oppositeOwner = this.edges.get(this.eKey(toX, toY, fromX, fromY, t));
    return oppositeOwner !== undefined && oppositeOwner !== ignoreRobotId;
  }

  /**
   * Reserves path steps. When `haloAheadCells === 2` (DEADZONE uncertainty mode),
   * reserves an extra lookahead step along the trajectory for wider safety clearance.
   */
  reservePath(
    robotId: string,
    start: Coord,
    startTick: number,
    steps: readonly PlanStep[],
    horizonEndTick: number,
    haloAheadCells = 1
  ): void {
    let prevX = start.x;
    let prevY = start.y;
    let lastT = startTick;

    this.reserveVertex(prevX, prevY, startTick, robotId);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      this.reserveVertex(step.x, step.y, step.t, robotId);
      if (step.x !== prevX || step.y !== prevY) {
        this.reserveEdge(prevX, prevY, step.x, step.y, step.t, robotId);
      }
      // Wider safety halo in DEADZONE: reserve 2 cells ahead at t+1
      if (haloAheadCells >= 2 && i + 1 < steps.length) {
        const nextStep = steps[i + 1]!;
        this.reserveVertex(nextStep.x, nextStep.y, step.t, robotId);
      }
      prevX = step.x;
      prevY = step.y;
      lastT = step.t;
    }

    for (let t = lastT + 1; t <= horizonEndTick; t++) {
      this.reserveVertex(prevX, prevY, t, robotId);
    }
  }
}

/**
 * Deterministic bounded path cache keyed by gridRevision + endpoints + congestion fingerprint.
 */
export class DeterministicPathCache {
  private readonly cache = new Map<string, Coord[]>();
  private readonly maxEntries: number;

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  clear(): void {
    this.cache.clear();
  }

  get(key: string): Coord[] | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU order deterministically
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  set(key: string, coords: Coord[]): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, coords);
  }
}

interface SearchNode {
  x: number;
  y: number;
  t: number;
  g: number;
  h: number;
  f: number;
  action: Action;
  actionRank: number;
  parent: SearchNode | null;
}

const MOVES: ReadonlyArray<{
  action: Action;
  dx: number;
  dy: number;
  rank: number;
  cost: number;
}> = [
  { action: 'E', dx: 1, dy: 0, rank: 0, cost: 1.0 },
  { action: 'S', dx: 0, dy: 1, rank: 1, cost: 1.0 },
  { action: 'W', dx: -1, dy: 0, rank: 2, cost: 1.0 },
  { action: 'N', dx: 0, dy: -1, rank: 3, cost: 1.0 },
  { action: 'WAIT', dx: 0, dy: 0, rank: 4, cost: 1.001 },
];

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function compareNodes(a: SearchNode, b: SearchNode): number {
  if (a.f !== b.f) return a.f - b.f;
  if (a.h !== b.h) return a.h - b.h;
  if (a.t !== b.t) return a.t - b.t;
  if (a.x !== b.x) return a.x - b.x;
  if (a.y !== b.y) return a.y - b.y;
  return a.actionRank - b.actionRank;
}

export interface PlanRequest {
  robotId: string;
  start: Coord;
  goal: Coord;
  startTick: number;
  horizon: number;
  maxExpansions: number;
  grid: GridMap;
  blockedSet: ReadonlySet<string>;
  reservations: ReservationTable;
  anyFreeCellMode?: boolean;
  /**
   * Optional dynamic edge congestion surcharge map ("x,y" -> added traversal cost).
   */
  dynamicEdgeCosts?: ReadonlyMap<string, number>;
}

export function planSpaceTimePath(req: PlanRequest): PlanResult {
  const {
    robotId,
    start,
    goal,
    startTick,
    horizon,
    maxExpansions,
    grid,
    blockedSet,
    reservations,
    anyFreeCellMode = false,
    dynamicEdgeCosts,
  } = req;

  if (!isCellTraversable(grid, blockedSet, start.x, start.y)) {
    return { status: 'unreachable', expanded: 0, reason: 'Start cell not traversable' };
  }

  if (!anyFreeCellMode && !isCellTraversable(grid, blockedSet, goal.x, goal.y)) {
    return { status: 'unreachable', expanded: 0, reason: 'Goal cell blocked or out of bounds' };
  }

  const maxTick = startTick + Math.max(1, horizon);
  const open: SearchNode[] = [];
  const bestG = new Map<string, number>();

  const initialH = anyFreeCellMode ? 0 : manhattan(start.x, start.y, goal.x, goal.y);
  open.push({
    x: start.x,
    y: start.y,
    t: startTick,
    g: 0,
    h: initialH,
    f: initialH,
    action: 'WAIT',
    actionRank: 4,
    parent: null,
  });
  bestG.set(`${start.x},${start.y},${startTick}`, 0);

  let expanded = 0;
  let bestPartialNode: SearchNode | null = null;

  const isSafeRestThroughHorizon = (x: number, y: number, fromT: number): boolean => {
    for (let t = fromT; t <= maxTick; t++) {
      if (reservations.isVertexReserved(x, y, t, robotId)) return false;
    }
    return true;
  };

  while (open.length > 0) {
    if (expanded >= maxExpansions) {
      if (bestPartialNode && bestPartialNode.t > startTick && !anyFreeCellMode) {
        return {
          status: 'ok',
          path: reconstructPath(bestPartialNode),
          expanded,
        };
      }
      return {
        status: 'unreachable',
        expanded,
        reason: `Exceeded maxExpansions (${maxExpansions})`,
      };
    }

    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (compareNodes(open[i]!, open[bestIdx]!) < 0) {
        bestIdx = i;
      }
    }
    const current = open[bestIdx]!;
    open.splice(bestIdx, 1);

    const stateKey = `${current.x},${current.y},${current.t}`;
    const recordedG = bestG.get(stateKey);
    if (recordedG !== undefined && current.g > recordedG + 1e-9) {
      continue;
    }

    expanded++;

    if (
      !anyFreeCellMode &&
      current.t > startTick &&
      (!bestPartialNode ||
        current.h < bestPartialNode.h ||
        (current.h === bestPartialNode.h && current.t > bestPartialNode.t))
    ) {
      bestPartialNode = current;
    }

    if (anyFreeCellMode) {
      if (current.t > startTick && isSafeRestThroughHorizon(current.x, current.y, current.t)) {
        return {
          status: 'ok',
          path: reconstructPath(current),
          expanded,
        };
      }
    } else if (
      current.x === goal.x &&
      current.y === goal.y &&
      isSafeRestThroughHorizon(current.x, current.y, current.t)
    ) {
      return {
        status: 'ok',
        path: reconstructPath(current),
        expanded,
      };
    }

    if (current.t >= maxTick) {
      if (!anyFreeCellMode && bestPartialNode && bestPartialNode.t > startTick) {
        return {
          status: 'ok',
          path: reconstructPath(bestPartialNode),
          expanded,
        };
      }
      continue;
    }

    const nextT = current.t + 1;

    for (const move of MOVES) {
      const nx = current.x + move.dx;
      const ny = current.y + move.dy;

      if (!isCellTraversable(grid, blockedSet, nx, ny)) continue;
      if (reservations.isVertexReserved(nx, ny, nextT, robotId)) continue;
      if (reservations.isEdgeSwapReserved(current.x, current.y, nx, ny, nextT, robotId)) {
        continue;
      }

      const targetCellType = grid.cells[ny]![nx]!;
      // SLOW cells halve speed (~2x traversal time), so planner weighs crawling vs detouring
      const slowCost =
        move.action !== 'WAIT' && targetCellType === 'slow' ? 1.2 : 0;
      const congestionCost =
        move.action !== 'WAIT' && dynamicEdgeCosts
          ? dynamicEdgeCosts.get(coordKey(nx, ny)) ?? 0
          : 0;
      const bayBonus =
        anyFreeCellMode && targetCellType === 'bay' ? -0.35 : 0;

      const nextG = current.g + move.cost + slowCost + congestionCost + bayBonus;
      const nextKey = `${nx},${ny},${nextT}`;
      const prevBest = bestG.get(nextKey);

      if (prevBest === undefined || nextG < prevBest - 1e-9) {
        bestG.set(nextKey, nextG);
        const h = anyFreeCellMode ? 0 : manhattan(nx, ny, goal.x, goal.y);
        open.push({
          x: nx,
          y: ny,
          t: nextT,
          g: nextG,
          h,
          f: nextG + h,
          action: move.action,
          actionRank: move.rank,
          parent: current,
        });
      }
    }
  }

  if (
    bestPartialNode &&
    bestPartialNode.t > startTick &&
    !anyFreeCellMode &&
    shortestPathDistance(grid, blockedSet, start, goal) !== null
  ) {
    return {
      status: 'ok',
      path: reconstructPath(bestPartialNode),
      expanded,
    };
  }

  return {
    status: 'unreachable',
    expanded,
    reason: 'No conflict-free path to goal',
  };
}

function reconstructPath(node: SearchNode): PlanStep[] {
  const steps: PlanStep[] = [];
  let curr: SearchNode | null = node;
  while (curr && curr.parent !== null) {
    steps.push({
      x: curr.x,
      y: curr.y,
      t: curr.t,
      action: curr.action,
    });
    curr = curr.parent;
  }
  steps.reverse();
  return steps;
}

export function shortestPathDistance(
  grid: GridMap,
  blockedSet: ReadonlySet<string>,
  start: Coord,
  goal: Coord
): number | null {
  if (!isCellTraversable(grid, blockedSet, start.x, start.y)) return null;
  if (!isCellTraversable(grid, blockedSet, goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return 0;

  const visited = new Set<string>([coordKey(start.x, start.y)]);
  const queue: Array<{ x: number; y: number; dist: number }> = [
    { x: start.x, y: start.y, dist: 0 },
  ];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++]!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx === goal.x && ny === goal.y) return cur.dist + 1;
      const key = coordKey(nx, ny);
      if (!visited.has(key) && isCellTraversable(grid, blockedSet, nx, ny)) {
        visited.add(key);
        queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
      }
    }
  }
  return null;
}

export function isStaticallyReachable(
  grid: GridMap,
  blockedSet: ReadonlySet<string>,
  start: Coord,
  goal: Coord
): boolean {
  return shortestPathDistance(grid, blockedSet, start, goal) !== null;
}
