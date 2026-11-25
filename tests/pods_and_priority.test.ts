import { describe, expect, it } from 'vitest';
import {
  CellType,
  compareJobsDeterministic,
  DEFAULT_POLICY,
  Job,
  SimulationEngine,
} from '../src/engine';

function makeOpenEngine(seed = 1) {
  const cells: CellType[][] = Array.from({ length: 6 }, () =>
    Array.from({ length: 6 }, (): CellType => 'floor')
  );
  cells[1]![1] = 'pickup';
  cells[4]![4] = 'drop';
  return new SimulationEngine({ seed, grid: { width: 6, height: 6, cells } });
}

describe('Pod & Package Identity, Duplicate Rejection, and Priority Aging', () => {
  it('rejects duplicate pod/package IDs and duplicate pickups/deliveries', () => {
    const sim = makeOpenEngine(7);

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-1', weight: 3, priority: 'NORMAL' },
    });
    // Duplicate package ID
    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-1', weight: 4, priority: 'HIGH' },
    });

    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-1', cell: { x: 1, y: 1 }, packageIds: ['PKG-1'] },
    });
    // Duplicate pod ID
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-1', cell: { x: 1, y: 1 }, packageIds: ['PKG-1'] },
    });

    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 1, y: 1 } },
    });

    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-1',
        podId: 'POD-1',
        packageIds: ['PKG-1'],
        pickupCell: { x: 1, y: 1 },
        dropCell: { x: 4, y: 4 },
      },
    });

    // Step 1 picks up POD-1 at (1,1)
    sim.step();

    const state = sim.getState();
    const rejections = state.eventLog.filter((e) => e.status === 'REJECTED');
    expect(rejections.length).toBe(2);

    // Attempt duplicate pickup on already picked-up job
    const robot = state.robots['R1']!;
    const job = state.jobs['JOB-1']!;
    expect(sim.attemptPickup(robot, job)).toBe(false);

    // Run to delivery completion
    sim.stepMany(12);
    expect(job.status).toBe('COMPLETED');

    // Attempt duplicate delivery on completed job
    expect(sim.attemptDrop(robot, job)).toBe(false);
  });

  it('orders jobs by priority, promotes aged low-priority jobs, and uses deterministic ID tie-breakers', () => {
    const policy = { ...DEFAULT_POLICY, enableAging: true, agingIntervalTicks: 20 };
    const lowOld: Job = {
      id: 'JOB-B',
      podId: 'P1',
      packageIds: ['K1'],
      pickupCell: { x: 0, y: 0 },
      dropCell: { x: 1, y: 1 },
      priority: 'LOW',
      createdTick: 0,
      status: 'PENDING',
      assignedRobotId: null,
      pickedUpPackageIds: [],
      deliveredPackageIds: [],
      pickedUpAtTick: null,
      completedAtTick: null,
    };
    const normalNewA: Job = { ...lowOld, id: 'JOB-A', priority: 'NORMAL', createdTick: 15 };
    const normalNewC: Job = { ...lowOld, id: 'JOB-C', priority: 'NORMAL', createdTick: 15 };

    // At tick 15: NORMAL beats LOW (age 15 < 20); tie between JOB-A and JOB-C resolves to JOB-A
    expect(compareJobsDeterministic(normalNewA, lowOld, 15, policy)).toBeLessThan(0);
    expect(compareJobsDeterministic(normalNewA, normalNewC, 15, policy)).toBeLessThan(0);

    // At tick 25: lowOld aged +1 tier to NORMAL and has greater age (25 > 10), so lowOld wins
    expect(compareJobsDeterministic(lowOld, normalNewA, 25, policy)).toBeLessThan(0);
  });
});
