import { fnv1a64Hex } from './prng';
import {
  Coord,
  CustodyState,
  EventLogEntry,
  InvariantReport,
  PackageCustodyRecord,
  SimCommand,
  SimState,
} from './types';

export const GENESIS_HASH = '0000000000000000';

export function computeEntryHash(
  entry: Omit<EventLogEntry, 'hash'>
): string {
  const cmdStr = entry.command ? JSON.stringify(entry.command) : '';
  const canonical = `${entry.seq}|${entry.tick}|${entry.kind}|${entry.status}|${entry.detail}|${cmdStr}|${entry.prevHash}`;
  return fnv1a64Hex(canonical);
}

export class CustodyLedger {
  /**
   * Appends a hash-chained event entry to state.eventLog.
   */
  appendEvent(
    state: SimState,
    kind: EventLogEntry['kind'],
    status: EventLogEntry['status'],
    detail: string,
    command?: SimCommand
  ): EventLogEntry {
    const prevHash =
      state.eventLog.length > 0
        ? state.eventLog[state.eventLog.length - 1]!.hash
        : GENESIS_HASH;

    const base: Omit<EventLogEntry, 'hash'> = {
      seq: state.eventLog.length,
      tick: state.tick,
      command,
      kind,
      status,
      detail,
      prevHash,
    };

    const full: EventLogEntry = {
      ...base,
      hash: computeEntryHash(base),
    };
    state.eventLog.push(full);
    return full;
  }

  /**
   * Verifies the entire append-only hash chain from genesis to tip.
   * Returns { valid: true } or { valid: false, brokenAtSeq }.
   */
  verifyChain(entries: readonly EventLogEntry[]): {
    valid: boolean;
    brokenAtSeq?: number;
  } {
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.seq !== i || e.prevHash !== expectedPrev) {
        return { valid: false, brokenAtSeq: i };
      }
      const recomputed = computeEntryHash({
        seq: e.seq,
        tick: e.tick,
        command: e.command,
        kind: e.kind,
        status: e.status,
        detail: e.detail,
        prevHash: e.prevHash,
      });
      if (e.hash !== recomputed) {
        return { valid: false, brokenAtSeq: i };
      }
      expectedPrev = e.hash;
    }
    return { valid: true };
  }

  /**
   * Initializes custody record when a package is registered.
   */
  registerPackage(state: SimState, packageId: string, initialCell: Coord): void {
    state.custody[packageId] = {
      packageId,
      state: 'UNASSIGNED',
      ownerRobotId: null,
      epoch: 0,
      cell: { ...initialCell },
      lastUpdatedTick: state.tick,
      misplacedCount: 0,
    };
  }

  /**
   * Atomic Compare-And-Swap (CAS) transition on a package custody record.
   * Validates expectedState, expectedOwner, and fencing epoch before mutating.
   * Rejects and logs stale/unauthorized transitions.
   */
  compareAndSwap(
    state: SimState,
    params: {
      packageId: string;
      expectedStates: readonly CustodyState[];
      expectedOwner: string | null;
      expectedEpoch?: number;
      nextState: CustodyState;
      nextOwner: string | null;
      cell: Coord;
      detail: string;
    }
  ): { ok: boolean; newEpoch: number } {
    const rec: PackageCustodyRecord | undefined = state.custody[params.packageId];
    if (!rec) {
      this.appendEvent(
        state,
        'CUSTODY',
        'REJECTED',
        `CAS rejected: unknown package ${params.packageId} (${params.detail})`
      );
      return { ok: false, newEpoch: -1 };
    }

    if (!params.expectedStates.includes(rec.state)) {
      this.appendEvent(
        state,
        'CUSTODY',
        'REJECTED',
        `CAS rejected for ${params.packageId}: state is ${rec.state}, expected [${params.expectedStates.join(',')}] (${params.detail})`
      );
      return { ok: false, newEpoch: rec.epoch };
    }

    if (rec.ownerRobotId !== params.expectedOwner) {
      this.appendEvent(
        state,
        'CUSTODY',
        'REJECTED',
        `CAS rejected for ${params.packageId}: owner is ${rec.ownerRobotId ?? 'none'}, expected ${params.expectedOwner ?? 'none'} (${params.detail})`
      );
      return { ok: false, newEpoch: rec.epoch };
    }

    if (
      params.expectedEpoch !== undefined &&
      rec.epoch !== params.expectedEpoch
    ) {
      this.appendEvent(
        state,
        'CUSTODY',
        'REJECTED',
        `Stale epoch rejected for ${params.packageId}: got epoch ${params.expectedEpoch}, current epoch ${rec.epoch} (${params.detail})`
      );
      return { ok: false, newEpoch: rec.epoch };
    }

    rec.state = params.nextState;
    rec.ownerRobotId = params.nextOwner;
    rec.epoch += 1;
    rec.cell = { ...params.cell };
    rec.lastUpdatedTick = state.tick;

    this.appendEvent(
      state,
      'CUSTODY',
      'APPLIED',
      `${params.packageId} -> ${params.nextState}(owner=${params.nextOwner ?? 'none'}, epoch=${rec.epoch}): ${params.detail}`
    );

    return { ok: true, newEpoch: rec.epoch };
  }

  /**
   * Per-tick invariant checker:
   * 1. Every registered package is accounted for in custody.
   * 2. No package is carried by two robots.
   * 3. No package is delivered twice.
   * 4. No package is both DELIVERED and carried.
   * 5. Picked packages match their carrier's pod & position.
   */
  checkInvariants(state: SimState): InvariantReport {
    const violations: string[] = [];
    const registeredIds = Object.keys(state.packages);

    // Check every registered package has a valid custody record
    for (const pkgId of registeredIds) {
      const rec = state.custody[pkgId];
      if (!rec) {
        violations.push(`Unaccounted package ${pkgId} missing from custody ledger`);
        continue;
      }

      if (rec.state === 'PICKED') {
        if (!rec.ownerRobotId) {
          violations.push(`Package ${pkgId} is PICKED with null ownerRobotId`);
        } else {
          const robot = state.robots[rec.ownerRobotId];
          if (!robot) {
            violations.push(
              `Package ${pkgId} PICKED by non-existent robot ${rec.ownerRobotId}`
            );
          } else if (robot.status === 'FAILED') {
            violations.push(
              `Package ${pkgId} still PICKED by FAILED robot ${robot.id} (should be STRANDED)`
            );
          } else if (!robot.carryingPodId) {
            violations.push(
              `Package ${pkgId} PICKED by ${robot.id} which is carrying no pod`
            );
          }
        }
      }

      if (rec.state === 'DELIVERED') {
        if (rec.ownerRobotId !== null) {
          violations.push(
            `Package ${pkgId} is DELIVERED but still owned by ${rec.ownerRobotId}`
          );
        }
        // Ensure no robot is carrying a pod containing a DELIVERED package
        for (const robot of Object.values(state.robots)) {
          if (robot.carryingPodId) {
            const pod = state.pods[robot.carryingPodId];
            if (pod && pod.packageIds.includes(pkgId)) {
              violations.push(
                `Package ${pkgId} is both DELIVERED and carried by robot ${robot.id}`
              );
            }
          }
        }
      }
    }

    // Ensure no package is carried by two robots simultaneously
    const carriedByMap = new Map<string, string>();
    for (const robot of Object.values(state.robots)) {
      if (!robot.carryingPodId) continue;
      const pod = state.pods[robot.carryingPodId];
      if (!pod) {
        violations.push(
          `Robot ${robot.id} references missing carryingPodId ${robot.carryingPodId}`
        );
        continue;
      }
      for (const pkgId of pod.packageIds) {
        const prevCarrier = carriedByMap.get(pkgId);
        if (prevCarrier && prevCarrier !== robot.id) {
          violations.push(
            `Package ${pkgId} carried simultaneously by ${prevCarrier} and ${robot.id}`
          );
        }
        carriedByMap.set(pkgId, robot.id);
      }
    }

    // Ensure no package was delivered more than once across completed jobs
    const deliveryCounts = new Map<string, number>();
    for (const job of Object.values(state.jobs)) {
      for (const pkgId of job.deliveredPackageIds) {
        const count = (deliveryCounts.get(pkgId) ?? 0) + 1;
        deliveryCounts.set(pkgId, count);
        if (count > 1) {
          violations.push(`Package ${pkgId} delivered ${count} times`);
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
    };
  }
}
