import { describe, expect, it } from 'vitest';
import { CellType, SimulationEngine } from '../src/engine';

function makeGrid(width = 8, height = 5): CellType[][] {
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'floor')
  );
  cells[2]![1] = 'pickup';
  cells[2]![6] = 'drop';
  cells[0]![1] = 'charger';
  return cells;
}

describe('Custody Ledger, Fencing Tokens, Failure Rescue & Misplaced Packages', () => {
  it('rejects a stale robot (old epoch) attempting a drop and verifies hash chain', () => {
    const sim = new SimulationEngine({
      seed: 101,
      grid: { width: 8, height: 5, cells: makeGrid() },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-STALE', weight: 2, priority: 'HIGH' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-1', cell: { x: 1, y: 2 }, packageIds: ['PKG-STALE'] },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 1, y: 2 } },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R2', cell: { x: 3, y: 3 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-1',
        podId: 'POD-1',
        packageIds: ['PKG-STALE'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 6, y: 2 },
        priority: 'HIGH',
      },
    });

    // R1 picks up PKG-STALE at tick 0 -> epoch becomes 2
    sim.step();
    const staleEpoch = sim.getState().custody['PKG-STALE']!.epoch;
    expect(staleEpoch).toBe(2);

    // Fail R1 mid-route -> PKG-STALE becomes STRANDED (epoch=3) and R2 rescues it
    sim.dispatch({ type: 'FAIL_ROBOT', tick: 2, robotId: 'R1' });
    sim.stepMany(15);

    // Recover R1 and attempt a drop using R1's old epoch
    sim.dispatch({ type: 'RECOVER_ROBOT', tick: 17, robotId: 'R1' });
    sim.step();

    const r1 = sim.getState().robots['R1']!;
    r1.cell = { x: 6, y: 2 };
    const origJob = sim.getState().jobs['JOB-1']!;

    const accepted = sim.attemptDrop(r1, origJob, sim.getState().tick, staleEpoch);
    expect(accepted).toBe(false);
    expect(sim.verifyLedgerChain().valid).toBe(true);
    expect(sim.checkInvariants().ok).toBe(true);
  });

  it('strands package when carrier is killed mid-route and delivers it exactly once via rescuer', () => {
    const sim = new SimulationEngine({
      seed: 202,
      grid: { width: 8, height: 5, cells: makeGrid() },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-RESCUE', weight: 3, priority: 'URGENT' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-R', cell: { x: 1, y: 2 }, packageIds: ['PKG-RESCUE'] },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 1, y: 2 } },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R2', cell: { x: 1, y: 4 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-MAIN',
        podId: 'POD-R',
        packageIds: ['PKG-RESCUE'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 6, y: 2 },
        priority: 'URGENT',
      },
    });

    // R1 picks up and moves partway
    sim.stepMany(3);
    expect(sim.getState().custody['PKG-RESCUE']?.state).toBe('PICKED');

    // Kill R1 mid-route
    sim.dispatch({ type: 'FAIL_ROBOT', tick: 3, robotId: 'R1' });
    sim.step();
    expect(sim.getState().custody['PKG-RESCUE']?.state).toBe('STRANDED');

    // R2 routes around dead R1's blocked cell, picks up stranded pod, and delivers to (6,2)
    sim.stepMany(25);
    expect(sim.getState().custody['PKG-RESCUE']?.state).toBe('DELIVERED');
    expect(sim.checkInvariants().ok).toBe(true);
    expect(sim.verifyLedgerChain().valid).toBe(true);
  });

  it('detects wrong-package, wrong-pickup, and wrong-drop attempts and spawns inspection recovery', () => {
    const sim = new SimulationEngine({
      seed: 303,
      grid: { width: 8, height: 5, cells: makeGrid() },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-A', weight: 2, priority: 'NORMAL' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-A', cell: { x: 1, y: 2 }, packageIds: ['PKG-A'] },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 0, y: 2 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'JOB-A',
        podId: 'POD-A',
        packageIds: ['PKG-A'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 6, y: 2 },
      },
    });

    sim.step();
    const r1 = sim.getState().robots['R1']!;
    const job = sim.getState().jobs['JOB-A']!;

    // Wrong pickup cell (0,2 instead of 1,2)
    expect(sim.attemptPickup(r1, job)).toBe(false);

    // Move to (1,2) and present wrong pod ID
    r1.cell = { x: 1, y: 2 };
    expect(sim.attemptPickup(r1, job, sim.getState().tick, 'POD-WRONG')).toBe(false);

    // Valid pickup, then attempt drop at wrong cell (4,2 instead of 6,2)
    expect(sim.attemptPickup(r1, job)).toBe(true);
    r1.cell = { x: 4, y: 2 };
    expect(sim.attemptDrop(r1, job)).toBe(false);

    expect(sim.getMetrics().misplacedIncidents).toBeGreaterThanOrEqual(3);
    expect(sim.checkInvariants().ok).toBe(true);
  });

  it('detects ledger tampering when an entry is mutated', () => {
    const sim = new SimulationEngine({
      seed: 404,
      grid: { width: 8, height: 5, cells: makeGrid() },
    });
    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-T', weight: 1, priority: 'LOW' },
    });
    sim.step();

    expect(sim.verifyLedgerChain().valid).toBe(true);
    // Tamper with log entry detail
    (sim.getState().eventLog[0] as { detail: string }).detail = 'TAMPERED';
    const check = sim.verifyLedgerChain();
    expect(check.valid).toBe(false);
    expect(check.brokenAtSeq).toBe(0);
  });
});
