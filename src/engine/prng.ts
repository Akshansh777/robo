import { SimState } from './types';

export interface PRNG {
  next(): number;
  nextInt(minInclusive: number, maxExclusive: number): number;
  getState(): number;
}

export function createPRNG(initialState: number): PRNG {
  let state = initialState >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const nextInt = (minInclusive: number, maxExclusive: number): number => {
    const span = maxExclusive - minInclusive;
    if (span <= 0) return minInclusive;
    return minInclusive + Math.floor(next() * span);
  };

  const getState = (): number => state >>> 0;

  return { next, nextInt, getState };
}

export function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c >>> 8) ^ (c & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Deterministic canonical state hash.
 * Note: Wall-clock diagnostic fields (lastTickWallClockMs) are intentionally excluded
 * so identical seeds, profiles, and command logs produce byte-identical hashes across runs.
 */
export function computeStateHash(state: SimState): string {
  const parts: string[] = [
    String(state.seed),
    String(state.prngState),
    String(state.tick),
    String(state.gridRevision),
    String(state.planningCursor),
    `${state.grid.width}x${state.grid.height}`,
  ];

  for (let y = 0; y < state.grid.height; y++) {
    parts.push(state.grid.cells[y]!.join(','));
  }
  parts.push(`BLK:${state.blockedCells.join(';')}`);

  const p = state.profile;
  parts.push(
    `PROF:${p.name}|${p.groundFriction}|${p.baseSpeed}|${p.acceleration}|${p.deceleration}|${p.payloadSpeedFactor}|${p.payloadDrainFactor}|${p.sensorRange}|${p.sensorNoise}|${p.baseBatteryDrain}|${p.idleBatteryDrain}|${p.chargeRate}|${p.agingIntervalTicks}|${p.batterySafetyReserve}|${p.humanBufferRadius}|${p.humanStaleTimeoutTicks}`
  );

  parts.push(`CAL:${state.calibrationObservations.length}`);

  const pol = state.policy;
  parts.push(
    `POL:${pol.planningHorizon}|${pol.maxExpansions}|${pol.globalExpansionBudgetPerTick}|${pol.enableAging}|${pol.agingIntervalTicks}|${pol.stallEscalationTicks}|${pol.conflictMode}|${pol.enableDeadlockPrediction}|${pol.deadlockLookaheadTicks}|${pol.enableDynamicEdgePricing}|${pol.congestionWindowTicks}|${pol.congestionWeight}|${pol.bidding.alpha},${pol.bidding.beta},${pol.bidding.gamma}`
  );

  for (const id of Object.keys(state.custody).sort()) {
    const c = state.custody[id]!;
    parts.push(
      `CUST:${c.packageId}:${c.state}:${c.ownerRobotId ?? ''}:${c.epoch}:${c.cell.x},${c.cell.y}:${c.misplacedCount}`
    );
  }

  for (const id of Object.keys(state.pods).sort()) {
    const pod = state.pods[id]!;
    parts.push(
      `POD:${pod.id}:${pod.cell.x},${pod.cell.y}:${pod.carriedByRobotId ?? ''}:${pod.packageIds.join(',')}`
    );
  }

  for (const id of Object.keys(state.jobs).sort()) {
    const j = state.jobs[id]!;
    parts.push(
      `JOB:${j.id}:${j.kind}:${j.status}:${j.epoch}:${j.assignedRobotId ?? ''}:${j.reassignmentCount}`
    );
  }

  for (const id of Object.keys(state.robots).sort()) {
    const r = state.robots[id]!;
    parts.push(
      `BOT:${r.id}:${r.cell.x},${r.cell.y}:${r.status}:${r.battery.toFixed(4)}:${r.carryingPodId ?? ''}:${r.assignedJobId ?? ''}:${r.assignedEpoch}:${r.stallTicks}:${r.escalatedPriorityBonus}:${r.inDeadzone ? 1 : 0}`
    );
  }

  for (const id of Object.keys(state.humans).sort()) {
    const h = state.humans[id]!;
    parts.push(`HUM:${h.id}:${h.cell.x},${h.cell.y}:${h.lastUpdateTick}`);
  }

  const tipHash =
    state.eventLog.length > 0
      ? state.eventLog[state.eventLog.length - 1]!.hash
      : '0000000000000000';
  parts.push(`LEDGER:${state.eventLog.length}:${tipHash}`);
  parts.push(`DECISIONS:${state.decisionSeqCounter}`);

  return fnv1a64Hex(parts.join('|'));
}
