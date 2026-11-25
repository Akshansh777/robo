import {
  coordKey,
  isCellTraversable,
  planSpaceTimePath,
  ReservationTable,
} from './planner';
import {
  Coord,
  GridMap,
  PlanStep,
  Robot,
  SimState,
} from './types';

export interface WaitForEdge {
  fromRobotId: string;
  toRobotId: string;
  cell: Coord;
  atTick: number;
}

/**
 * Builds a directed wait-for graph projected `lookaheadTicks` ahead from current plans & reservations.
 * Edge Ri -> Rj means Ri wants to enter a cell currently occupied or reserved by Rj.
 */
export function buildProjectedWaitForGraph(
  robots: readonly Robot[],
  reservations: ReservationTable,
  currentTick: number,
  lookaheadTicks: number
): WaitForEdge[] {
  const edges: WaitForEdge[] = [];
  const edgeKeys = new Set<string>();
  const currentOccupancy = new Map<string, string>();

  for (const r of robots) {
    currentOccupancy.set(coordKey(r.cell.x, r.cell.y), r.id);
  }

  for (const r of robots) {
    if (r.status === 'FAILED') continue;

    // 1. Check projected trajectory steps up to lookaheadTicks ahead
    const stepsToCheck = r.plan.slice(0, lookaheadTicks);
    for (const step of stepsToCheck) {
      if (step.t > currentTick + lookaheadTicks) break;
      if (step.x === r.cell.x && step.y === r.cell.y) continue;

      const owner =
        reservations.getVertexOwner(step.x, step.y, step.t) ??
        currentOccupancy.get(coordKey(step.x, step.y));

      if (owner && owner !== r.id) {
        const key = `${r.id}->${owner}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({
            fromRobotId: r.id,
            toRobotId: owner,
            cell: { x: step.x, y: step.y },
            atTick: step.t,
          });
        }
      }
    }

    // 2. If robot has a goal/plan but is currently stalled/waiting, check adjacent desired direction
    if (stepsToCheck.length === 0 && r.assignedJobId && r.stallTicks > 0) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const adjOwner = currentOccupancy.get(coordKey(r.cell.x + dx, r.cell.y + dy));
        if (adjOwner && adjOwner !== r.id) {
          const key = `${r.id}->${adjOwner}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({
              fromRobotId: r.id,
              toRobotId: adjOwner,
              cell: { x: r.cell.x + dx, y: r.cell.y + dy },
              atTick: currentTick + 1,
            });
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Deterministic DFS cycle detector over the wait-for graph.
 * Returns arrays of robot IDs forming directed cycles.
 */
export function detectWaitForCycles(edges: readonly WaitForEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();

  for (const e of edges) {
    nodes.add(e.fromRobotId);
    nodes.add(e.toRobotId);
    let list = adj.get(e.fromRobotId);
    if (!list) {
      list = [];
      adj.set(e.fromRobotId, list);
    }
    if (!list.includes(e.toRobotId)) {
      list.push(e.toRobotId);
    }
  }

  for (const list of adj.values()) {
    list.sort();
  }

  const sortedNodes = Array.from(nodes).sort();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const dfs = (u: string): void => {
    visited.add(u);
    onStack.add(u);
    stack.push(u);

    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        dfs(v);
      } else if (onStack.has(v)) {
        const idx = stack.indexOf(v);
        if (idx >= 0) {
          cycles.push(stack.slice(idx));
        }
      }
    }

    stack.pop();
    onStack.delete(u);
  };

  for (const node of sortedNodes) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Finds the nearest reachable passing bay (or open off-corridor cell) for preemptive backtrack or yield.
 */
export function findNearestYieldPocket(
  grid: GridMap,
  blockedSet: ReadonlySet<string>,
  reservations: ReservationTable,
  robotId: string,
  start: Coord,
  startTick: number,
  horizon: number,
  maxExpansions: number
): PlanStep[] | null {
  // First search for a free 'bay' cell within horizon
  let bestBay: Coord | null = null;
  let bestDist = Infinity;

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (x === start.x && y === start.y) continue;
      if (!isCellTraversable(grid, blockedSet, x, y)) continue;
      if (grid.cells[y]![x] === 'bay') {
        const d = Math.abs(x - start.x) + Math.abs(y - start.y);
        if (d < bestDist) {
          bestDist = d;
          bestBay = { x, y };
        }
      }
    }
  }

  if (bestBay) {
    const bayPlan = planSpaceTimePath({
      robotId,
      start,
      goal: bestBay,
      startTick,
      horizon,
      maxExpansions,
      grid,
      blockedSet,
      reservations,
    });
    if (bayPlan.status === 'ok' && bayPlan.path.length > 0) {
      return bayPlan.path;
    }
  }

  // Fallback: any free unreserved cell away from start
  const anyPlan = planSpaceTimePath({
    robotId,
    start,
    goal: start,
    startTick,
    horizon,
    maxExpansions,
    grid,
    blockedSet,
    reservations,
    anyFreeCellMode: true,
  });
  return anyPlan.status === 'ok' && anyPlan.path.length > 0 ? anyPlan.path : null;
}

/**
 * Selects the single robot in a cycle with the lowest (reroute + reverse) cost.
 */
export function choosePreemptiveBacktrackRobot(
  state: SimState,
  cycleRobotIds: readonly string[]
): Robot | null {
  let bestRobot: Robot | null = null;
  let bestCost = Infinity;

  for (const id of [...cycleRobotIds].sort()) {
    const r = state.robots[id];
    if (!r || r.status === 'FAILED') continue;

    const payloadPenalty = r.carryingPodId ? 15 : 0;
    const stallDiscount = Math.min(10, r.stallTicks);
    const reverseCost = r.plan.length * 0.5;
    const totalCost = payloadPenalty + reverseCost - stallDiscount;

    if (
      totalCost < bestCost - 1e-9 ||
      (Math.abs(totalCost - bestCost) <= 1e-9 && bestRobot && r.id < bestRobot.id)
    ) {
      bestCost = totalCost;
      bestRobot = r;
    }
  }

  return bestRobot;
}
