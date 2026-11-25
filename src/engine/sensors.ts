import { coordKey, isCellTraversable } from './planner';
import { PRNG } from './prng';
import {
  Coord,
  GridMap,
  HumanEntity,
  Robot,
  SimulationProfile,
} from './types';

export interface ProximityReading {
  unsafe: boolean;
  reason: string | null;
  noisyCaution: boolean;
  detectedRobotIds: string[];
  detectedHumanIds: string[];
}

/**
 * Evaluates simulated proximity sensors AND simulated human safety buffers/staleness.
 */
export function scanProximityAndHumans(
  robot: Robot,
  proposedNext: Coord,
  allRobots: readonly Robot[],
  humans: readonly HumanEntity[],
  currentTick: number,
  grid: GridMap,
  blockedSet: ReadonlySet<string>,
  profile: SimulationProfile,
  prng: PRNG
): ProximityReading {
  const currentCell = grid.cells[robot.cell.y]?.[robot.cell.x];
  const effectiveRange = currentCell === 'deadzone' ? 1 : profile.sensorRange;

  const detectedRobotIds: string[] = [];
  const detectedHumanIds: string[] = [];

  for (const other of allRobots) {
    if (other.id === robot.id) continue;
    const dist =
      Math.abs(other.cell.x - robot.cell.x) + Math.abs(other.cell.y - robot.cell.y);
    if (dist <= effectiveRange) {
      detectedRobotIds.push(other.id);
    }
  }

  // Simulated Human Safety Buffer & Stale Telemetry Check
  for (const h of humans) {
    const distFromRobot =
      Math.abs(h.cell.x - robot.cell.x) + Math.abs(h.cell.y - robot.cell.y);
    const distFromNext =
      Math.abs(h.cell.x - proposedNext.x) + Math.abs(h.cell.y - proposedNext.y);
    const isStale = currentTick - h.lastUpdateTick > profile.humanStaleTimeoutTicks;

    if (distFromRobot <= effectiveRange + profile.humanBufferRadius) {
      detectedHumanIds.push(h.id);
    }

    // Stale human telemetry within extended caution zone -> conservative safety stop
    if (isStale && distFromRobot <= profile.humanBufferRadius + 2) {
      return {
        unsafe: true,
        reason: `Stale telemetry for human ${h.id} (age ${currentTick - h.lastUpdateTick} > ${profile.humanStaleTimeoutTicks})`,
        noisyCaution: false,
        detectedRobotIds,
        detectedHumanIds,
      };
    }

    // Proposed step enters human protective buffer
    if (distFromNext <= profile.humanBufferRadius) {
      return {
        unsafe: true,
        reason: `Proposed move (${proposedNext.x},${proposedNext.y}) enters protective buffer (r=${profile.humanBufferRadius}) of human ${h.id}`,
        noisyCaution: false,
        detectedRobotIds,
        detectedHumanIds,
      };
    }
  }

  const noisyCaution = profile.sensorNoise > 0 && prng.next() < profile.sensorNoise;
  if (noisyCaution) {
    return {
      unsafe: true,
      reason: 'Proximity sensor noise caution triggered',
      noisyCaution: true,
      detectedRobotIds,
      detectedHumanIds,
    };
  }

  if (!isCellTraversable(grid, blockedSet, proposedNext.x, proposedNext.y)) {
    return {
      unsafe: true,
      reason: `Target cell (${proposedNext.x},${proposedNext.y}) blocked or out of bounds`,
      noisyCaution: false,
      detectedRobotIds,
      detectedHumanIds,
    };
  }

  const targetHasStationaryRobot = allRobots.some(
    (other) =>
      other.id !== robot.id &&
      other.cell.x === proposedNext.x &&
      other.cell.y === proposedNext.y &&
      (other.status === 'FAILED' || other.plan.length === 0)
  );

  if (targetHasStationaryRobot) {
    return {
      unsafe: true,
      reason: `Target cell (${proposedNext.x},${proposedNext.y}) occupied by stationary/failed robot`,
      noisyCaution: false,
      detectedRobotIds,
      detectedHumanIds,
    };
  }

  return {
    unsafe: false,
    reason: null,
    noisyCaution: false,
    detectedRobotIds,
    detectedHumanIds,
  };
}

/**
 * Returns the set of all grid coordinate keys ("x,y") currently inside any human's protective buffer.
 */
export function buildHumanBufferSet(
  humans: readonly HumanEntity[],
  grid: GridMap,
  bufferRadius: number
): Set<string> {
  const blocked = new Set<string>();
  for (const h of humans) {
    for (let dy = -bufferRadius; dy <= bufferRadius; dy++) {
      for (let dx = -bufferRadius; dx <= bufferRadius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > bufferRadius) continue;
        const x = h.cell.x + dx;
        const y = h.cell.y + dy;
        if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
          blocked.add(coordKey(x, y));
        }
      }
    }
  }
  return blocked;
}
