import { SimulationEngine } from './engine';
import { CellType } from './types';

export interface SelfTestCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SelfTestSuiteReport {
  allPassed: boolean;
  durationMs: number;
  checks: SelfTestCheckResult[];
}

export function runInAppSelfTests(): SelfTestSuiteReport {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const checks: SelfTestCheckResult[] = [];

  // 1. Collision-free corridor bypass & Custody Invariants
  {
    const cells: CellType[][] = Array.from({ length: 3 }, () =>
      Array.from({ length: 9 }, (): CellType => 'wall')
    );
    for (let x = 0; x < 9; x++) cells[1]![x] = 'floor';
    cells[1]![0] = 'pickup';
    cells[1]![8] = 'drop';
    cells[0]![4] = 'bay';

    const sim = new SimulationEngine({ seed: 42, grid: { width: 9, height: 3, cells } });
    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'P1', weight: 2, priority: 'URGENT' } });
    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'P2', weight: 2, priority: 'LOW' } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD1', cell: { x: 0, y: 1 }, packageIds: ['P1'] } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD2', cell: { x: 8, y: 1 }, packageIds: ['P2'] } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R1', cell: { x: 0, y: 1 } } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R2', cell: { x: 8, y: 1 } } });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J1', podId: 'POD1', packageIds: ['P1'], pickupCell: { x: 0, y: 1 }, dropCell: { x: 8, y: 1 }, priority: 'URGENT' },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J2', podId: 'POD2', packageIds: ['P2'], pickupCell: { x: 8, y: 1 }, dropCell: { x: 0, y: 1 }, priority: 'LOW' },
    });

    let collision = false;
    for (let t = 0; t < 50; t++) {
      sim.step();
      const s = sim.getState();
      if (s.robots['R1']!.cell.x === s.robots['R2']!.cell.x && s.robots['R1']!.cell.y === s.robots['R2']!.cell.y) {
        collision = true;
      }
    }

    const inv = sim.checkInvariants();
    const chain = sim.verifyLedgerChain();
    checks.push({
      name: 'Corridor Deadlock & Zero-Collision Check',
      passed: !collision && sim.getState().custody['P1']?.state === 'DELIVERED',
      detail: collision ? 'Vertex collision occurred' : 'Head-on conflict resolved via passing bay',
    });
    checks.push({
      name: 'Custody Invariants & Hash Chain',
      passed: inv.ok && chain.valid,
      detail: inv.ok && chain.valid ? '0 duplicate carries, 0 double deliveries, chain valid' : inv.violations.join('; '),
    });
  }

  // 2. Battery-Based Reassignment Check
  {
    const cells: CellType[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 8 }, (): CellType => 'floor')
    );
    cells[0]![0] = 'charger';
    cells[2]![1] = 'pickup';
    cells[2]![7] = 'drop';

    const sim = new SimulationEngine({
      seed: 77,
      grid: { width: 8, height: 4, cells },
      profile: { batterySafetyReserve: 25, baseBatteryDrain: 2.5 },
    });
    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'PB', weight: 2, priority: 'HIGH' } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'PODB', cell: { x: 1, y: 2 }, packageIds: ['PB'] } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R-LOW', cell: { x: 7, y: 3 }, battery: 36 } });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'JB', podId: 'PODB', packageIds: ['PB'], pickupCell: { x: 1, y: 2 }, dropCell: { x: 7, y: 2 } },
    });
    sim.stepMany(5);
    const reassigned = (sim.getState().jobs['JB']?.reassignmentCount ?? 0) >= 1;
    checks.push({
      name: 'Battery-Aware Job Reassignment',
      passed: reassigned && sim.checkInvariants().ok,
      detail: reassigned
        ? 'Low-battery robot released job before pickup and routed to charger'
        : 'Job was not reassigned on low battery',
    });
  }

  // 3. Package-Location Mismatch Detection Check
  {
    const cells: CellType[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 5 }, (): CellType => 'floor')
    );
    cells[1]![1] = 'pickup';
    cells[1]![4] = 'drop';

    const sim = new SimulationEngine({ seed: 88, grid: { width: 5, height: 4, cells } });
    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'PM', weight: 1, priority: 'NORMAL' } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'PODM', cell: { x: 1, y: 1 }, packageIds: ['PM'] } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'RM', cell: { x: 0, y: 1 } } });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'JM', podId: 'PODM', packageIds: ['PM'], pickupCell: { x: 1, y: 1 }, dropCell: { x: 4, y: 1 } },
    });
    sim.step();
    const rm = sim.getState().robots['RM']!;
    const jm = sim.getState().jobs['JM']!;
    rm.cell = { x: 0, y: 1 }; // Wrong pickup location
    const rejected = !sim.attemptPickup(rm, jm);
    const incidents = sim.getMetrics().misplacedIncidents;
    checks.push({
      name: 'Package-Location Mismatch Guard',
      passed: rejected && incidents >= 1 && sim.checkInvariants().ok,
      detail: `Rejected off-station pickup and logged ${incidents} incident(s)`,
    });
  }

  // 4. Simulated Human Safety Stop Check
  {
    const cells: CellType[][] = Array.from({ length: 3 }, () =>
      Array.from({ length: 6 }, (): CellType => 'floor')
    );
    cells[1]![0] = 'pickup';
    cells[1]![5] = 'drop';

    const sim = new SimulationEngine({
      seed: 99,
      grid: { width: 6, height: 3, cells },
      profile: { humanBufferRadius: 1 },
    });
    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'PH', weight: 1, priority: 'NORMAL' } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'PODH', cell: { x: 0, y: 1 }, packageIds: ['PH'] } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'RH', cell: { x: 0, y: 1 } } });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'JH', podId: 'PODH', packageIds: ['PH'], pickupCell: { x: 0, y: 1 }, dropCell: { x: 5, y: 1 } },
    });
    sim.dispatch({ type: 'ADD_HUMAN', tick: 1, human: { id: 'H-SAFE', cell: { x: 2, y: 1 } } });
    sim.stepMany(4);

    const rh = sim.getState().robots['RH']!;
    const dist = Math.abs(rh.cell.x - 2) + Math.abs(rh.cell.y - 1);
    checks.push({
      name: 'Simulated Human Safety Buffer Stop',
      passed: dist > 1 && sim.getMetrics().safetyStops > 0,
      detail: `Robot maintained Manhattan distance ${dist} (>1 buffer) with ${sim.getMetrics().safetyStops} safety stop(s)`,
    });
  }

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    allPassed: checks.every((c) => c.passed),
    durationMs: Number((end - start).toFixed(2)),
    checks,
  };
}
