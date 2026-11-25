import { describe, expect, it } from 'vitest';
import { CellType, SimulationEngine } from '../src/engine';

describe('Simulated Human Safety & Narrow Corridor Priority Aging', () => {
  it('stops/replans when a simulated human enters a route and enforces conservative stop on stale telemetry', () => {
    const cells: CellType[][] = Array.from({ length: 5 }, () =>
      Array.from({ length: 8 }, (): CellType => 'floor')
    );
    cells[2]![0] = 'pickup';
    cells[2]![7] = 'drop';

    const sim = new SimulationEngine({
      seed: 601,
      grid: { width: 8, height: 5, cells },
      profile: { humanBufferRadius: 1, humanStaleTimeoutTicks: 3 },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'PKG-H', weight: 1, priority: 'NORMAL' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD-H', cell: { x: 0, y: 2 }, packageIds: ['PKG-H'] },
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
        id: 'JOB-H',
        podId: 'POD-H',
        packageIds: ['PKG-H'],
        pickupCell: { x: 0, y: 2 },
        dropCell: { x: 7, y: 2 },
      },
    });

    // Place human directly in front of R1 at (2, 2)
    sim.dispatch({
      type: 'ADD_HUMAN',
      tick: 1,
      human: { id: 'HUM-1', cell: { x: 2, y: 2 } },
    });

    sim.stepMany(5);
    // Robot must never enter human buffer (distance <= 1 from (2,2))
    const r1 = sim.getState().robots['R1']!;
    const dist = Math.abs(r1.cell.x - 2) + Math.abs(r1.cell.y - 2);
    expect(dist).toBeGreaterThan(1);

    // Advance without updating human telemetry beyond stale timeout (3 ticks)
    sim.stepMany(4);
    expect(sim.getMetrics().safetyStops).toBeGreaterThan(0);
    expect(sim.checkInvariants().ok).toBe(true);
  });

  it('resolves narrow-corridor standoff via priority aging (k ticks)', () => {
    const width = 9;
    const height = 3;
    const cells: CellType[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, (): CellType => 'wall')
    );
    for (let x = 0; x < width; x++) cells[1]![x] = 'floor';
    cells[1]![0] = 'pickup';
    cells[1]![8] = 'drop';
    cells[0]![4] = 'bay';

    const sim = new SimulationEngine({
      seed: 602,
      grid: { width, height, cells },
      policy: { conflictMode: 'PRIORITY_AGING', stallEscalationTicks: 3 },
    });

    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'P1', weight: 1, priority: 'LOW' },
    });
    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: 'P2', weight: 1, priority: 'LOW' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD1', cell: { x: 0, y: 1 }, packageIds: ['P1'] },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: 'POD2', cell: { x: 8, y: 1 }, packageIds: ['P2'] },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R1', cell: { x: 0, y: 1 } },
    });
    sim.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: 'R2', cell: { x: 8, y: 1 } },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'J1',
        podId: 'POD1',
        packageIds: ['P1'],
        pickupCell: { x: 0, y: 1 },
        dropCell: { x: 8, y: 1 },
        priority: 'LOW',
      },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: 'J2',
        podId: 'POD2',
        packageIds: ['P2'],
        pickupCell: { x: 8, y: 1 },
        dropCell: { x: 0, y: 1 },
        priority: 'LOW',
      },
    });

    sim.stepMany(60);
    expect(sim.getState().custody['P1']?.state).toBe('DELIVERED');
    expect(sim.getState().custody['P2']?.state).toBe('DELIVERED');
    expect(sim.checkInvariants().ok).toBe(true);
  });
});
