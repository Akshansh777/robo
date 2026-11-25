import {
  MetricsSnapshot,
  Priority,
  PriorityDelayStats,
  SimState,
} from './types';

function computePercentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}

function computeAverage(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export interface MetricsInternalData {
  cellOccupancy: Record<string, number>;
  cellWaitCounts: Record<string, number>;
  failureCount: number;
  reassignmentCount: number;
  misplacedIncidents: number;
  safetyStops: number;
  predictedDeadlocksResolved: number;
  reactiveDeadlocksResolved: number;
}

export class MetricsTracker {
  private cellOccupancy: Record<string, number> = {};
  private cellWaitCounts: Record<string, number> = {};
  private failureCount = 0;
  private reassignmentCount = 0;
  private misplacedIncidents = 0;
  private safetyStops = 0;
  private predictedDeadlocksResolved = 0;
  private reactiveDeadlocksResolved = 0;

  exportData(): MetricsInternalData {
    return {
      cellOccupancy: { ...this.cellOccupancy },
      cellWaitCounts: { ...this.cellWaitCounts },
      failureCount: this.failureCount,
      reassignmentCount: this.reassignmentCount,
      misplacedIncidents: this.misplacedIncidents,
      safetyStops: this.safetyStops,
      predictedDeadlocksResolved: this.predictedDeadlocksResolved,
      reactiveDeadlocksResolved: this.reactiveDeadlocksResolved,
    };
  }

  importData(data: MetricsInternalData): void {
    this.cellOccupancy = { ...data.cellOccupancy };
    this.cellWaitCounts = { ...data.cellWaitCounts };
    this.failureCount = data.failureCount;
    this.reassignmentCount = data.reassignmentCount;
    this.misplacedIncidents = data.misplacedIncidents;
    this.safetyStops = data.safetyStops;
    this.predictedDeadlocksResolved = data.predictedDeadlocksResolved;
    this.reactiveDeadlocksResolved = data.reactiveDeadlocksResolved;
  }

  recordCellOccupancy(x: number, y: number, waited: boolean): void {
    const key = `${x},${y}`;
    this.cellOccupancy[key] = (this.cellOccupancy[key] ?? 0) + 1;
    if (waited) {
      this.cellWaitCounts[key] = (this.cellWaitCounts[key] ?? 0) + 1;
    }
  }

  recordFailure(): void {
    this.failureCount++;
  }

  recordReassignment(): void {
    this.reassignmentCount++;
  }

  recordMisplacedIncident(): void {
    this.misplacedIncidents++;
  }

  recordSafetyStop(): void {
    this.safetyStops++;
  }

  recordPredictedDeadlockResolved(): void {
    this.predictedDeadlocksResolved++;
  }

  recordReactiveDeadlockResolved(): void {
    this.reactiveDeadlocksResolved++;
  }

  getSnapshot(state: SimState): MetricsSnapshot {
    const jobs = Object.values(state.jobs);
    const completed = jobs.filter((j) => j.status === 'COMPLETED');

    const totalWaitTimes: number[] = [];
    const pickupDelaysByPrio: Record<Priority, number[]> = {
      LOW: [],
      NORMAL: [],
      HIGH: [],
      URGENT: [],
    };
    let lateJobs = 0;

    for (const j of jobs) {
      if (j.pickedUpAtTick !== null) {
        const pickupDelay = Math.max(0, j.pickedUpAtTick - j.createdTick);
        pickupDelaysByPrio[j.priority].push(pickupDelay);
      } else if (j.status === 'PENDING' || j.status === 'ASSIGNED') {
        const pendingDelay = Math.max(0, state.tick - j.createdTick);
        pickupDelaysByPrio[j.priority].push(pendingDelay);
      }

      if (j.status === 'COMPLETED' && j.completedAtTick !== null) {
        totalWaitTimes.push(Math.max(0, j.completedAtTick - j.createdTick));
        if (j.deadlineTick !== undefined && j.completedAtTick > j.deadlineTick) {
          lateJobs++;
        }
      } else if (
        j.deadlineTick !== undefined &&
        state.tick > j.deadlineTick &&
        j.status !== 'REJECTED'
      ) {
        lateJobs++;
      }
    }

    const pickupDelayByPriority: Record<Priority, PriorityDelayStats> = {
      LOW: {
        count: pickupDelaysByPrio.LOW.length,
        avgPickupDelay: computeAverage(pickupDelaysByPrio.LOW),
        p95PickupDelay: computePercentile95(pickupDelaysByPrio.LOW),
      },
      NORMAL: {
        count: pickupDelaysByPrio.NORMAL.length,
        avgPickupDelay: computeAverage(pickupDelaysByPrio.NORMAL),
        p95PickupDelay: computePercentile95(pickupDelaysByPrio.NORMAL),
      },
      HIGH: {
        count: pickupDelaysByPrio.HIGH.length,
        avgPickupDelay: computeAverage(pickupDelaysByPrio.HIGH),
        p95PickupDelay: computePercentile95(pickupDelaysByPrio.HIGH),
      },
      URGENT: {
        count: pickupDelaysByPrio.URGENT.length,
        avgPickupDelay: computeAverage(pickupDelaysByPrio.URGENT),
        p95PickupDelay: computePercentile95(pickupDelaysByPrio.URGENT),
      },
    };

    let totalOcc = 0;
    let totalWaits = 0;
    for (const v of Object.values(this.cellOccupancy)) totalOcc += v;
    for (const v of Object.values(this.cellWaitCounts)) totalWaits += v;
    const congestionIndex = totalOcc > 0 ? totalWaits / totalOcc : 0;

    const elapsed = Math.max(1, state.tick);
    return {
      tick: state.tick,
      jobsCompleted: completed.length,
      throughputPer100Ticks: (completed.length / elapsed) * 100,
      avgWaitTime: computeAverage(totalWaitTimes),
      p95WaitTime: computePercentile95(totalWaitTimes),
      pickupDelayByPriority,
      lateJobs,
      failureCount: this.failureCount,
      reassignmentCount: this.reassignmentCount,
      misplacedIncidents: this.misplacedIncidents,
      safetyStops: this.safetyStops,
      predictedDeadlocksResolved: this.predictedDeadlocksResolved,
      reactiveDeadlocksResolved: this.reactiveDeadlocksResolved,
      congestionIndex,
      cellOccupancy: { ...this.cellOccupancy },
      cellWaitCounts: { ...this.cellWaitCounts },
    };
  }
}
