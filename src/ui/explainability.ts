import { getEffectivePriorityRank, SimState } from '../engine';

/**
 * Generates a plain-language operational explanation for why a selected robot
 * is moving, waiting, charging, stopped for safety, or recovering.
 */
export function explainRobotPlainLanguage(state: SimState, robotId: string): string {
  const robot = state.robots[robotId];
  if (!robot) return 'Robot not found in active state.';

  if (robot.status === 'FAILED') {
    return `${robot.id} is offline (FAILED) at (${robot.cell.x}, ${robot.cell.y}) and acts as a physical aisle obstacle until recovered.`;
  }

  if (robot.safetyStopReason) {
    return `${robot.id} is holding position due to a simulated safety stop: ${robot.safetyStopReason}.`;
  }

  if (robot.inDeadzone) {
    return `${robot.id} is inside an RF deadzone at (${robot.cell.x}, ${robot.cell.y}), executing its buffered trajectory with a 2-cell safety halo.`;
  }

  const job = robot.assignedJobId ? state.jobs[robot.assignedJobId] : undefined;

  // Check if waiting for another robot reserving its next cell
  const nextStep = robot.plan[0];
  if (nextStep && nextStep.x === robot.cell.x && nextStep.y === robot.cell.y) {
    // Find neighbor blocking surrounding aisle
    const neighbor = Object.values(state.robots).find(
      (other) =>
        other.id !== robot.id &&
        Math.abs(other.cell.x - robot.cell.x) + Math.abs(other.cell.y - robot.cell.y) <= 2
    );
    if (neighbor) {
      const untilTick =
        neighbor.plan.length > 0
          ? neighbor.plan[neighbor.plan.length - 1]!.t
          : state.tick + 1;
      return `Waiting at (${robot.cell.x}, ${robot.cell.y}) for ${neighbor.id}, which holds the shared corridor until tick ${untilTick}.`;
    }
    return `Waiting at (${robot.cell.x}, ${robot.cell.y}) for space-time reservation clearance (${robot.stallTicks} ticks stalled).`;
  }

  if (robot.routingToCharger || robot.status === 'CHARGING') {
    return `${robot.id} is ${robot.status === 'CHARGING' ? 'recharging' : 'routing to a charger'} (${robot.battery.toFixed(1)}% battery, safety reserve ${state.profile.batterySafetyReserve}%).`;
  }

  if (job) {
    const effPrio = getEffectivePriorityRank(job, state.tick, state.policy);
    const age = state.tick - job.createdTick;
    if (job.status === 'ASSIGNED') {
      return `En route to pickup pod ${job.podId} at (${job.pickupCell.x}, ${job.pickupCell.y}) for ${job.id} (priority ${job.priority}, effective tier ${effPrio}, age ${age}t).`;
    }
    if (job.status === 'PICKED_UP') {
      return `Carrying pod ${job.podId} [${job.packageIds.join(', ')}] to drop station (${job.dropCell.x}, ${job.dropCell.y}) for ${job.id} (${robot.plan.length} steps remaining).`;
    }
  }

  return `${robot.id} is idle at (${robot.cell.x}, ${robot.cell.y}) with ${robot.battery.toFixed(1)}% battery, ready for Contract Net bids.`;
}
