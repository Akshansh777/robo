import { SimulationEngine } from './engine';
import {
  GridMap,
  SchedulerPolicy,
  SimCommand,
  SimulationProfile,
} from './types';

export interface KPISeriesPoint {
  tick: number;
  jobsCompleted: number;
  throughputPer100Ticks: number;
  avgPickupDelay: number;
  p95PickupDelay: number;
  congestionIndex: number;
  predictedDeadlocksResolved: number;
  reactiveDeadlocksResolved: number;
  expansionsThisTick: number;
  deferredRequests: number;
}

export interface ABRunSummary {
  policyLabel: string;
  finalStateHash: string;
  jobsCompleted: number;
  throughputPer100Ticks: number;
  avgWaitTime: number;
  p95WaitTime: number;
  avgPickupDelayAll: number;
  p95PickupDelayAll: number;
  congestionIndex: number;
  predictedDeadlocksResolved: number;
  reactiveDeadlocksResolved: number;
  totalPlannerExpansions: number;
  invariantOk: boolean;
}

export interface ABComparisonResult {
  seed: number;
  ticks: number;
  seriesA: KPISeriesPoint[];
  seriesB: KPISeriesPoint[];
  summaryA: ABRunSummary;
  summaryB: ABRunSummary;
}

/**
 * Runs two SimulationEngine instances on the identical initial grid, seed, profile,
 * and command/chaos stream under two different policies, returning side-by-side KPI series.
 */
export function runABComparison(params: {
  seed: number;
  grid: GridMap;
  profile?: Partial<SimulationProfile>;
  commands: readonly SimCommand[];
  policyA: Partial<SchedulerPolicy>;
  policyB: Partial<SchedulerPolicy>;
  labelA?: string;
  labelB?: string;
  ticks: number;
}): ABComparisonResult {
  const {
    seed,
    grid,
    profile,
    commands,
    policyA,
    policyB,
    labelA = 'Policy A',
    labelB = 'Policy B',
    ticks,
  } = params;

  const simA = new SimulationEngine({ seed, grid, profile, policy: policyA });
  const simB = new SimulationEngine({ seed, grid, profile, policy: policyB });

  for (const cmd of commands) {
    simA.dispatch(structuredClone(cmd));
    simB.dispatch(structuredClone(cmd));
  }

  const seriesA: KPISeriesPoint[] = [];
  const seriesB: KPISeriesPoint[] = [];

  const samplePoint = (sim: SimulationEngine): KPISeriesPoint => {
    const s = sim.getState();
    const m = sim.getMetrics();
    const prios = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
    let totalCount = 0;
    let weightedAvg = 0;
    let maxP95 = 0;
    for (const p of prios) {
      const stat = m.pickupDelayByPriority[p];
      totalCount += stat.count;
      weightedAvg += stat.avgPickupDelay * stat.count;
      if (stat.p95PickupDelay > maxP95) maxP95 = stat.p95PickupDelay;
    }
    return {
      tick: s.tick,
      jobsCompleted: m.jobsCompleted,
      throughputPer100Ticks: m.throughputPer100Ticks,
      avgPickupDelay: totalCount > 0 ? weightedAvg / totalCount : 0,
      p95PickupDelay: maxP95,
      congestionIndex: m.congestionIndex,
      predictedDeadlocksResolved: m.predictedDeadlocksResolved,
      reactiveDeadlocksResolved: m.reactiveDeadlocksResolved,
      expansionsThisTick: s.plannerStats.expansionsThisTick,
      deferredRequests: s.plannerStats.deferredRequests,
    };
  };

  for (let t = 0; t < ticks; t++) {
    simA.step();
    simB.step();
    seriesA.push(samplePoint(simA));
    seriesB.push(samplePoint(simB));
  }

  const buildSummary = (sim: SimulationEngine, label: string): ABRunSummary => {
    const last = samplePoint(sim);
    const m = sim.getMetrics();
    return {
      policyLabel: label,
      finalStateHash: sim.stateHash(),
      jobsCompleted: m.jobsCompleted,
      throughputPer100Ticks: m.throughputPer100Ticks,
      avgWaitTime: m.avgWaitTime,
      p95WaitTime: m.p95WaitTime,
      avgPickupDelayAll: last.avgPickupDelay,
      p95PickupDelayAll: last.p95PickupDelay,
      congestionIndex: m.congestionIndex,
      predictedDeadlocksResolved: m.predictedDeadlocksResolved,
      reactiveDeadlocksResolved: m.reactiveDeadlocksResolved,
      totalPlannerExpansions: sim.getState().plannerStats.totalExpansions,
      invariantOk: sim.checkInvariants().ok,
    };
  };

  return {
    seed,
    ticks,
    seriesA,
    seriesB,
    summaryA: buildSummary(simA, labelA),
    summaryB: buildSummary(simB, labelB),
  };
}
