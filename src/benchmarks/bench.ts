import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CellType, createPRNG, GridMap, SimulationEngine } from '../engine';

interface BenchRow {
  robotCount: number;
  ticks: number;
  avgPlannerMsPerTick: number;
  maxPlannerMsPerTick: number;
  avgExpansionsPerTick: number;
  deferredRequestsTotal: number;
  jobsCompleted: number;
  throughputPer100Ticks: number;
  predictedDeadlocksResolved: number;
  reactiveDeadlocksResolved: number;
  invariantOk: boolean;
  ledgerChainValid: boolean;
}

function buildScalableWarehouse(width: number, height: number): GridMap {
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'floor')
  );
  // Shelf columns every 3 columns with frequent cross-aisles and bays
  for (let x = 3; x < width - 3; x += 3) {
    for (let y = 2; y < height - 2; y++) {
      if (y % 5 === 0) continue; // cross-aisle
      cells[y]![x] = y % 5 === 2 ? 'bay' : 'shelf';
    }
  }
  for (let x = 1; x < width - 1; x += 4) {
    cells[0]![x] = 'charger';
    cells[height - 1]![x] = 'charger';
  }
  return { width, height, cells };
}

function runFleetBenchmark(robotCount: number, ticks = 60): BenchRow {
  const size = robotCount <= 10 ? 18 : robotCount <= 50 ? 28 : 38;
  const grid = buildScalableWarehouse(size, size);
  const rng = createPRNG(9000 + robotCount);

  const sim = new SimulationEngine({
    seed: 9000 + robotCount,
    grid,
    policy: {
      planningHorizon: robotCount >= 50 ? 24 : 36,
      maxExpansions: robotCount >= 50 ? 450 : 1500,
      globalExpansionBudgetPerTick: 18000,
    },
  });

  const openCells: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (grid.cells[y]![x] === 'floor') {
        openCells.push({ x, y });
      }
    }
  }

  for (let i = 0; i < robotCount; i++) {
    const spawn = openCells[i * 2]!;
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: `R-${String(i).padStart(3, '0')}`, cell: spawn },
    });
  }

  const jobCount = robotCount;
  for (let j = 0; j < jobCount; j++) {
    const pIdx = (openCells.length - 1 - j * 2 + openCells.length) % openCells.length;
    const dIdx = (openCells.length - 2 - j * 2 + openCells.length) % openCells.length;
    const pCell = openCells[pIdx]!;
    const dCell = openCells[dIdx]!;
    grid.cells[pCell.y]![pCell.x] = 'pickup';
    grid.cells[dCell.y]![dCell.x] = 'drop';

    const pkgId = `PKG-${j}`;
    const podId = `POD-${j}`;
    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: pkgId, weight: 2, priority: j % 4 === 0 ? 'URGENT' : 'NORMAL' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: podId, cell: pCell, packageIds: [pkgId] },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: rng.nextInt(0, 10),
      job: {
        id: `JOB-${j}`,
        podId,
        packageIds: [pkgId],
        pickupCell: pCell,
        dropCell: dCell,
        priority: j % 4 === 0 ? 'URGENT' : 'NORMAL',
      },
    });
  }

  let totalMs = 0;
  let maxMs = 0;
  let deferredTotal = 0;

  for (let t = 0; t < ticks; t++) {
    sim.step();
    const stats = sim.getState().plannerStats;
    totalMs += stats.lastTickWallClockMs;
    if (stats.lastTickWallClockMs > maxMs) maxMs = stats.lastTickWallClockMs;
    deferredTotal += stats.deferredRequests;
  }

  const m = sim.getMetrics();
  return {
    robotCount,
    ticks,
    avgPlannerMsPerTick: Number((totalMs / ticks).toFixed(3)),
    maxPlannerMsPerTick: Number(maxMs.toFixed(3)),
    avgExpansionsPerTick: Number(
      (sim.getState().plannerStats.totalExpansions / ticks).toFixed(1)
    ),
    deferredRequestsTotal: deferredTotal,
    jobsCompleted: m.jobsCompleted,
    throughputPer100Ticks: Number(m.throughputPer100Ticks.toFixed(2)),
    predictedDeadlocksResolved: m.predictedDeadlocksResolved,
    reactiveDeadlocksResolved: m.reactiveDeadlocksResolved,
    invariantOk: sim.checkInvariants().ok,
    ledgerChainValid: sim.verifyLedgerChain().valid,
  };
}

describe('Fleet Scaling Benchmark (10, 50, 100 Robots)', () => {
  it('benchmarks 10, 50, and 100 robots within deterministic expansion budgets and writes docs/benchmark-results.json', () => {
    const results = [10, 50, 100].map((count) => runFleetBenchmark(count, 60));

    const payload = {
      generatedAt: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCores: os.cpus().length,
      },
      results,
    };

    const outPath = path.resolve(process.cwd(), 'docs/benchmark-results.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');

    for (const row of results) {
      expect(row.invariantOk).toBe(true);
      expect(row.ledgerChainValid).toBe(true);
      expect(row.avgExpansionsPerTick).toBeLessThanOrEqual(18000);
    }
  }, 120_000);
});
