import { CustodyLedger } from './ledger';
import { MetricsTracker } from './metrics';
import { coordKey, shortestPathDistance } from './planner';
import {
  Coord,
  DecisionRecord,
  Job,
  PRIORITY_RANK,
  Robot,
  SchedulerPolicy,
  SimState,
} from './types';

export function getEffectivePriorityRank(
  job: Job,
  currentTick: number,
  policy: SchedulerPolicy
): number {
  const base = PRIORITY_RANK[job.priority];
  if (!policy.enableAging || policy.agingIntervalTicks <= 0) {
    return base;
  }
  const age = Math.max(0, currentTick - job.createdTick);
  const promotion = Math.floor(age / policy.agingIntervalTicks);
  return Math.min(3, base + promotion);
}

export function compareJobsDeterministic(
  a: Job,
  b: Job,
  currentTick: number,
  policy: SchedulerPolicy
): number {
  const prioA = getEffectivePriorityRank(a, currentTick, policy);
  const prioB = getEffectivePriorityRank(b, currentTick, policy);
  if (prioA !== prioB) return prioB - prioA;

  const ageA = currentTick - a.createdTick;
  const ageB = currentTick - b.createdTick;
  if (ageA !== ageB) return ageB - ageA;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function findNearestChargerCell(
  state: SimState,
  from: Coord,
  blockedSet: ReadonlySet<string>
): { cell: Coord; distance: number } | null {
  let bestCell: Coord | null = null;
  let bestDist = Infinity;

  for (let y = 0; y < state.grid.height; y++) {
    for (let x = 0; x < state.grid.width; x++) {
      if (state.grid.cells[y]![x] === 'charger') {
        const d = shortestPathDistance(state.grid, blockedSet, from, { x, y });
        if (d !== null && d < bestDist) {
          bestDist = d;
          bestCell = { x, y };
        }
      }
    }
  }

  return bestCell ? { cell: bestCell, distance: bestDist } : null;
}

export function estimateJobEnergyAndDelay(
  state: SimState,
  robot: Robot,
  job: Job,
  blockedSet: ReadonlySet<string>,
  pickupTrafficCount: number
): {
  feasible: boolean;
  pickupDist: number;
  dropDist: number;
  chargerDist: number;
  totalRequiredBattery: number;
  congestionScore: number;
  estimatedPickupDelay: number;
} {
  const pickupDist = shortestPathDistance(
    state.grid,
    blockedSet,
    robot.cell,
    job.pickupCell
  );
  const dropDist = shortestPathDistance(
    state.grid,
    blockedSet,
    job.pickupCell,
    job.dropCell
  );

  if (pickupDist === null || dropDist === null) {
    return {
      feasible: false,
      pickupDist: Infinity,
      dropDist: Infinity,
      chargerDist: Infinity,
      totalRequiredBattery: Infinity,
      congestionScore: 0,
      estimatedPickupDelay: Infinity,
    };
  }

  const nearestCharger = findNearestChargerCell(state, job.dropCell, blockedSet);
  const chargerDist = nearestCharger ? nearestCharger.distance : 0;

  let mass = 0;
  for (const pid of job.packageIds) {
    mass += state.packages[pid]?.weight ?? 0;
  }

  const frictionPenalty = 1 + (1 - state.profile.groundFriction) * 0.5;
  let corridorRobots = 0;
  const minX = Math.min(robot.cell.x, job.pickupCell.x, job.dropCell.x);
  const maxX = Math.max(robot.cell.x, job.pickupCell.x, job.dropCell.x);
  const minY = Math.min(robot.cell.y, job.pickupCell.y, job.dropCell.y);
  const maxY = Math.max(robot.cell.y, job.pickupCell.y, job.dropCell.y);

  for (const other of Object.values(state.robots)) {
    if (other.id === robot.id) continue;
    if (
      other.cell.x >= minX &&
      other.cell.x <= maxX &&
      other.cell.y >= minY &&
      other.cell.y <= maxY
    ) {
      corridorRobots++;
    }
  }

  // Include rolling occupancy density near pickup/corridor when dynamic edge pricing is active
  let rollingDensity = 0;
  if (state.policy.enableDynamicEdgePricing) {
    const pHist = state.rollingCellOccupancy[coordKey(job.pickupCell.x, job.pickupCell.y)];
    if (pHist) {
      rollingDensity += pHist.length / Math.max(1, state.policy.congestionWindowTicks);
    }
  }

  // Stagger penalty when another robot is already converging on the same constrained pickup
  const congestionScore = corridorRobots + pickupTrafficCount * 2.5 + rollingDensity * 3.0;
  const estimatedPickupDelay =
    pickupDist * frictionPenalty + pickupTrafficCount * 3;

  const congestionFactor = 1 + corridorRobots * 0.05;
  const baseDrain = state.profile.baseBatteryDrain;
  const loadedDrain = baseDrain + mass * state.profile.payloadDrainFactor;

  const ePickup = pickupDist * baseDrain * frictionPenalty * congestionFactor;
  const eDrop = dropDist * loadedDrain * frictionPenalty * congestionFactor;
  const eCharger = chargerDist * baseDrain * frictionPenalty;
  const totalRequiredBattery =
    ePickup + eDrop + eCharger + state.profile.batterySafetyReserve;

  return {
    feasible: true,
    pickupDist,
    dropDist,
    chargerDist,
    totalRequiredBattery,
    congestionScore,
    estimatedPickupDelay,
  };
}

export type DecisionRecorderFn = (
  rec: Omit<DecisionRecord, 'seq' | 'tick'>
) => void;

/**
 * Contract Net Protocol (CNP) task allocator factoring in predicted pickup delay,
 * aisle congestion, battery safety reserves, and explainable decision recording.
 */
export function allocateJobsCNP(
  state: SimState,
  ledger: CustodyLedger,
  metrics: MetricsTracker,
  blockedSet: ReadonlySet<string>,
  recordDecision: DecisionRecorderFn
): void {
  // Count active robots already heading toward each pickup cell to prevent pickup herding
  const activePickupLoad = new Map<string, number>();
  for (const j of Object.values(state.jobs)) {
    if (j.status === 'ASSIGNED') {
      const k = coordKey(j.pickupCell.x, j.pickupCell.y);
      activePickupLoad.set(k, (activePickupLoad.get(k) ?? 0) + 1);
    }
  }

  // 1. Check active robots for low-battery release/re-bid before pickup, or charger routing
  for (const robot of Object.values(state.robots).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )) {
    if (robot.status === 'FAILED') continue;

    if (robot.assignedJobId) {
      const job = state.jobs[robot.assignedJobId];
      if (!job) {
        robot.assignedJobId = null;
        robot.status = 'IDLE';
        continue;
      }

      if (job.status === 'ASSIGNED' && !robot.carryingPodId) {
        const est = estimateJobEnergyAndDelay(state, robot, job, blockedSet, 0);
        if (!est.feasible || robot.battery < est.totalRequiredBattery) {
          releaseJobToPool(
            state,
            ledger,
            metrics,
            robot,
            job,
            `Low battery (${robot.battery.toFixed(1)}% < ${est.totalRequiredBattery.toFixed(1)}% reserve) before pickup`
          );
          robot.routingToCharger = true;
          robot.needsReplan = true;
          recordDecision({
            category: 'BATTERY_CHARGING',
            robotId: robot.id,
            jobId: job.id,
            decision: 'RELEASE_JOB_AND_ROUTE_TO_CHARGER',
            inputs: {
              battery: Number(robot.battery.toFixed(2)),
              requiredReserve: Number(est.totalRequiredBattery.toFixed(2)),
            },
            alternativesRejected: ['CONTINUE_TO_PICKUP'],
            reason: `Battery ${robot.battery.toFixed(1)}% fell below required reserve ${est.totalRequiredBattery.toFixed(1)}% before pickup`,
          });
        }
      }
    } else if (robot.status === 'IDLE' && !robot.carryingPodId) {
      const charger = findNearestChargerCell(state, robot.cell, blockedSet);
      if (charger && robot.battery < state.profile.batterySafetyReserve + 15) {
        if (!robot.routingToCharger) {
          recordDecision({
            category: 'BATTERY_CHARGING',
            robotId: robot.id,
            decision: 'ROUTE_TO_CHARGER',
            inputs: {
              battery: Number(robot.battery.toFixed(2)),
              threshold: state.profile.batterySafetyReserve + 15,
            },
            alternativesRejected: ['REMAIN_IDLE'],
            reason: `Idle battery ${robot.battery.toFixed(1)}% below recharge threshold`,
          });
        }
        robot.routingToCharger = true;
      } else if (robot.battery >= 95) {
        robot.routingToCharger = false;
      }
    }
  }

  // 2. Auction PENDING jobs via Contract Net Protocol
  const pendingJobs = Object.values(state.jobs)
    .filter((j) => j.status === 'PENDING' && j.assignedRobotId === null)
    .sort((a, b) => compareJobsDeterministic(a, b, state.tick, state.policy));

  if (pendingJobs.length === 0) return;

  const candidateRobots = Object.values(state.robots)
    .filter(
      (r) =>
        r.status !== 'FAILED' &&
        r.assignedJobId === null &&
        r.carryingPodId === null
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const job of pendingJobs) {
    if (candidateRobots.length === 0) break;

    const pickupKey = coordKey(job.pickupCell.x, job.pickupCell.y);
    const pickupTraffic = activePickupLoad.get(pickupKey) ?? 0;

    // Stagger low/normal priority dispatches to an already saturated pickup cell when higher-priority work exists
    const effPrio = getEffectivePriorityRank(job, state.tick, state.policy);
    if (pickupTraffic >= 2 && effPrio <= 1 && pendingJobs.length > 1) {
      recordDecision({
        category: 'CONGESTION_AVOIDANCE',
        jobId: job.id,
        decision: 'STAGGER_DISPATCH',
        inputs: { pickupTraffic, effectivePriority: effPrio },
        alternativesRejected: ['IMMEDIATE_DISPATCH'],
        reason: `Pickup (${job.pickupCell.x},${job.pickupCell.y}) already has ${pickupTraffic} converging robots; staggering dispatch`,
      });
      continue;
    }

    let bestIdx = -1;
    let bestCost = Infinity;
    const rejectedBids: string[] = [];

    const priorityBonus = effPrio * 4.0;
    const deadlinePenalty =
      job.deadlineTick !== undefined
        ? Math.max(0, 20 - (job.deadlineTick - state.tick)) * 0.5
        : 0;

    for (let i = 0; i < candidateRobots.length; i++) {
      const r = candidateRobots[i]!;
      const est = estimateJobEnergyAndDelay(
        state,
        r,
        job,
        blockedSet,
        pickupTraffic
      );

      if (!est.feasible) {
        rejectedBids.push(`${r.id}:unreachable`);
        continue;
      }

      if (r.battery < est.totalRequiredBattery) {
        const msg = `Bid rejected for robot ${r.id} on ${job.id}: battery ${r.battery.toFixed(1)}% < required ${est.totalRequiredBattery.toFixed(1)}%`;
        ledger.appendEvent(state, 'BATTERY', 'REJECTED', msg);
        rejectedBids.push(`${r.id}:low_battery(${r.battery.toFixed(1)}<${est.totalRequiredBattery.toFixed(1)})`);
        recordDecision({
          category: 'BATTERY_CHARGING',
          robotId: r.id,
          jobId: job.id,
          decision: 'BID_REJECTED_LOW_BATTERY',
          inputs: {
            battery: Number(r.battery.toFixed(2)),
            requiredReserve: Number(est.totalRequiredBattery.toFixed(2)),
          },
          alternativesRejected: ['ACCEPT_JOB'],
          reason: msg,
        });
        continue;
      }

      const eta = est.estimatedPickupDelay + est.dropDist;
      const batteryRisk =
        (est.totalRequiredBattery / Math.max(1, r.battery)) * 10;
      const cost =
        state.policy.bidding.alpha * eta +
        state.policy.bidding.beta * est.congestionScore +
        state.policy.bidding.gamma * batteryRisk -
        priorityBonus -
        deadlinePenalty;

      if (
        cost < bestCost - 1e-9 ||
        (Math.abs(cost - bestCost) <= 1e-9 &&
          bestIdx >= 0 &&
          r.id < candidateRobots[bestIdx]!.id)
      ) {
        if (bestIdx >= 0) {
          rejectedBids.push(`${candidateRobots[bestIdx]!.id}:higher_cost(${bestCost.toFixed(2)})`);
        }
        bestCost = cost;
        bestIdx = i;
      } else {
        rejectedBids.push(`${r.id}:higher_cost(${cost.toFixed(2)})`);
      }
    }

    if (bestIdx >= 0) {
      const winner = candidateRobots[bestIdx]!;
      candidateRobots.splice(bestIdx, 1);

      let allCasOk = true;
      let latestEpoch = job.epoch;

      for (const pkgId of job.packageIds) {
        const res = ledger.compareAndSwap(state, {
          packageId: pkgId,
          expectedStates: ['UNASSIGNED', 'STRANDED'],
          expectedOwner: null,
          nextState: 'ASSIGNED',
          nextOwner: winner.id,
          cell: job.pickupCell,
          detail: `Assigned ${job.id} (${job.kind}) to ${winner.id}`,
        });
        if (!res.ok) {
          allCasOk = false;
          break;
        }
        latestEpoch = res.newEpoch;
      }

      if (!allCasOk) continue;

      job.status = 'ASSIGNED';
      job.assignedRobotId = winner.id;
      job.epoch = latestEpoch;

      winner.assignedJobId = job.id;
      winner.assignedEpoch = latestEpoch;
      winner.routingToCharger = false;
      winner.status = 'MOVING';
      winner.needsReplan = true;

      activePickupLoad.set(pickupKey, pickupTraffic + 1);

      recordDecision({
        category: 'ASSIGNMENT',
        robotId: winner.id,
        jobId: job.id,
        packageId: job.packageIds[0],
        decision: `ASSIGN_${job.id}_TO_${winner.id}`,
        inputs: {
          bidCost: Number(bestCost.toFixed(2)),
          effectivePriority: effPrio,
          pickupTraffic,
          battery: Number(winner.battery.toFixed(2)),
        },
        alternativesRejected: rejectedBids.slice(0, 5),
        reason: `Won CNP auction with lowest cost ${bestCost.toFixed(2)} (prio=${effPrio}, pickupTraffic=${pickupTraffic})`,
      });
    }
  }
}

export function releaseJobToPool(
  state: SimState,
  ledger: CustodyLedger,
  metrics: MetricsTracker,
  robot: Robot,
  job: Job,
  reason: string
): void {
  for (const pkgId of job.packageIds) {
    const rec = state.custody[pkgId];
    if (rec && rec.state === 'ASSIGNED' && rec.ownerRobotId === robot.id) {
      ledger.compareAndSwap(state, {
        packageId: pkgId,
        expectedStates: ['ASSIGNED'],
        expectedOwner: robot.id,
        expectedEpoch: rec.epoch,
        nextState: 'UNASSIGNED',
        nextOwner: null,
        cell: job.pickupCell,
        detail: `Released ${job.id} back to pool: ${reason}`,
      });
    }
  }

  job.status = 'PENDING';
  job.assignedRobotId = null;
  job.reassignmentCount++;
  metrics.recordReassignment();

  robot.assignedJobId = null;
  robot.assignedEpoch = 0;
  robot.plan = [];
  if (robot.status !== 'FAILED') {
    robot.status = 'IDLE';
  }

  ledger.appendEvent(
    state,
    'REASSIGN',
    'APPLIED',
    `Job ${job.id} returned to pool from ${robot.id}: ${reason}`
  );
}
