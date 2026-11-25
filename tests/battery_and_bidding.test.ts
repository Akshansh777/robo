import { describe, expect, it } from 'vitest';
import { CellType, SimulationEngine } from '../src/engine';

function makeBatteryGrid(): CellType[][] {
  const cells: CellType[][] = Array.from({ length: 6 }, () =>
    Array.from({ length: 10 }, (): CellType => 'floor')
  );
  cells[0]![0] = 'charger';
  cells[2]![1] = 'pickup';
  cells[2]![8] = 'drop';
  return cells;
}

describe('Battery-Aware Task Management, Priority & Aging', () => {
  it('refuses to assign jobs to robots lacking the required energy reserve', () => {
    const sim = new SimulationEngine({
      seed: 501,
      grid: { width: 10, height: 6, cells: makeBatteryGrid() },
      profile: { batterySafetyReserve: 25 },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-B1', weight: 5, priority: 'NORMAL' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-B1', cell: { x: 1, y: 2 }, packageIds: ['PKG-B1'] },
    });
    // R-LOW only has 15% battery (< 25% reserve + route cost); R-HIGH has 95%
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R-LOW', cell: { x: 1, y: 2 }, battery: 15 },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R-HIGH', cell: { x: 5, y: 2 }, battery: 95 },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-B1',
        podId: 'POD-B1',
        packageIds: ['PKG-B1'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 8, y: 2 },
      },
    });

    sim.step();
    expect(sim.getState().jobs['JOB-B1']?.assignedRobotId).toBe('R-HIGH');
  });

  it('releases and re-bids a job if battery drops below reserve before pickup', () => {
    const sim = new SimulationEngine({
      seed: 502,
      grid: { width: 10, height: 6, cells: makeBatteryGrid() },
      profile: { batterySafetyReserve: 20, baseBatteryDrain: 2.0 },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-REBID', weight: 2, priority: 'HIGH' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-REBID', cell: { x: 1, y: 2 }, packageIds: ['PKG-REBID'] },
    });
    // R1 starts far away with borderline battery (35%)
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 8, y: 5 }, battery: 35 },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-REBID',
        podId: 'POD-REBID',
        packageIds: ['PKG-REBID'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 8, y: 2 },
      },
    });

    sim.stepMany(4);
    // After draining below reserve en route, R1 releases the job back to PENDING
    expect(sim.getState().jobs['JOB-REBID']?.reassignmentCount).toBeGreaterThanOrEqual(1);
    expect(sim.checkInvariants().ok).toBe(true);
  });

  it('preserves custody and completes rescue when battery hits 0 during transport', () => {
    const sim = new SimulationEngine({
      seed: 503,
      grid: { width: 10, height: 6, cells: makeBatteryGrid() },
      profile: { batterySafetyReserve: 0, baseBatteryDrain: 8.0 },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-DEPLETE', weight: 2, priority: 'URGENT' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-DEP', cell: { x: 1, y: 2 }, packageIds: ['PKG-DEPLETE'] },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 1, y: 2 }, battery: 18 },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-DEP',
        podId: 'POD-DEP',
        packageIds: ['PKG-DEPLETE'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 8, y: 2 },
      },
    });

    // R1 picks up and runs out of battery after 2 moves
    sim.stepMany(4);
    expect(sim.getState().robots['R1']?.status).toBe('FAILED');
    expect(sim.getState().custody['PKG-DEPLETE']?.state).toBe('STRANDED');

    // Add fresh rescuer R2; rescue job completes delivery
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 4,
      robot: { id: 'R2', cell: { x: 3, y: 4 }, battery: 100 },
    });
    sim.stepMany(20);
    expect(sim.getState().custody['PKG-DEPLETE']?.state).toBe('DELIVERED');
    expect(sim.checkInvariants().ok).toBe(true);
  });
});
