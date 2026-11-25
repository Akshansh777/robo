import { SimulationEngine } from './engine';
import {
  Coord,
  GridMap,
  ReplayBundle,
  SimCommand,
} from './types';

export interface LayoutEditProposal {
  id: string;
  kind: 'ADD_PASSING_BAY' | 'CARVE_CROSS_AISLE' | 'RELOCATE_PICKUP';
  cell: Coord;
  targetCell?: Coord;
  reason: string;
  congestionScore: number;
}

export interface LayoutOptimizationComparison {
  proposals: LayoutEditProposal[];
  ticksSimulated: number;
  baseline: {
    jobsCompleted: number;
    throughputPer100Ticks: number;
    avgWaitTime: number;
    p95WaitTime: number;
    congestionIndex: number;
    deadlocksResolved: number;
    invariantOk: boolean;
  };
  optimized: {
    jobsCompleted: number;
    throughputPer100Ticks: number;
    avgWaitTime: number;
    p95WaitTime: number;
    congestionIndex: number;
    deadlocksResolved: number;
    invariantOk: boolean;
  };
  deltas: {
    throughputDelta: number;
    avgWaitDelta: number;
    congestionDelta: number;
  };
}

function cloneGrid(grid: GridMap): GridMap {
  return {
    width: grid.width,
    height: grid.height,
    cells: grid.cells.map((row) => [...row]),
  };
}

/**
 * Analyzes congestion heatmap and proposes up to 3 structural warehouse layout improvements.
 */
export function proposeLayoutEdits(engine: SimulationEngine): LayoutEditProposal[] {
  const state = engine.getState();
  const metrics = engine.getMetrics();
  const grid = state.grid;
  const proposals: LayoutEditProposal[] = [];
  const usedKeys = new Set<string>();

  const scoredCells: Array<{ x: number; y: number; score: number }> = [];
  for (let y = 1; y < grid.height - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      const key = `${x},${y}`;
      const waits = metrics.cellWaitCounts[key] ?? 0;
      const occ = metrics.cellOccupancy[key] ?? 0;
      const score = waits * 3 + occ;
      if (score > 0) {
        scoredCells.push({ x, y, score });
      }
    }
  }
  scoredCells.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  for (const hot of scoredCells) {
    if (proposals.length >= 2) break;
    if (grid.cells[hot.y]![hot.x] !== 'floor') continue;

    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      const nx = hot.x + dx;
      const ny = hot.y + dy;
      if (nx <= 0 || ny <= 0 || nx >= grid.width - 1 || ny >= grid.height - 1) continue;
      const key = `${nx},${ny}`;
      if (usedKeys.has(key)) continue;
      const neighborType = grid.cells[ny]![nx]!;
      if (neighborType === 'shelf' || neighborType === 'wall') {
        const isCarve =
          neighborType === 'shelf' &&
          ny > 1 &&
          ny < grid.height - 2 &&
          grid.cells[ny + dy]?.[nx + dx] === 'floor';

        usedKeys.add(key);
        proposals.push({
          id: `OPT-${proposals.length + 1}`,
          kind: isCarve ? 'CARVE_CROSS_AISLE' : 'ADD_PASSING_BAY',
          cell: { x: nx, y: ny },
          reason: isCarve
            ? `Carve cross-aisle at (${nx},${ny}) to relieve congested corridor (${hot.x},${hot.y}) [score=${hot.score}]`
            : `Add passing bay pocket at (${nx},${ny}) beside hot aisle (${hot.x},${hot.y}) [score=${hot.score}]`,
          congestionScore: hot.score,
        });
        break;
      }
    }
  }

  const dropCells: Coord[] = [];
  const pickupUsage = new Map<string, { cell: Coord; count: number }>();

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.cells[y]![x] === 'drop') dropCells.push({ x, y });
    }
  }

  for (const job of Object.values(state.jobs)) {
    const k = `${job.pickupCell.x},${job.pickupCell.y}`;
    const cur = pickupUsage.get(k) ?? { cell: job.pickupCell, count: 0 };
    cur.count++;
    pickupUsage.set(k, cur);
  }

  const topPickup = Array.from(pickupUsage.values()).sort((a, b) => b.count - a.count)[0];
  if (topPickup && dropCells.length > 0 && proposals.length < 3) {
    const avgDropX = Math.round(
      dropCells.reduce((acc, c) => acc + c.x, 0) / dropCells.length
    );
    const avgDropY = Math.round(
      dropCells.reduce((acc, c) => acc + c.y, 0) / dropCells.length
    );

    const midX = Math.round((topPickup.cell.x + avgDropX) / 2);
    const midY = Math.round((topPickup.cell.y + avgDropY) / 2);

    let candidate: Coord | null = null;
    let bestDist = Infinity;
    for (let y = 1; y < grid.height - 1; y++) {
      for (let x = 1; x < grid.width - 1; x++) {
        if (grid.cells[y]![x] !== 'floor') continue;
        const d = Math.abs(x - midX) + Math.abs(y - midY);
        const origDist =
          Math.abs(topPickup.cell.x - avgDropX) + Math.abs(topPickup.cell.y - avgDropY);
        const newDist = Math.abs(x - avgDropX) + Math.abs(y - avgDropY);
        if (newDist + 2 < origDist && d < bestDist) {
          bestDist = d;
          candidate = { x, y };
        }
      }
    }

    if (candidate && !usedKeys.has(`${candidate.x},${candidate.y}`)) {
      proposals.push({
        id: `OPT-${proposals.length + 1}`,
        kind: 'RELOCATE_PICKUP',
        cell: { ...topPickup.cell },
        targetCell: candidate,
        reason: `Move high-frequency pickup (${topPickup.cell.x},${topPickup.cell.y}) to (${candidate.x},${candidate.y}) closer to drop stations`,
        congestionScore: topPickup.count * 10,
      });
    }
  }

  return proposals;
}

/**
 * Applies layout proposals to a replay bundle and runs both baseline and optimized engines
 * over the exact same seed, job stream, and chaos commands to measure real KPI changes.
 */
export function evaluateLayoutOptimization(
  sourceEngine: SimulationEngine,
  proposals: readonly LayoutEditProposal[],
  ticksToRun?: number
): LayoutOptimizationComparison {
  const replay: ReplayBundle = sourceEngine.exportReplay();
  const ticks = Math.max(10, ticksToRun ?? sourceEngine.getState().tick);

  const baselineSim = SimulationEngine.fromReplay(replay);
  baselineSim.stepMany(ticks);

  const optGrid = cloneGrid(replay.initialGrid);
  const pickupRemap = new Map<string, Coord>();

  for (const prop of proposals) {
    if (prop.kind === 'ADD_PASSING_BAY' || prop.kind === 'CARVE_CROSS_AISLE') {
      optGrid.cells[prop.cell.y]![prop.cell.x] =
        prop.kind === 'ADD_PASSING_BAY' ? 'bay' : 'floor';
    } else if (prop.kind === 'RELOCATE_PICKUP' && prop.targetCell) {
      optGrid.cells[prop.cell.y]![prop.cell.x] = 'floor';
      optGrid.cells[prop.targetCell.y]![prop.targetCell.x] = 'pickup';
      pickupRemap.set(`${prop.cell.x},${prop.cell.y}`, prop.targetCell);
    }
  }

  const remappedCommands: SimCommand[] = replay.commands.map((cmd) => {
    const cloned = structuredClone(cmd);
    if (cloned.type === 'REGISTER_POD') {
      const mapped = pickupRemap.get(`${cloned.pod.cell.x},${cloned.pod.cell.y}`);
      if (mapped) cloned.pod.cell = { ...mapped };
    } else if (cloned.type === 'ADD_JOB') {
      const mapped = pickupRemap.get(
        `${cloned.job.pickupCell.x},${cloned.job.pickupCell.y}`
      );
      if (mapped) cloned.job.pickupCell = { ...mapped };
    }
    return cloned;
  });

  const optimizedSim = SimulationEngine.fromReplay({
    ...replay,
    initialGrid: optGrid,
    commands: remappedCommands,
  });
  optimizedSim.stepMany(ticks);

  const bm = baselineSim.getMetrics();
  const om = optimizedSim.getMetrics();

  return {
    proposals: [...proposals],
    ticksSimulated: ticks,
    baseline: {
      jobsCompleted: bm.jobsCompleted,
      throughputPer100Ticks: Number(bm.throughputPer100Ticks.toFixed(2)),
      avgWaitTime: Number(bm.avgWaitTime.toFixed(2)),
      p95WaitTime: Number(bm.p95WaitTime.toFixed(2)),
      congestionIndex: Number(bm.congestionIndex.toFixed(4)),
      deadlocksResolved:
        bm.predictedDeadlocksResolved + bm.reactiveDeadlocksResolved,
      invariantOk: baselineSim.checkInvariants().ok,
    },
    optimized: {
      jobsCompleted: om.jobsCompleted,
      throughputPer100Ticks: Number(om.throughputPer100Ticks.toFixed(2)),
      avgWaitTime: Number(om.avgWaitTime.toFixed(2)),
      p95WaitTime: Number(om.p95WaitTime.toFixed(2)),
      congestionIndex: Number(om.congestionIndex.toFixed(4)),
      deadlocksResolved:
        om.predictedDeadlocksResolved + om.reactiveDeadlocksResolved,
      invariantOk: optimizedSim.checkInvariants().ok,
    },
    deltas: {
      throughputDelta: Number(
        (om.throughputPer100Ticks - bm.throughputPer100Ticks).toFixed(2)
      ),
      avgWaitDelta: Number((om.avgWaitTime - bm.avgWaitTime).toFixed(2)),
      congestionDelta: Number((om.congestionIndex - bm.congestionIndex).toFixed(4)),
    },
  };
}
