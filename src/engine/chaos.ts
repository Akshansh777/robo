import { createPRNG } from './prng';
import { Coord, GridMap, SimCommand } from './types';

export interface ChaosGeneratorConfig {
  seed: number;
  intensity: number; // 0.0 .. 1.0
  durationTicks: number;
  robotIds: readonly string[];
  pickupCells: readonly Coord[];
  dropCells: readonly Coord[];
}

/**
 * Deterministic Seeded Chaos Generator:
 * Emits reproducible robot failures/recoveries, aisle blocks/unblocks,
 * deadzone toggles, and burst jobs as normal timestamped SimCommands.
 */
export function generateChaosCommands(
  grid: GridMap,
  config: ChaosGeneratorConfig
): SimCommand[] {
  const rng = createPRNG(config.seed);
  const intensity = Math.max(0, Math.min(1, config.intensity));
  const commands: SimCommand[] = [];

  if (intensity <= 0 || config.durationTicks <= 0) return commands;

  // Collect candidate interior aisle cells (avoiding pickups/drops/walls/shelves)
  const aisleCells: Coord[] = [];
  for (let y = 1; y < grid.height - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      if (grid.cells[y]![x] === 'floor') {
        aisleCells.push({ x, y });
      }
    }
  }

  const eventBudget = Math.max(1, Math.round(intensity * (config.durationTicks / 6)));
  let burstCounter = 0;

  for (let i = 0; i < eventBudget; i++) {
    const tick = rng.nextInt(2, Math.max(3, config.durationTicks - 6));
    const kindRoll = rng.next();

    if (kindRoll < 0.3 && config.robotIds.length > 0) {
      // Robot failure + scheduled recovery
      const victim = config.robotIds[rng.nextInt(0, config.robotIds.length)]!;
      const recoveryTick = Math.min(config.durationTicks - 1, tick + rng.nextInt(5, 12));
      commands.push({ type: 'FAIL_ROBOT', tick, robotId: victim });
      commands.push({ type: 'RECOVER_ROBOT', tick: recoveryTick, robotId: victim });
    } else if (kindRoll < 0.65 && aisleCells.length > 0) {
      // Live aisle block + unblock
      const cell = aisleCells[rng.nextInt(0, aisleCells.length)]!;
      const unblockTick = Math.min(config.durationTicks - 1, tick + rng.nextInt(6, 14));
      commands.push({ type: 'BLOCK_CELL', tick, cell: { ...cell } });
      commands.push({ type: 'UNBLOCK_CELL', tick: unblockTick, cell: { ...cell } });
    } else if (kindRoll < 0.85 && aisleCells.length > 0) {
      // Deadzone uncertainty toggle
      const cell = aisleCells[rng.nextInt(0, aisleCells.length)]!;
      const restoreTick = Math.min(config.durationTicks - 1, tick + rng.nextInt(8, 16));
      commands.push({ type: 'PAINT_CELL', tick, cell: { ...cell }, cellType: 'deadzone' });
      commands.push({ type: 'PAINT_CELL', tick: restoreTick, cell: { ...cell }, cellType: 'floor' });
    } else if (config.pickupCells.length > 0 && config.dropCells.length > 0) {
      // Burst job injection
      burstCounter++;
      const pCell = config.pickupCells[rng.nextInt(0, config.pickupCells.length)]!;
      const dCell = config.dropCells[rng.nextInt(0, config.dropCells.length)]!;
      const pkgId = `CHAOS-PKG-${config.seed}-${burstCounter}`;
      const podId = `CHAOS-POD-${config.seed}-${burstCounter}`;
      const jobId = `CHAOS-JOB-${config.seed}-${burstCounter}`;
      const prio = rng.next() < 0.35 ? 'URGENT' : 'HIGH';

      commands.push({
        type: 'REGISTER_PACKAGE',
        tick,
        pkg: { id: pkgId, weight: rng.nextInt(1, 7), priority: prio },
      });
      commands.push({
        type: 'REGISTER_POD',
        tick,
        pod: { id: podId, cell: { ...pCell }, packageIds: [pkgId] },
      });
      commands.push({
        type: 'ADD_JOB',
        tick,
        job: {
          id: jobId,
          podId,
          packageIds: [pkgId],
          pickupCell: { ...pCell },
          dropCell: { ...dCell },
          priority: prio,
        },
      });
    }
  }

  return commands.sort((a, b) => a.tick - b.tick);
}
