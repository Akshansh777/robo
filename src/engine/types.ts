export type CellType =
  | 'floor'
  | 'wall'
  | 'shelf'
  | 'pickup'
  | 'drop'
  | 'bay'
  | 'charger'
  | 'slow'
  | 'deadzone';

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const PRIORITY_RANK: Record<Priority, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
};

export interface Coord {
  x: number;
  y: number;
}

export type Action = 'N' | 'S' | 'E' | 'W' | 'WAIT';

export interface PlanStep {
  x: number;
  y: number;
  t: number;
  action: Action;
}

export interface Package {
  readonly id: string;
  readonly weight: number;
  readonly priority: Priority;
  readonly label?: string;
}

export type CustodyState =
  | 'UNASSIGNED'
  | 'ASSIGNED'
  | 'PICKED'
  | 'STRANDED'
  | 'DELIVERED';

export interface PackageCustodyRecord {
  readonly packageId: string;
  state: CustodyState;
  ownerRobotId: string | null;
  epoch: number;
  cell: Coord;
  lastUpdatedTick: number;
  misplacedCount: number;
}

export interface InvariantReport {
  ok: boolean;
  violations: string[];
}

export interface Pod {
  readonly id: string;
  cell: Coord;
  readonly packageIds: readonly string[];
  carriedByRobotId: string | null;
}

export type JobKind = 'STANDARD' | 'RESCUE' | 'INSPECTION';

export type JobStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'PICKED_UP'
  | 'COMPLETED'
  | 'REJECTED';

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly podId: string;
  readonly packageIds: readonly string[];
  readonly pickupCell: Coord;
  readonly dropCell: Coord;
  readonly priority: Priority;
  readonly createdTick: number;
  readonly deadlineTick?: number;
  status: JobStatus;
  assignedRobotId: string | null;
  epoch: number;
  pickedUpPackageIds: string[];
  deliveredPackageIds: string[];
  pickedUpAtTick: number | null;
  completedAtTick: number | null;
  reassignmentCount: number;
}

export type RobotStatus = 'IDLE' | 'MOVING' | 'CHARGING' | 'FAILED';

export interface Robot {
  readonly id: string;
  cell: Coord;
  status: RobotStatus;
  battery: number;
  velocity: number;
  moveProgress: number;
  carryingPodId: string | null;
  assignedJobId: string | null;
  assignedEpoch: number;
  routingToCharger: boolean;
  stallTicks: number;
  escalatedPriorityBonus: number;
  inDeadzone: boolean;
  bufferedPlan: PlanStep[];
  plan: PlanStep[];
  needsReplan: boolean;
  sensorAlert: boolean;
  safetyStopReason: string | null;
}

export interface HumanEntity {
  readonly id: string;
  cell: Coord;
  lastUpdateTick: number;
}

export interface SimulationProfile {
  name: string;
  groundFriction: number;
  baseSpeed: number;
  acceleration: number;
  deceleration: number;
  payloadSpeedFactor: number;
  payloadDrainFactor: number;
  sensorRange: number;
  sensorNoise: number;
  baseBatteryDrain: number;
  idleBatteryDrain: number;
  chargeRate: number;
  agingIntervalTicks: number;
  batterySafetyReserve: number;
  humanBufferRadius: number;
  humanStaleTimeoutTicks: number;
}

export type ConflictPolicyMode = 'PRIORITY_AGING' | 'AUCTION_REBID';

export interface BiddingWeights {
  alpha: number; // space-time ETA weight
  beta: number;  // aisle congestion & pickup delay weight
  gamma: number; // battery depletion risk weight
}

export interface SchedulerPolicy {
  planningHorizon: number;
  maxExpansions: number;
  globalExpansionBudgetPerTick: number;
  enableAging: boolean;
  agingIntervalTicks: number;
  stallEscalationTicks: number;
  conflictMode: ConflictPolicyMode;
  bidding: BiddingWeights;
  autoCreateInspectionTask: boolean;
  enableDeadlockPrediction: boolean;
  deadlockLookaheadTicks: number;
  enableDynamicEdgePricing: boolean;
  congestionWindowTicks: number;
  congestionWeight: number;
  enablePathCache: boolean;
  maxDecisionHistory: number;
  snapshotIntervalTicks: number;
}

export type DecisionCategory =
  | 'ASSIGNMENT'
  | 'PRIORITY_CHANGE'
  | 'ROUTE_SELECTION'
  | 'WAITING'
  | 'CONGESTION_AVOIDANCE'
  | 'BATTERY_CHARGING'
  | 'HUMAN_SAFETY_STOP'
  | 'PACKAGE_MISMATCH'
  | 'REPLANNING'
  | 'FAILURE_RECOVERY';

export interface DecisionRecord {
  seq: number;
  tick: number;
  category: DecisionCategory;
  robotId?: string;
  jobId?: string;
  packageId?: string;
  commandSeq?: number;
  decision: string;
  inputs: Record<string, string | number | boolean>;
  alternativesRejected: string[];
  reason: string;
}

export type RecoveryLadderLevel =
  | 'PREEMPTIVE_BACKTRACK'
  | '1_YIELD_BAY'
  | '2_LOCAL_GROUP_REPLAN'
  | '3_BACKOUT_REBID';

export interface DeadlockEvent {
  tick: number;
  predicted: boolean;
  cycleRobotIds: string[];
  level: RecoveryLadderLevel;
  chosenRobotId: string;
  reason: string;
}

export interface CalibrationObservation {
  id: string;
  distanceCells: number;
  payloadKg: number;
  slowCellsCount: number;
  observedTravelTicks: number;
  observedBatteryDrainPct: number;
  measuredFriction?: number;
}

export interface CalibrationComparisonItem {
  observationId: string;
  simulatedTravelTicks: number;
  observedTravelTicks: number;
  travelTickDelta: number;
  simulatedBatteryDrainPct: number;
  observedBatteryDrainPct: number;
  batteryDrainDelta: number;
}

export interface CalibrationReport {
  disclaimer: string;
  profileName: string;
  sampleCount: number;
  meanAbsTravelTickError: number;
  meanAbsBatteryDrainError: number;
  items: CalibrationComparisonItem[];
}

export interface PlannerStats {
  expansionsThisTick: number;
  totalExpansions: number;
  deferredRequests: number;
  planningBacklog: number;
  cacheHits: number;
  cacheMisses: number;
  lastTickWallClockMs: number;
}

export type SimCommand =
  | { type: 'REGISTER_PACKAGE'; tick: number; pkg: Package }
  | { type: 'REGISTER_POD'; tick: number; pod: { id: string; cell: Coord; packageIds: string[] } }
  | {
      type: 'ADD_JOB';
      tick: number;
      job: {
        id: string;
        podId: string;
        packageIds: string[];
        pickupCell: Coord;
        dropCell: Coord;
        priority?: Priority;
        deadlineTick?: number;
        kind?: JobKind;
      };
    }
  | { type: 'BLOCK_CELL'; tick: number; cell: Coord }
  | { type: 'UNBLOCK_CELL'; tick: number; cell: Coord }
  | { type: 'FAIL_ROBOT'; tick: number; robotId: string }
  | { type: 'RECOVER_ROBOT'; tick: number; robotId: string }
  | { type: 'ADD_ROBOT'; tick: number; robot: { id: string; cell: Coord; battery?: number } }
  | { type: 'SET_POLICY'; tick: number; policy: Partial<SchedulerPolicy> }
  | { type: 'PAINT_CELL'; tick: number; cell: Coord; cellType: CellType }
  | { type: 'ADD_HUMAN'; tick: number; human: { id: string; cell: Coord } }
  | { type: 'MOVE_HUMAN'; tick: number; humanId: string; cell: Coord }
  | { type: 'REMOVE_HUMAN'; tick: number; humanId: string };

export interface EventLogEntry {
  seq: number;
  tick: number;
  command?: SimCommand;
  kind:
    | 'COMMAND'
    | 'CUSTODY'
    | 'PICKUP'
    | 'DROP'
    | 'RESCUE'
    | 'MISPLACED'
    | 'LOCATION_MISMATCH'
    | 'SAFETY_STOP'
    | 'BATTERY'
    | 'REASSIGN'
    | 'DEADLOCK_RECOVERY'
    | 'VALIDATION_ERROR';
  status: 'APPLIED' | 'REJECTED';
  detail: string;
  prevHash: string;
  hash: string;
}

export interface GridMap {
  width: number;
  height: number;
  cells: CellType[][];
}

export interface PriorityDelayStats {
  count: number;
  avgPickupDelay: number;
  p95PickupDelay: number;
}

export interface MetricsSnapshot {
  tick: number;
  jobsCompleted: number;
  throughputPer100Ticks: number;
  avgWaitTime: number;
  p95WaitTime: number;
  pickupDelayByPriority: Record<Priority, PriorityDelayStats>;
  lateJobs: number;
  failureCount: number;
  reassignmentCount: number;
  misplacedIncidents: number;
  safetyStops: number;
  predictedDeadlocksResolved: number;
  reactiveDeadlocksResolved: number;
  congestionIndex: number;
  cellOccupancy: Record<string, number>;
  cellWaitCounts: Record<string, number>;
}

export interface SimSnapshot {
  tick: number;
  stateHash: string;
  state: SimState;
  commandHistoryIndex: number;
  metricsData: {
    cellOccupancy: Record<string, number>;
    cellWaitCounts: Record<string, number>;
    failureCount: number;
    reassignmentCount: number;
    misplacedIncidents: number;
    safetyStops: number;
    predictedDeadlocksResolved: number;
    reactiveDeadlocksResolved: number;
  };
}

export interface SimState {
  seed: number;
  prngState: number;
  tick: number;
  grid: GridMap;
  blockedCells: string[];
  profile: SimulationProfile;
  calibrationObservations: CalibrationObservation[];
  policy: SchedulerPolicy;
  packages: Record<string, Package>;
  custody: Record<string, PackageCustodyRecord>;
  pods: Record<string, Pod>;
  jobs: Record<string, Job>;
  robots: Record<string, Robot>;
  humans: Record<string, HumanEntity>;
  commandQueue: SimCommand[];
  eventLog: EventLogEntry[];
  decisionTimeline: DecisionRecord[];
  decisionSeqCounter: number;
  deadlockEvents: DeadlockEvent[];
  rollingCellOccupancy: Record<string, number[]>;
  planningCursor: number;
  plannerStats: PlannerStats;
  lastInvariantReport: InvariantReport;
  gridRevision: number;
}

export interface ReplayBundle {
  version: 3;
  seed: number;
  profile: SimulationProfile;
  calibrationObservations: CalibrationObservation[];
  initialGrid: GridMap;
  commands: SimCommand[];
}

export type PlanResult =
  | { status: 'ok'; path: PlanStep[]; expanded: number; fromCache?: boolean }
  | { status: 'unreachable'; expanded: number; reason: string };
