import { describe, expect, it } from 'vitest';
import {
  CellType,
  generateChaosCommands,
  runABComparison,
  SimulationEngine,
} from '../src/engine';

function makeThreeWayCycleGrid(): CellType[][] {
  // 7x7 grid with a central junction and recessed passing bays
  const cells: CellType[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 7 }, (): CellType => 'wall')
  );
  // Cross corridors along x=3 and y=3
  for (let i = 0; i < 7; i++) {
    cells[3]![i] = 'floor';
    cells[i]![3] = 'floor';
  }
  // Passing bays adjacent to corridor arms
  cells[2]![2] = 'bay';
  cells[2]![4] = 'bay';
  cells[4]![2] = 'bay';
  cells[4]![4] = 'bay';

  cells[3]![0] = 'pickup';
  cells[3]![6] = 'drop';
  cells[0]![3] = 'pickup';
  cells[6]![3] = 'drop';
  return cells;
}

describe('Deadlock Prediction, Time Travel, and A/B Comparison', () => {
  it('detects a 3-robot wait-for cycle BEFORE true gridlock and resolves it preemptively', () => {
    const sim = new SimulationEngine({
      seed: 701,
      grid: { width: 7, height: 7, cells: makeThreeWayCycleGrid() },
      policy: {
        enableDeadlockPrediction: true,
        deadlockLookaheadTicks: 10,
      },
    });

    // Three robots converging on the central intersection (3,3)
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R1', cell: { x: 1, y: 3 } } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R2', cell: { x: 5, y: 3 } } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R3', cell: { x: 3, y: 1 } } });

    for (let i = 1; i <= 3; i++) {
      sim.dispatch({
        type: 'REGISTER_PACKAGE',
        tick: 0,
        pkg: { id: `P${i}`, weight: 2, priority: 'NORMAL' },
      });
    }
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD1', cell: { x: 1, y: 3 }, packageIds: ['P1'] } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD2', cell: { x: 5, y: 3 }, packageIds: ['P2'] } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD3', cell: { x: 3, y: 1 }, packageIds: ['P3'] } });

    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J1', podId: 'POD1', packageIds: ['P1'], pickupCell: { x: 1, y: 3 }, dropCell: { x: 3, y: 6 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J2', podId: 'POD2', packageIds: ['P2'], pickupCell: { x: 5, y: 3 }, dropCell: { x: 3, y: 6 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J3', podId: 'POD3', packageIds: ['P3'], pickupCell: { x: 3, y: 1 }, dropCell: { x: 6, y: 3 } },
    });

    sim.stepMany(35);

    expect(sim.getState().custody['P1']?.state).toBe('DELIVERED');
    expect(sim.getState().custody['P2']?.state).toBe('DELIVERED');
    expect(sim.getState().custody['P3']?.state).toBe('DELIVERED');
    expect(sim.checkInvariants().ok).toBe(true);
  });

  it('rewinds to tick T and replays identically with same policy, or branches cleanly with a new policy', () => {
    const grid = { width: 7, height: 7, cells: makeThreeWayCycleGrid() };
    const chaos = generateChaosCommands(grid, {
      seed: 808,
      intensity: 0.4,
      durationTicks: 30,
      robotIds: ['R1', 'R2'],
      pickupCells: [{ x: 3, y: 0 }],
      dropCells: [{ x: 3, y: 6 }],
    });

    const sim = new SimulationEngine({ seed: 808, grid });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R1', cell: { x: 1, y: 3 } } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R2', cell: { x: 5, y: 3 } } });
    for (const c of chaos) sim.dispatch(c);

    sim.stepMany(25);
    const hashAt25 = sim.stateHash();

    // Rewind to tick 12 and replay back to 25 with unchanged policy
    sim.rewindTo(12);
    sim.stepMany(13);
    expect(sim.stateHash()).toBe(hashAt25);

    // Branch from tick 12 with different policy
    const branch = sim.branchFrom(12, {
      enableDynamicEdgePricing: false,
      conflictMode: 'AUCTION_REBID',
    });
    branch.stepMany(13);
    expect(branch.checkInvariants().ok).toBe(true);
    expect(branch.verifyLedgerChain().valid).toBe(true);
  });

  it('runs A/B policy comparison on identical job stream and chaos seed', () => {
    const grid = { width: 7, height: 7, cells: makeThreeWayCycleGrid() };
    const commands = [
      { type: 'ADD_ROBOT' as const, tick: 0, robot: { id: 'R1', cell: { x: 1, y: 3 } } },
      { type: 'ADD_ROBOT' as const, tick: 0, robot: { id: 'R2', cell: { x: 5, y: 3 } } },
      { type: 'REGISTER_PACKAGE' as const, tick: 0, pkg: { id: 'PA', weight: 2, priority: 'HIGH' as const } },
      { type: 'REGISTER_POD' as const, tick: 0, pod: { id: 'PODA', cell: { x: 3, y: 0 }, packageIds: ['PA'] } },
      {
        type: 'ADD_JOB' as const,
        tick: 0,
        job: { id: 'JA', podId: 'PODA', packageIds: ['PA'], pickupCell: { x: 3, y: 0 }, dropCell: { x: 3, y: 6 } },
      },
    ];

    const ab = runABComparison({
      seed: 909,
      grid,
      commands,
      policyA: { enableDynamicEdgePricing: true, enableDeadlockPrediction: true },
      policyB: { enableDynamicEdgePricing: false, enableDeadlockPrediction: false },
      labelA: 'Smart Policy',
      labelB: 'Baseline Policy',
      ticks: 25,
    });

    expect(ab.seriesA.length).toBe(25);
    expect(ab.seriesB.length).toBe(25);
    expect(ab.summaryA.invariantOk).toBe(true);
    expect(ab.summaryB.invariantOk).toBe(true);
  });
});
