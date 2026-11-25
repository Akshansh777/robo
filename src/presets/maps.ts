import {
  CellType,
  Coord,
  createPRNG,
  GridMap,
  isStaticallyReachable,
  Priority,
  SimulationEngine,
} from '../engine';

export type PresetId =
  | 'narrow-aisle'
  | 'kiva-grid'
  | 'hospital-corridor'
  | 'fleet-50';

export interface PresetMeta {
  id: PresetId;
  name: string;
  subtitle: string;
  seed: number;
}

export const PRESET_CATALOG: readonly PresetMeta[] = [
  {
    id: 'narrow-aisle',
    name: 'Narrow Aisle Showdown',
    subtitle: 'Single-lane head-on conflict with recessed passing bays',
    seed: 42,
  },
  {
    id: 'kiva-grid',
    name: 'Kiva Grid',
    subtitle: 'High-density pod storage matrix with chargers and slow zones',
    seed: 1337,
  },
  {
    id: 'hospital-corridor',
    name: 'Hospital Corridor',
    subtitle: 'Pharmacy wing with RF deadzones and simulated human staff',
    seed: 2026,
  },
  {
    id: 'fleet-50',
    name: '50-Robot Stress Floor',
    subtitle: 'Large fulfillment floor for 60fps and budget scaling',
    seed: 5050,
  },
];

export function createPresetEngine(id: PresetId, customSeed?: number): SimulationEngine {
  switch (id) {
    case 'narrow-aisle':
      return createNarrowAisleShowdown(customSeed ?? 42);
    case 'kiva-grid':
      return createKivaGridScenario(customSeed ?? 1337);
    case 'hospital-corridor':
      return createHospitalCorridorScenario(customSeed ?? 2026);
    case 'fleet-50':
      return createFiftyRobotFloor(customSeed ?? 5050);
  }
}

export function createNarrowAisleShowdown(seed = 42): SimulationEngine {
  const width = 15;
  const height = 7;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'wall')
  );

  for (let x = 1; x < width - 1; x++) {
    cells[2]![x] = 'floor';
    cells[4]![x] = 'floor';
  }
  cells[3]![1] = 'floor';
  cells[3]![width - 2] = 'floor';

  cells[1]![5] = 'bay';
  cells[1]![9] = 'bay';
  cells[5]![7] = 'bay';

  cells[1]![1] = 'charger';
  cells[5]![13] = 'charger';
  cells[2]![1] = 'pickup';
  cells[2]![13] = 'drop';
  cells[4]![13] = 'pickup';
  cells[4]![1] = 'drop';

  const engine = new SimulationEngine({
    seed,
    grid: { width, height, cells },
    policy: {
      enableDeadlockPrediction: true,
      deadlockLookaheadTicks: 10,
      stallEscalationTicks: 4,
    },
  });

  const jobs: Array<{
    bot: string;
    start: Coord;
    pkg: string;
    pod: string;
    job: string;
    pickup: Coord;
    drop: Coord;
    priority: Priority;
  }> = [
    {
      bot: 'R-01',
      start: { x: 1, y: 2 },
      pkg: 'PKG-NA1',
      pod: 'POD-NA1',
      job: 'JOB-NA1',
      pickup: { x: 1, y: 2 },
      drop: { x: 13, y: 2 },
      priority: 'URGENT',
    },
    {
      bot: 'R-02',
      start: { x: 13, y: 2 },
      pkg: 'PKG-NA2',
      pod: 'POD-NA2',
      job: 'JOB-NA2',
      pickup: { x: 13, y: 4 },
      drop: { x: 1, y: 4 },
      priority: 'NORMAL',
    },
    {
      bot: 'R-03',
      start: { x: 7, y: 2 },
      pkg: 'PKG-NA3',
      pod: 'POD-NA3',
      job: 'JOB-NA3',
      pickup: { x: 1, y: 2 },
      drop: { x: 13, y: 2 },
      priority: 'HIGH',
    },
  ];

  for (const item of jobs) {
    engine.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: item.pkg, weight: 3, priority: item.priority },
    });
    engine.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: item.pod, cell: item.pickup, packageIds: [item.pkg] },
    });
    engine.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: item.bot, cell: item.start },
    });
    engine.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: item.job,
        podId: item.pod,
        packageIds: [item.pkg],
        pickupCell: item.pickup,
        dropCell: item.drop,
        priority: item.priority,
      },
    });
  }

  return engine;
}

export function createCorridorBypassScenario(seed = 42): SimulationEngine {
  const width = 9;
  const height = 3;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'wall')
  );

  for (let x = 0; x < width; x++) {
    cells[1]![x] = 'floor';
  }
  cells[0]![4] = 'bay';
  cells[1]![0] = 'pickup';
  cells[1]![8] = 'pickup';

  const engine = new SimulationEngine({
    seed,
    grid: { width, height, cells },
  });

  engine.dispatch({
    type: 'REGISTER_PACKAGE',
    tick: 0,
    pkg: { id: 'pkg-east', weight: 2, priority: 'HIGH' },
  });
  engine.dispatch({
    type: 'REGISTER_PACKAGE',
    tick: 0,
    pkg: { id: 'pkg-west', weight: 2, priority: 'NORMAL' },
  });

  engine.dispatch({
    type: 'REGISTER_POD',
    tick: 0,
    pod: { id: 'pod-east', cell: { x: 0, y: 1 }, packageIds: ['pkg-east'] },
  });
  engine.dispatch({
    type: 'REGISTER_POD',
    tick: 0,
    pod: { id: 'pod-west', cell: { x: 8, y: 1 }, packageIds: ['pkg-west'] },
  });

  engine.dispatch({
    type: 'ADD_ROBOT',
    tick: 0,
    robot: { id: 'R1', cell: { x: 0, y: 1 } },
  });
  engine.dispatch({
    type: 'ADD_ROBOT',
    tick: 0,
    robot: { id: 'R2', cell: { x: 8, y: 1 } },
  });

  engine.dispatch({
    type: 'ADD_JOB',
    tick: 0,
    job: {
      id: 'job-east',
      podId: 'pod-east',
      packageIds: ['pkg-east'],
      pickupCell: { x: 0, y: 1 },
      dropCell: { x: 8, y: 1 },
      priority: 'HIGH',
    },
  });

  engine.dispatch({
    type: 'ADD_JOB',
    tick: 0,
    job: {
      id: 'job-west',
      podId: 'pod-west',
      packageIds: ['pkg-west'],
      pickupCell: { x: 8, y: 1 },
      dropCell: { x: 0, y: 1 },
      priority: 'NORMAL',
    },
  });

  return engine;
}

export function createKivaGridScenario(seed = 1337): SimulationEngine {
  const width = 20;
  const height = 13;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'floor')
  );

  for (let x = 0; x < width; x++) {
    cells[0]![x] = 'wall';
    cells[height - 1]![x] = 'wall';
  }
  for (let y = 0; y < height; y++) {
    cells[y]![0] = 'wall';
    cells[y]![width - 1] = 'wall';
  }

  for (const bx of [4, 8, 12, 15]) {
    for (const by of [2, 7]) {
      cells[by]![bx] = 'shelf';
      cells[by + 1]![bx] = 'shelf';
      cells[by + 2]![bx] = 'bay';
      cells[by]![bx + 1] = 'shelf';
      cells[by + 1]![bx + 1] = 'shelf';
      cells[by + 2]![bx + 1] = 'shelf';
    }
  }

  for (const y of [2, 5, 8, 10]) {
    cells[y]![1] = 'pickup';
    cells[y]![width - 2] = 'drop';
  }

  for (const x of [2, 6, 10, 14, 17]) {
    cells[1]![x] = 'charger';
    cells[height - 2]![x] = 'charger';
  }

  cells[6]![6] = 'slow';
  cells[6]![7] = 'slow';
  cells[6]![10] = 'deadzone';
  cells[6]![11] = 'deadzone';

  const engine = new SimulationEngine({
    seed,
    grid: { width, height, cells },
  });

  const pickups: Coord[] = [
    { x: 1, y: 2 },
    { x: 1, y: 5 },
    { x: 1, y: 8 },
    { x: 1, y: 10 },
  ];
  const drops: Coord[] = [
    { x: width - 2, y: 10 },
    { x: width - 2, y: 8 },
    { x: width - 2, y: 5 },
    { x: width - 2, y: 2 },
  ];
  const priorities: Priority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

  for (let i = 0; i < 8; i++) {
    const p = pickups[i % pickups.length]!;
    const d = drops[i % drops.length]!;
    const prio = priorities[i % priorities.length]!;
    const pkgId = `PKG-K${i + 1}`;
    const podId = `POD-K${i + 1}`;
    const jobId = `JOB-K${i + 1}`;
    const botId = `R-${String(i + 1).padStart(2, '0')}`;

    engine.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: pkgId, weight: 2 + (i % 5), priority: prio },
    });
    engine.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: podId, cell: p, packageIds: [pkgId] },
    });
    engine.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: {
        id: botId,
        cell: { x: 2 + (i % 4) * 4, y: i < 4 ? 1 : height - 2 },
        battery: i === 7 ? 24 : 96,
      },
    });
    engine.dispatch({
      type: 'ADD_JOB',
      tick: Math.floor(i / 4) * 3,
      job: {
        id: jobId,
        podId,
        packageIds: [pkgId],
        pickupCell: p,
        dropCell: d,
        priority: prio,
      },
    });
  }

  return engine;
}

export const createDemoWarehouseScenario = createKivaGridScenario;

export function createHospitalCorridorScenario(seed = 2026): SimulationEngine {
  const width = 18;
  const height = 11;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'wall')
  );

  for (let x = 1; x < width - 1; x++) {
    cells[5]![x] = 'floor';
  }
  for (const wx of [3, 7, 11, 14]) {
    for (let y = 1; y < height - 1; y++) {
      cells[y]![wx] = 'floor';
    }
    cells[4]![wx + 1] = 'bay';
  }

  cells[1]![3] = 'pickup';
  cells[9]![3] = 'pickup';
  cells[1]![14] = 'drop';
  cells[9]![14] = 'drop';
  cells[1]![7] = 'charger';
  cells[9]![11] = 'charger';

  cells[5]![8] = 'deadzone';
  cells[5]![9] = 'deadzone';
  cells[5]![5] = 'slow';

  const engine = new SimulationEngine({
    seed,
    grid: { width, height, cells },
    profile: { humanBufferRadius: 1, humanStaleTimeoutTicks: 10 },
  });

  engine.dispatch({
    type: 'ADD_HUMAN',
    tick: 0,
    human: { id: 'STAFF-01', cell: { x: 10, y: 3 } },
  });

  const runs = [
    { bot: 'MED-01', start: { x: 3, y: 2 }, pickup: { x: 3, y: 1 }, drop: { x: 14, y: 1 }, prio: 'URGENT' as Priority },
    { bot: 'MED-02', start: { x: 14, y: 8 }, pickup: { x: 3, y: 9 }, drop: { x: 14, y: 9 }, prio: 'HIGH' as Priority },
    { bot: 'MED-03', start: { x: 7, y: 1 }, pickup: { x: 3, y: 1 }, drop: { x: 14, y: 9 }, prio: 'NORMAL' as Priority },
    { bot: 'MED-04', start: { x: 11, y: 9 }, pickup: { x: 3, y: 9 }, drop: { x: 14, y: 1 }, prio: 'LOW' as Priority },
  ];

  runs.forEach((r, idx) => {
    const pkgId = `MED-PKG-${idx + 1}`;
    const podId = `MED-POD-${idx + 1}`;
    engine.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: pkgId, weight: 2, priority: r.prio },
    });
    engine.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: podId, cell: r.pickup, packageIds: [pkgId] },
    });
    engine.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: r.bot, cell: r.start },
    });
    engine.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: `MED-JOB-${idx + 1}`,
        podId,
        packageIds: [pkgId],
        pickupCell: r.pickup,
        dropCell: r.drop,
        priority: r.prio,
      },
    });
  });

  return engine;
}

export function createFiftyRobotFloor(seed = 5050): SimulationEngine {
  const width = 28;
  const height = 18;
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'floor')
  );

  for (let x = 3; x < width - 3; x += 3) {
    for (let y = 2; y < height - 2; y++) {
      if (y % 5 === 0) continue;
      cells[y]![x] = y % 5 === 2 ? 'bay' : 'shelf';
    }
  }
  for (let x = 1; x < width - 1; x += 4) {
    cells[0]![x] = 'charger';
    cells[height - 1]![x] = 'charger';
  }

  const open: Coord[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (cells[y]![x] === 'floor') open.push({ x, y });
    }
  }

  const engine = new SimulationEngine({
    seed,
    grid: { width, height, cells },
    policy: {
      planningHorizon: 24,
      maxExpansions: 450,
      globalExpansionBudgetPerTick: 18000,
    },
  });

  for (let i = 0; i < 50; i++) {
    const spawn = open[i * 2]!;
    engine.dispatch({
      type: 'ADD_ROBOT',
      tick: 0,
      robot: { id: `R-${String(i + 1).padStart(2, '0')}`, cell: spawn },
    });
  }

  for (let j = 0; j < 40; j++) {
    const p = open[open.length - 1 - j * 2]!;
    const d = open[open.length - 2 - j * 2]!;
    cells[p.y]![p.x] = 'pickup';
    cells[d.y]![d.x] = 'drop';
    const pkgId = `PKG-50-${j + 1}`;
    const podId = `POD-50-${j + 1}`;
    engine.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: pkgId, weight: 2, priority: j % 4 === 0 ? 'URGENT' : 'NORMAL' },
    });
    engine.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: podId, cell: p, packageIds: [pkgId] },
    });
    engine.dispatch({
      type: 'ADD_JOB',
      tick: j % 6,
      job: {
        id: `JOB-50-${j + 1}`,
        podId,
        packageIds: [pkgId],
        pickupCell: p,
        dropCell: d,
        priority: j % 4 === 0 ? 'URGENT' : 'NORMAL',
      },
    });
  }

  return engine;
}

export function generateRandomScenario(
  seed: number,
  robotCount: number
): SimulationEngine {
  const rng = createPRNG(seed);
  const width = rng.nextInt(12, 19);
  const height = rng.nextInt(10, 15);
  const cells: CellType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): CellType => 'floor')
  );

  const openCells: Coord[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        cells[y]![x] = 'floor';
        openCells.push({ x, y });
        continue;
      }
      const roll = rng.next();
      if (roll < 0.16) {
        cells[y]![x] = 'shelf';
      } else if (roll < 0.21) {
        cells[y]![x] = 'bay';
        openCells.push({ x, y });
      } else if (roll < 0.25) {
        cells[y]![x] = 'slow';
        openCells.push({ x, y });
      } else if (roll < 0.28) {
        cells[y]![x] = 'deadzone';
        openCells.push({ x, y });
      } else {
        cells[y]![x] = 'floor';
        openCells.push({ x, y });
      }
    }
  }

  const emptySet = new Set<string>();
  const grid: GridMap = { width, height, cells };
  for (const c of openCells) {
    if (!isStaticallyReachable(grid, emptySet, { x: 0, y: 0 }, c)) {
      let cx = c.x;
      let cy = c.y;
      while (cx > 0) {
        cells[cy]![cx] = 'floor';
        cx--;
      }
      while (cy > 0) {
        cells[cy]![cx] = 'floor';
        cy--;
      }
    }
  }

  const traversable: Coord[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y]![x] !== 'wall' && cells[y]![x] !== 'shelf') {
        traversable.push({ x, y });
      }
    }
  }

  for (let i = traversable.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i + 1);
    const tmp = traversable[i]!;
    traversable[i] = traversable[j]!;
    traversable[j] = tmp;
  }

  const engine = new SimulationEngine({
    seed,
    grid,
    profile: { sensorNoise: 0.05 },
  });

  const count = Math.min(robotCount, Math.floor(traversable.length / 3));
  const priorities: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

  for (let i = 0; i < count; i++) {
    const spawn = traversable[i]!;
    const pickup = traversable[count + i]!;
    const drop = traversable[2 * count + i]!;
    cells[pickup.y]![pickup.x] = 'pickup';
    cells[drop.y]![drop.x] = 'drop';

    const rId = `R-${String(i).padStart(2, '0')}`;
    const pkgId = `PKG-${i}`;
    const podId = `POD-${i}`;
    const jobId = `JOB-${i}`;
    const prio = priorities[rng.nextInt(0, priorities.length)]!;

    engine.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: rId, cell: spawn } });
    engine.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 0,
      pkg: { id: pkgId, weight: rng.nextInt(1, 10), priority: prio },
    });
    engine.dispatch({
      type: 'REGISTER_POD',
      tick: 0,
      pod: { id: podId, cell: pickup, packageIds: [pkgId] },
    });
    engine.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: {
        id: jobId,
        podId,
        packageIds: [pkgId],
        pickupCell: pickup,
        dropCell: drop,
        priority: prio,
      },
    });
  }

  return engine;
}
