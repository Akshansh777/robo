import {
  allocateJobsCNP,
  findNearestChargerCell,
  getEffectivePriorityRank,
  releaseJobToPool,
} from './allocator';
import {
  buildProjectedWaitForGraph,
  choosePreemptiveBacktrackRobot,
  detectWaitForCycles,
  findNearestYieldPocket,
} from './deadlock';
import { CustodyLedger } from './ledger';
import { MetricsTracker } from './metrics';
import {
  coordKey,
  DeterministicPathCache,
  isCellTraversable,
  isStaticallyReachable,
  planSpaceTimePath,
  ReservationTable,
  SpatialRobotIndex,
} from './planner';
import { computeStateHash, createPRNG, PRNG } from './prng';
import { createSimulationProfile } from './profile';
import {
  buildHumanBufferSet,
  scanProximityAndHumans,
} from './sensors';
import {
  CellType,
  Coord,
  DecisionRecord,
  GridMap,
  Job,
  MetricsSnapshot,
  Pod,
  ReplayBundle,
  Robot,
  SchedulerPolicy,
  SimCommand,
  SimSnapshot,
  SimState,
  SimulationProfile,
} from './types';

export const DEFAULT_POLICY: SchedulerPolicy = {
  planningHorizon: 42,
  maxExpansions: 2500,
  globalExpansionBudgetPerTick: 25000,
  enableAging: true,
  agingIntervalTicks: 50,
  stallEscalationTicks: 6,
  conflictMode: 'PRIORITY_AGING',
  bidding: {
    alpha: 1.0,
    beta: 0.8,
    gamma: 1.2,
  },
  autoCreateInspectionTask: true,
  enableDeadlockPrediction: true,
  deadlockLookaheadTicks: 10,
  enableDynamicEdgePricing: true,
  congestionWindowTicks: 15,
  congestionWeight: 0.65,
  enablePathCache: true,
  maxDecisionHistory: 500,
  snapshotIntervalTicks: 10,
};

function cloneGrid(grid: GridMap): GridMap {
  return {
    width: grid.width,
    height: grid.height,
    cells: grid.cells.map((row) => [...row]),
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class SimulationEngine {
  private state: SimState;
  private prng: PRNG;
  private readonly ledger = new CustodyLedger();
  private readonly metrics = new MetricsTracker();
  private readonly spatialIndex = new SpatialRobotIndex();
  private readonly pathCache = new DeterministicPathCache(512);
  private readonly initialGrid: GridMap;
  private readonly commandHistory: SimCommand[] = [];
  private readonly snapshots = new Map<number, SimSnapshot>();
  private autoJobCounter = 0;

  constructor(options: {
    seed: number;
    grid: GridMap;
    profile?: Partial<SimulationProfile>;
    policy?: Partial<SchedulerPolicy>;
  }) {
    const profile = createSimulationProfile(options.profile);
    const policy: SchedulerPolicy = {
      ...DEFAULT_POLICY,
      agingIntervalTicks: profile.agingIntervalTicks,
      ...options.policy,
      bidding: {
        ...DEFAULT_POLICY.bidding,
        ...options.policy?.bidding,
      },
    };

    this.initialGrid = cloneGrid(options.grid);
    this.prng = createPRNG(options.seed);

    this.state = {
      seed: options.seed >>> 0,
      prngState: this.prng.getState(),
      tick: 0,
      grid: cloneGrid(options.grid),
      blockedCells: [],
      profile,
      calibrationObservations: [],
      policy,
      packages: {},
      custody: {},
      pods: {},
      jobs: {},
      robots: {},
      humans: {},
      commandQueue: [],
      eventLog: [],
      decisionTimeline: [],
      decisionSeqCounter: 0,
      deadlockEvents: [],
      rollingCellOccupancy: {},
      planningCursor: 0,
      plannerStats: {
        expansionsThisTick: 0,
        totalExpansions: 0,
        deferredRequests: 0,
        planningBacklog: 0,
        cacheHits: 0,
        cacheMisses: 0,
        lastTickWallClockMs: 0,
      },
      lastInvariantReport: { ok: true, violations: [] },
      gridRevision: 0,
    };

    this.captureSnapshot(0);
  }

  getState(): Readonly<SimState> {
    return this.state;
  }

  getMetrics(): MetricsSnapshot {
    return this.metrics.getSnapshot(this.state);
  }

  getDecisionTimeline(): readonly DecisionRecord[] {
    return this.state.decisionTimeline;
  }

  verifyLedgerChain(): { valid: boolean; brokenAtSeq?: number } {
    return this.ledger.verifyChain(this.state.eventLog);
  }

  checkInvariants() {
    return this.ledger.checkInvariants(this.state);
  }

  stateHash(): string {
    this.state.prngState = this.prng.getState();
    return computeStateHash(this.state);
  }

  setProfile(profile: SimulationProfile, calibrationObservations = this.state.calibrationObservations): void {
    this.state.profile = { ...profile };
    this.state.calibrationObservations = structuredClone(calibrationObservations);
    this.state.gridRevision++;
    this.pathCache.clear();
  }

  dispatch(command: SimCommand): void {
    this.state.commandQueue.push(command);
    this.commandHistory.push(command);
  }

  exportReplay(): ReplayBundle {
    return {
      version: 3,
      seed: this.state.seed,
      profile: { ...this.state.profile },
      calibrationObservations: structuredClone(this.state.calibrationObservations),
      initialGrid: cloneGrid(this.initialGrid),
      commands: structuredClone(this.commandHistory),
    };
  }

  static fromReplay(bundle: ReplayBundle): SimulationEngine {
    const engine = new SimulationEngine({
      seed: bundle.seed,
      grid: bundle.initialGrid,
      profile: bundle.profile,
    });
    engine.setProfile(bundle.profile, bundle.calibrationObservations ?? []);
    for (const cmd of bundle.commands) {
      engine.dispatch(cmd);
    }
    return engine;
  }

  private captureSnapshot(tick: number): void {
    const hash = this.stateHash();
    const clonedState = structuredClone(this.state);
    this.snapshots.set(tick, {
      tick,
      stateHash: hash,
      state: clonedState,
      commandHistoryIndex: this.commandHistory.length,
      metricsData: this.metrics.exportData(),
    });
  }

  /**
   * Time-travel rewind: restores the nearest snapshot <= targetTick and replays deterministically.
   */
  rewindTo(targetTick: number): void {
    if (targetTick < 0) {
      throw new Error(`Cannot rewind to negative tick ${targetTick}`);
    }
    let bestSnapTick = 0;
    for (const snapTick of this.snapshots.keys()) {
      if (snapTick <= targetTick && snapTick >= bestSnapTick) {
        bestSnapTick = snapTick;
      }
    }

    const snap = this.snapshots.get(bestSnapTick);
    if (!snap) {
      throw new Error(`No snapshot available at or before tick ${targetTick}`);
    }

    // Restore state, PRNG, metrics, and queued commands >= bestSnapTick
    this.state = structuredClone(snap.state);
    this.prng = createPRNG(this.state.prngState);
    this.metrics.importData(snap.metricsData);
    this.pathCache.clear();

    // Re-queue commands from commandHistory scheduled at or after bestSnapTick
    const existingSet = new Set(
      this.state.commandQueue.map((c) => JSON.stringify(c))
    );
    for (const cmd of this.commandHistory) {
      if (cmd.tick >= bestSnapTick && cmd.tick <= targetTick) {
        const serialized = JSON.stringify(cmd);
        if (!existingSet.has(serialized)) {
          this.state.commandQueue.push(structuredClone(cmd));
          existingSet.add(serialized);
        }
      }
    }

    // Remove snapshots strictly ahead of targetTick
    for (const k of Array.from(this.snapshots.keys())) {
      if (k > targetTick) this.snapshots.delete(k);
    }

    while (this.state.tick < targetTick) {
      this.step();
    }
  }

  /**
   * Creates an independent counterfactual timeline branched from `targetTick` with `newPolicy`.
   */
  branchFrom(targetTick: number, newPolicy: Partial<SchedulerPolicy>): SimulationEngine {
    const branch = SimulationEngine.fromReplay(this.exportReplay());
    // Copy existing snapshots up to targetTick for fast rewind
    for (const [k, snap] of this.snapshots.entries()) {
      if (k <= targetTick) {
        branch.snapshots.set(k, structuredClone(snap));
      }
    }
    branch.rewindTo(targetTick);
    branch.dispatch({
      type: 'SET_POLICY',
      tick: targetTick,
      policy: newPolicy,
    });
    return branch;
  }

  stepMany(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.step();
    }
  }

  private recordDecision = (rec: Omit<DecisionRecord, 'seq' | 'tick'>): void => {
    const entry: DecisionRecord = {
      seq: this.state.decisionSeqCounter++,
      tick: this.state.tick,
      ...rec,
    };
    this.state.decisionTimeline.push(entry);
    const maxLen = Math.max(10, this.state.policy.maxDecisionHistory);
    if (this.state.decisionTimeline.length > maxLen) {
      this.state.decisionTimeline.splice(
        0,
        this.state.decisionTimeline.length - maxLen
      );
    }
  };

  step(): void {
    const t = this.state.tick;

    // Phase 1: Command Ingestion
    this.processCommandsForTick(t);

    // Build obstacle sets & spatial index
    const navBlocked = this.buildEffectiveObstacleSet(true);
    const allocBlocked = this.buildEffectiveObstacleSet(false);
    this.rebuildSpatialIndex();

    // Phase 2: Live Block Reachability & CNP Allocation
    this.handleLiveBlockRebids(allocBlocked);
    allocateJobsCNP(
      this.state,
      this.ledger,
      this.metrics,
      allocBlocked,
      this.recordDecision
    );

    // Phase 3: Budgeted Space-Time A* Planning + Deadlock Prediction & Recovery Ladder
    const planStartMs = nowMs();
    this.planAndPredictDeadlocks(t, navBlocked);
    this.state.plannerStats.lastTickWallClockMs = nowMs() - planStartMs;

    // Phase 4: Proximity Sensing, Human Safety, Deadzone Buffered Moves & Atomic Execution
    this.executeMoves(t, navBlocked);

    // Phase 5: Station & Task Actions (Pickup, Drop, Charge)
    this.executeStationActions(t);

    // Phase 6: Invariant Check, Tick Advance & Periodic Snapshot
    this.state.lastInvariantReport = this.ledger.checkInvariants(this.state);
    this.state.tick = t + 1;
    this.state.prngState = this.prng.getState();

    const interval = Math.max(1, this.state.policy.snapshotIntervalTicks);
    if (this.state.tick % interval === 0) {
      this.captureSnapshot(this.state.tick);
    }
  }

  private rebuildSpatialIndex(): void {
    this.spatialIndex.clear();
    for (const r of Object.values(this.state.robots)) {
      this.spatialIndex.insert(r.id, r.cell);
    }
  }

  private buildEffectiveObstacleSet(includeHumans: boolean): Set<string> {
    const blocked = new Set<string>(this.state.blockedCells);
    for (const r of Object.values(this.state.robots)) {
      if (r.status === 'FAILED') {
        blocked.add(coordKey(r.cell.x, r.cell.y));
      }
    }
    if (includeHumans) {
      const humanCells = buildHumanBufferSet(
        Object.values(this.state.humans),
        this.state.grid,
        this.state.profile.humanBufferRadius
      );
      for (const k of humanCells) blocked.add(k);
    }
    return blocked;
  }

  private buildDynamicEdgeCosts(t: number): Map<string, number> | undefined {
    if (!this.state.policy.enableDynamicEdgePricing) return undefined;
    const windowSize = Math.max(1, this.state.policy.congestionWindowTicks);
    const weight = this.state.policy.congestionWeight;
    const costs = new Map<string, number>();

    for (const [key, ticks] of Object.entries(this.state.rollingCellOccupancy)) {
      const recent = ticks.filter((tk) => t - tk < windowSize);
      this.state.rollingCellOccupancy[key] = recent;
      if (recent.length > 0) {
        const density = recent.length / windowSize;
        costs.set(key, density * weight);
      }
    }
    return costs;
  }

  private inBounds(c: Coord): boolean {
    return (
      Number.isInteger(c.x) &&
      Number.isInteger(c.y) &&
      c.x >= 0 &&
      c.y >= 0 &&
      c.x < this.state.grid.width &&
      c.y < this.state.grid.height
    );
  }

  private processCommandsForTick(t: number): void {
    const remaining: SimCommand[] = [];
    const due: SimCommand[] = [];

    for (const cmd of this.state.commandQueue) {
      if (cmd.tick <= t) {
        due.push(cmd);
      } else {
        remaining.push(cmd);
      }
    }
    this.state.commandQueue = remaining;

    for (const cmd of due) {
      this.applyCommand(cmd);
    }
  }

  private applyCommand(cmd: SimCommand): void {
    switch (cmd.type) {
      case 'REGISTER_PACKAGE': {
        const { pkg } = cmd;
        if (!pkg.id || this.state.packages[pkg.id] || pkg.weight < 0) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Duplicate or invalid package ID: ${pkg.id}`,
            cmd
          );
          return;
        }
        this.state.packages[pkg.id] = Object.freeze({ ...pkg });
        this.ledger.registerPackage(this.state, pkg.id, { x: 0, y: 0 });
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Registered package ${pkg.id}`,
          cmd
        );
        return;
      }

      case 'REGISTER_POD': {
        const { pod } = cmd;
        if (
          !pod.id ||
          this.state.pods[pod.id] ||
          !this.inBounds(pod.cell) ||
          pod.packageIds.length === 0
        ) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Invalid or duplicate pod ${pod.id}`,
            cmd
          );
          return;
        }
        const uniquePkgs = new Set(pod.packageIds);
        if (uniquePkgs.size !== pod.packageIds.length) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Pod ${pod.id} has duplicate package IDs`,
            cmd
          );
          return;
        }
        for (const pkgId of pod.packageIds) {
          if (!this.state.packages[pkgId]) {
            this.ledger.appendEvent(
              this.state,
              'COMMAND',
              'REJECTED',
              `Pod ${pod.id} references unknown package ${pkgId}`,
              cmd
            );
            return;
          }
        }
        this.state.pods[pod.id] = {
          id: pod.id,
          cell: { ...pod.cell },
          packageIds: Object.freeze([...pod.packageIds]),
          carriedByRobotId: null,
        };
        for (const pkgId of pod.packageIds) {
          const rec = this.state.custody[pkgId];
          if (rec) rec.cell = { ...pod.cell };
        }
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Registered pod ${pod.id}`,
          cmd
        );
        return;
      }

      case 'ADD_JOB': {
        const { job } = cmd;
        if (!job.id || this.state.jobs[job.id]) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Duplicate or invalid job ID: ${job.id}`,
            cmd
          );
          return;
        }
        const pod = this.state.pods[job.podId];
        if (
          !pod ||
          !this.inBounds(job.pickupCell) ||
          !this.inBounds(job.dropCell) ||
          job.packageIds.length === 0
        ) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Invalid pod or bounds on job ${job.id}`,
            cmd
          );
          return;
        }
        for (const pid of job.packageIds) {
          if (!pod.packageIds.includes(pid)) {
            this.ledger.appendEvent(
              this.state,
              'COMMAND',
              'REJECTED',
              `Package ${pid} not in pod ${pod.id}`,
              cmd
            );
            return;
          }
        }
        const created: Job = {
          id: job.id,
          kind: job.kind ?? 'STANDARD',
          podId: job.podId,
          packageIds: Object.freeze([...job.packageIds]),
          pickupCell: { ...job.pickupCell },
          dropCell: { ...job.dropCell },
          priority: job.priority ?? 'NORMAL',
          createdTick: this.state.tick,
          deadlineTick: job.deadlineTick,
          status: 'PENDING',
          assignedRobotId: null,
          epoch: 0,
          pickedUpPackageIds: [],
          deliveredPackageIds: [],
          pickedUpAtTick: null,
          completedAtTick: null,
          reassignmentCount: 0,
        };
        this.state.jobs[created.id] = created;
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Added job ${created.id} (${created.kind}, priority=${created.priority})`,
          cmd
        );
        return;
      }

      case 'BLOCK_CELL': {
        if (!this.inBounds(cmd.cell)) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', 'BLOCK_CELL out of bounds', cmd);
          return;
        }
        const k = coordKey(cmd.cell.x, cmd.cell.y);
        if (!this.state.blockedCells.includes(k)) {
          this.state.blockedCells.push(k);
          this.state.blockedCells.sort();
          this.state.gridRevision++;
          this.pathCache.clear();
          this.markAllRobotsForReplan();
        }
        this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', `Blocked cell ${k}`, cmd);
        return;
      }

      case 'UNBLOCK_CELL': {
        const k = coordKey(cmd.cell.x, cmd.cell.y);
        const idx = this.state.blockedCells.indexOf(k);
        if (idx >= 0) {
          this.state.blockedCells.splice(idx, 1);
          this.state.gridRevision++;
          this.pathCache.clear();
          this.markAllRobotsForReplan();
        }
        this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', `Unblocked cell ${k}`, cmd);
        return;
      }

      case 'PAINT_CELL': {
        if (!this.inBounds(cmd.cell)) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', 'PAINT_CELL out of bounds', cmd);
          return;
        }
        this.state.grid.cells[cmd.cell.y]![cmd.cell.x] = cmd.cellType as CellType;
        this.state.gridRevision++;
        this.pathCache.clear();
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Painted (${cmd.cell.x},${cmd.cell.y}) as ${cmd.cellType}`,
          cmd
        );
        return;
      }

      case 'ADD_ROBOT': {
        const { robot } = cmd;
        const blocked = this.buildEffectiveObstacleSet(false);
        if (
          !robot.id ||
          this.state.robots[robot.id] ||
          !this.inBounds(robot.cell) ||
          !isCellTraversable(this.state.grid, blocked, robot.cell.x, robot.cell.y)
        ) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Invalid or duplicate robot ${robot.id}`,
            cmd
          );
          return;
        }
        const occupied = Object.values(this.state.robots).some(
          (r) => r.cell.x === robot.cell.x && r.cell.y === robot.cell.y
        );
        if (occupied) {
          this.ledger.appendEvent(
            this.state,
            'COMMAND',
            'REJECTED',
            `Robot ${robot.id} spawn occupied`,
            cmd
          );
          return;
        }
        const inDz = this.state.grid.cells[robot.cell.y]![robot.cell.x] === 'deadzone';
        this.state.robots[robot.id] = {
          id: robot.id,
          cell: { ...robot.cell },
          status: 'IDLE',
          battery: Math.max(0, Math.min(100, robot.battery ?? 100)),
          velocity: 0,
          moveProgress: 0,
          carryingPodId: null,
          assignedJobId: null,
          assignedEpoch: 0,
          routingToCharger: false,
          stallTicks: 0,
          escalatedPriorityBonus: 0,
          inDeadzone: inDz,
          bufferedPlan: [],
          plan: [],
          needsReplan: false,
          sensorAlert: false,
          safetyStopReason: null,
        };
        this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', `Added robot ${robot.id}`, cmd);
        return;
      }

      case 'FAIL_ROBOT': {
        const r = this.state.robots[cmd.robotId];
        if (!r) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', `Unknown robot ${cmd.robotId}`, cmd);
          return;
        }
        this.handleRobotFailure(r, `Command FAIL_ROBOT for ${r.id}`, cmd);
        return;
      }

      case 'RECOVER_ROBOT': {
        const r = this.state.robots[cmd.robotId];
        if (!r) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', `Unknown robot ${cmd.robotId}`, cmd);
          return;
        }
        r.status = r.assignedJobId ? 'MOVING' : 'IDLE';
        if (r.battery <= 0) r.battery = 50;
        r.needsReplan = true;
        this.state.gridRevision++;
        this.pathCache.clear();
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', `Recovered robot ${r.id}`, cmd);
        return;
      }

      case 'SET_POLICY': {
        this.state.policy = {
          ...this.state.policy,
          ...cmd.policy,
          bidding: {
            ...this.state.policy.bidding,
            ...cmd.policy.bidding,
          },
        };
        this.pathCache.clear();
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Updated policy (mode=${this.state.policy.conflictMode}, deadlockPred=${this.state.policy.enableDeadlockPrediction})`,
          cmd
        );
        return;
      }

      case 'ADD_HUMAN': {
        const { human } = cmd;
        if (!human.id || this.state.humans[human.id] || !this.inBounds(human.cell)) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', `Invalid human ${human.id}`, cmd);
          return;
        }
        this.state.humans[human.id] = {
          id: human.id,
          cell: { ...human.cell },
          lastUpdateTick: this.state.tick,
        };
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Added human ${human.id} at (${human.cell.x},${human.cell.y})`,
          cmd
        );
        return;
      }

      case 'MOVE_HUMAN': {
        const h = this.state.humans[cmd.humanId];
        if (!h || !this.inBounds(cmd.cell)) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', `Invalid MOVE_HUMAN ${cmd.humanId}`, cmd);
          return;
        }
        h.cell = { ...cmd.cell };
        h.lastUpdateTick = this.state.tick;
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Moved human ${h.id} to (${cmd.cell.x},${cmd.cell.y})`,
          cmd
        );
        return;
      }

      case 'REMOVE_HUMAN': {
        if (!this.state.humans[cmd.humanId]) {
          this.ledger.appendEvent(this.state, 'COMMAND', 'REJECTED', `Unknown human ${cmd.humanId}`, cmd);
          return;
        }
        delete this.state.humans[cmd.humanId];
        this.markAllRobotsForReplan();
        this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', `Removed human ${cmd.humanId}`, cmd);
        return;
      }
    }
  }

  private handleRobotFailure(robot: Robot, reason: string, cmd?: SimCommand): void {
    const wasAlreadyFailed = robot.status === 'FAILED';
    robot.status = 'FAILED';
    robot.velocity = 0;
    robot.moveProgress = 0;
    robot.plan = [];
    robot.bufferedPlan = [];
    robot.routingToCharger = false;

    if (!wasAlreadyFailed) {
      this.metrics.recordFailure();
      this.state.gridRevision++;
      this.pathCache.clear();
    }

    const job = robot.assignedJobId ? this.state.jobs[robot.assignedJobId] : undefined;

    if (robot.carryingPodId) {
      const pod = this.state.pods[robot.carryingPodId];
      if (pod) {
        pod.carriedByRobotId = null;
        pod.cell = { ...robot.cell };

        for (const pkgId of pod.packageIds) {
          const rec = this.state.custody[pkgId];
          if (rec && rec.state === 'PICKED') {
            this.ledger.compareAndSwap(this.state, {
              packageId: pkgId,
              expectedStates: ['PICKED'],
              expectedOwner: robot.id,
              expectedEpoch: rec.epoch,
              nextState: 'STRANDED',
              nextOwner: null,
              cell: robot.cell,
              detail: `Carrier ${robot.id} failed mid-route (${reason})`,
            });
          }
        }

        if (job && job.status === 'PICKED_UP') {
          job.status = 'REJECTED';
          job.assignedRobotId = null;

          const rescueId = `RESCUE-${job.id}-${++this.autoJobCounter}`;
          const rescueJob: Job = {
            id: rescueId,
            kind: 'RESCUE',
            podId: pod.id,
            packageIds: Object.freeze([...job.packageIds]),
            pickupCell: { ...robot.cell },
            dropCell: { ...job.dropCell },
            priority: 'URGENT',
            createdTick: this.state.tick,
            deadlineTick: job.deadlineTick,
            status: 'PENDING',
            assignedRobotId: null,
            epoch: 0,
            pickedUpPackageIds: [],
            deliveredPackageIds: [],
            pickedUpAtTick: null,
            completedAtTick: null,
            reassignmentCount: job.reassignmentCount + 1,
          };
          this.state.jobs[rescueId] = rescueJob;
          this.metrics.recordReassignment();

          this.ledger.appendEvent(
            this.state,
            'RESCUE',
            'APPLIED',
            `Created rescue job ${rescueId} at (${robot.cell.x},${robot.cell.y}) for stranded pod ${pod.id}`
          );
          this.recordDecision({
            category: 'FAILURE_RECOVERY',
            robotId: robot.id,
            jobId: rescueId,
            packageId: job.packageIds[0],
            decision: 'CREATE_RESCUE_JOB',
            inputs: { wreckX: robot.cell.x, wreckY: robot.cell.y },
            alternativesRejected: ['ABANDON_CARGO'],
            reason,
          });
        }
      }
      robot.carryingPodId = null;
      robot.assignedJobId = null;
      robot.assignedEpoch = 0;
    } else if (job && job.status === 'ASSIGNED') {
      releaseJobToPool(
        this.state,
        this.ledger,
        this.metrics,
        robot,
        job,
        `Carrier ${robot.id} failed before pickup`
      );
      this.recordDecision({
        category: 'FAILURE_RECOVERY',
        robotId: robot.id,
        jobId: job.id,
        decision: 'RELEASE_JOB_ON_FAILURE',
        inputs: { robotStatus: 'FAILED' },
        alternativesRejected: ['HOLD_JOB'],
        reason,
      });
    } else {
      robot.assignedJobId = null;
      robot.assignedEpoch = 0;
    }

    this.markAllRobotsForReplan();
    this.ledger.appendEvent(this.state, 'COMMAND', 'APPLIED', reason, cmd);
  }

  private handleLiveBlockRebids(blockedSet: ReadonlySet<string>): void {
    for (const robot of Object.values(this.state.robots)) {
      if (robot.status === 'FAILED' || !robot.assignedJobId) continue;
      const job = this.state.jobs[robot.assignedJobId];
      if (!job) continue;

      if (job.status === 'ASSIGNED') {
        const reachable = isStaticallyReachable(
          this.state.grid,
          blockedSet,
          robot.cell,
          job.pickupCell
        );
        if (!reachable) {
          releaseJobToPool(
            this.state,
            this.ledger,
            this.metrics,
            robot,
            job,
            'Pickup cell blocked/unreachable; returning job to pool'
          );
        }
      } else if (job.status === 'PICKED_UP') {
        const dropReachable = isStaticallyReachable(
          this.state.grid,
          blockedSet,
          robot.cell,
          job.dropCell
        );
        if (!dropReachable) {
          robot.plan = [];
          robot.needsReplan = true;
        }
      }
    }
  }

  private markAllRobotsForReplan(): void {
    for (const r of Object.values(this.state.robots)) {
      if (r.status !== 'FAILED' && !r.inDeadzone) {
        r.needsReplan = true;
      }
    }
  }

  private getRobotTrafficPriority(r: Robot): [number, number, string] {
    if (r.status === 'FAILED') return [100, 100, r.id];
    let score = 0;
    let phaseRank = 2;

    if (r.assignedJobId) {
      const job = this.state.jobs[r.assignedJobId];
      if (job) {
        score = getEffectivePriorityRank(job, this.state.tick, this.state.policy);
        if (job.kind === 'RESCUE') score += 1;
        phaseRank = job.status === 'PICKED_UP' ? 0 : 1;
      }
    }

    if (this.state.policy.conflictMode === 'PRIORITY_AGING') {
      score += r.escalatedPriorityBonus;
    }

    return [-score, phaseRank, r.id];
  }

  private getRobotGoal(r: Robot, blockedSet: ReadonlySet<string>): Coord | null {
    if (r.assignedJobId) {
      const job = this.state.jobs[r.assignedJobId];
      if (job) {
        if (job.status === 'ASSIGNED') return job.pickupCell;
        if (job.status === 'PICKED_UP') return job.dropCell;
      }
    }
    if (r.routingToCharger) {
      const charger = findNearestChargerCell(this.state, r.cell, blockedSet);
      if (charger) return charger.cell;
    }
    return null;
  }

  /**
   * Budgeted Space-Time A* planner + Projected Wait-For Graph Deadlock Predictor + Recovery Ladder.
   */
  private planAndPredictDeadlocks(t: number, blockedSet: ReadonlySet<string>): void {
    const reservations = new ReservationTable();
    const horizon = this.state.policy.planningHorizon;
    const horizonEnd = t + horizon;
    const dynamicEdgeCosts = this.buildDynamicEdgeCosts(t);

    let budgetRemaining = Math.max(1, this.state.policy.globalExpansionBudgetPerTick);
    let expansionsUsed = 0;
    let deferredCount = 0;

    const allSorted = Object.values(this.state.robots).sort((a, b) => {
      const pa = this.getRobotTrafficPriority(a);
      const pb = this.getRobotTrafficPriority(b);
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0;
    });

    // Reserve failed robots and robots operating autonomously inside DEADZONEs
    for (const r of allSorted) {
      r.inDeadzone = this.state.grid.cells[r.cell.y]![r.cell.x] === 'deadzone';
      r.plan = r.plan.filter((s) => s.t > t);
      r.bufferedPlan = r.bufferedPlan.filter((s) => s.t > t);

      if (r.status === 'FAILED') {
        reservations.reservePath(r.id, r.cell, t, [], horizonEnd, 1);
      } else if (r.inDeadzone) {
        // Inside DEADZONE: robot loses live coordinator updates, runs buffered trajectory,
        // and reserves a wider 2-cell safety halo ahead.
        r.plan = [...r.bufferedPlan];
        reservations.reservePath(r.id, r.cell, t, r.plan, horizonEnd, 2);
      }
    }

    // Apply fair round-robin offset among equal-priority robots when budget-constrained
    const activeRobots = allSorted.filter(
      (r) => r.status !== 'FAILED' && !r.inDeadzone
    );
    const nActive = activeRobots.length;
    const offset = nActive > 0 ? this.state.planningCursor % nActive : 0;
    const orderedActive =
      offset === 0
        ? activeRobots
        : [...activeRobots.slice(offset), ...activeRobots.slice(0, offset)];

    // Re-sort strictly by traffic priority first, preserving cursor tie-break within same priority
    orderedActive.sort((a, b) => {
      const pa = this.getRobotTrafficPriority(a);
      const pb = this.getRobotTrafficPriority(b);
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return 0;
    });

    for (const r of orderedActive) {
      const goal = this.getRobotGoal(r, blockedSet);

      if (goal === null) {
        let cellNeeded = false;
        for (let ft = t + 1; ft <= horizonEnd; ft++) {
          if (reservations.isVertexReserved(r.cell.x, r.cell.y, ft, r.id)) {
            cellNeeded = true;
            break;
          }
        }

        if (cellNeeded && budgetRemaining > 0) {
          const cap = Math.min(this.state.policy.maxExpansions, budgetRemaining);
          const yieldRes = planSpaceTimePath({
            robotId: r.id,
            start: r.cell,
            goal: r.cell,
            startTick: t,
            horizon,
            maxExpansions: cap,
            grid: this.state.grid,
            blockedSet,
            reservations,
            anyFreeCellMode: true,
            dynamicEdgeCosts,
          });
          expansionsUsed += yieldRes.expanded;
          budgetRemaining -= yieldRes.expanded;
          r.plan = yieldRes.status === 'ok' ? yieldRes.path : [];
        } else if (cellNeeded) {
          deferredCount++;
          r.plan = [];
        } else {
          r.plan = [];
        }

        r.bufferedPlan = [...r.plan];
        reservations.reservePath(r.id, r.cell, t, r.plan, horizonEnd, 1);
        r.needsReplan = false;
        continue;
      }

      if (r.cell.x === goal.x && r.cell.y === goal.y) {
        r.plan = [];
        r.bufferedPlan = [];
        r.needsReplan = false;
        reservations.reservePath(r.id, r.cell, t, [], horizonEnd, 1);
        continue;
      }

      let planValid = !r.needsReplan && r.plan.length > 0;
      if (planValid) {
        let px = r.cell.x;
        let py = r.cell.y;
        for (const step of r.plan) {
          if (
            !isCellTraversable(this.state.grid, blockedSet, step.x, step.y) ||
            reservations.isVertexReserved(step.x, step.y, step.t, r.id) ||
            reservations.isEdgeSwapReserved(px, py, step.x, step.y, step.t, r.id)
          ) {
            planValid = false;
            break;
          }
          px = step.x;
          py = step.y;
        }
      }

      if (!planValid) {
        // Attempt deterministic cache hit when uncontested
        const cacheKey = `${this.state.gridRevision}|${r.cell.x},${r.cell.y}->${goal.x},${goal.y}|dyn:${this.state.policy.enableDynamicEdgePricing ? 1 : 0}`;
        let usedCache = false;

        if (this.state.policy.enablePathCache && !this.state.policy.enableDynamicEdgePricing) {
          const cachedCoords = this.pathCache.get(cacheKey);
          if (cachedCoords && cachedCoords.length > 0) {
            const candidateSteps = cachedCoords.map((c, idx) => {
              const prev = idx === 0 ? r.cell : cachedCoords[idx - 1]!;
              const dx = c.x - prev.x;
              const dy = c.y - prev.y;
              const action =
                dx === 1 ? 'E' : dx === -1 ? 'W' : dy === 1 ? 'S' : dy === -1 ? 'N' : 'WAIT';
              return { x: c.x, y: c.y, t: t + idx + 1, action } as const;
            });

            let px = r.cell.x;
            let py = r.cell.y;
            let conflictFree = true;
            for (const st of candidateSteps) {
              if (
                reservations.isVertexReserved(st.x, st.y, st.t, r.id) ||
                reservations.isEdgeSwapReserved(px, py, st.x, st.y, st.t, r.id)
              ) {
                conflictFree = false;
                break;
              }
              px = st.x;
              py = st.y;
            }

            if (conflictFree) {
              r.plan = [...candidateSteps];
              r.needsReplan = false;
              usedCache = true;
              this.state.plannerStats.cacheHits++;
            }
          }
        }

        if (!usedCache) {
          if (budgetRemaining <= 0) {
            // Fair deferral: robot stays safely in place and gets priority in next tick's cursor
            deferredCount++;
            r.plan = [];
            reservations.reservePath(r.id, r.cell, t, [], horizonEnd, 1);
            continue;
          }

          this.state.plannerStats.cacheMisses++;
          const cap = Math.min(this.state.policy.maxExpansions, budgetRemaining);
          const res = planSpaceTimePath({
            robotId: r.id,
            start: r.cell,
            goal,
            startTick: t,
            horizon,
            maxExpansions: cap,
            grid: this.state.grid,
            blockedSet,
            reservations,
            dynamicEdgeCosts,
          });
          expansionsUsed += res.expanded;
          budgetRemaining -= res.expanded;

          if (res.status === 'ok') {
            r.plan = res.path;
            if (
              this.state.policy.enablePathCache &&
              !this.state.policy.enableDynamicEdgePricing &&
              res.path.every((s) => s.action !== 'WAIT')
            ) {
              this.pathCache.set(
                cacheKey,
                res.path.map((s) => ({ x: s.x, y: s.y }))
              );
            }
          } else {
            r.plan = [];
          }
          r.needsReplan = false;
        }
      }

      r.bufferedPlan = [...r.plan];
      reservations.reservePath(r.id, r.cell, t, r.plan, horizonEnd, 1);
    }

    if (deferredCount > 0 && nActive > 0) {
      this.state.planningCursor = (this.state.planningCursor + 1) % nActive;
    }

    // Deadlock Prediction (Wait-For Graph projected `deadlockLookaheadTicks` ahead)
    if (this.state.policy.enableDeadlockPrediction) {
      const waitForEdges = buildProjectedWaitForGraph(
        allSorted,
        reservations,
        t,
        this.state.policy.deadlockLookaheadTicks
      );
      const cycles = detectWaitForCycles(waitForEdges);

      for (const cycle of cycles) {
        const anyStuck = cycle.some((id) => (this.state.robots[id]?.stallTicks ?? 0) > 0);
        const backtrackRobot = choosePreemptiveBacktrackRobot(this.state, cycle);
        if (!backtrackRobot) continue;

        const yieldPath = findNearestYieldPocket(
          this.state.grid,
          blockedSet,
          reservations,
          backtrackRobot.id,
          backtrackRobot.cell,
          t,
          horizon,
          Math.min(500, this.state.policy.maxExpansions)
        );

        if (yieldPath && yieldPath.length > 0) {
          backtrackRobot.plan = yieldPath;
          backtrackRobot.bufferedPlan = [...yieldPath];
          backtrackRobot.needsReplan = false;
          reservations.reservePath(
            backtrackRobot.id,
            backtrackRobot.cell,
            t,
            yieldPath,
            horizonEnd,
            1
          );

          if (!anyStuck) {
            this.metrics.recordPredictedDeadlockResolved();
          } else {
            this.metrics.recordReactiveDeadlockResolved();
          }

          const reason = `Predicted wait-for cycle [${cycle.join(' -> ')}]; preemptively backing ${backtrackRobot.id} into yield pocket`;
          this.state.deadlockEvents.push({
            tick: t,
            predicted: !anyStuck,
            cycleRobotIds: [...cycle],
            level: 'PREEMPTIVE_BACKTRACK',
            chosenRobotId: backtrackRobot.id,
            reason,
          });
          this.ledger.appendEvent(this.state, 'DEADLOCK_RECOVERY', 'APPLIED', reason);
          this.recordDecision({
            category: 'CONGESTION_AVOIDANCE',
            robotId: backtrackRobot.id,
            jobId: backtrackRobot.assignedJobId ?? undefined,
            decision: 'PREEMPTIVE_BACKTRACK',
            inputs: { cycleSize: cycle.length, predictedBeforeStall: !anyStuck },
            alternativesRejected: cycle.filter((id) => id !== backtrackRobot.id),
            reason,
          });
        }
      }
    }

    // Reactive Fallback Recovery Ladder for any deadlock that slipped through
    this.runReactiveDeadlockLadder(t, allSorted, blockedSet, reservations, horizon, horizonEnd);

    this.state.plannerStats.expansionsThisTick = expansionsUsed;
    this.state.plannerStats.totalExpansions += expansionsUsed;
    this.state.plannerStats.deferredRequests = deferredCount;
    this.state.plannerStats.planningBacklog = allSorted.filter(
      (r) => r.status !== 'FAILED' && r.needsReplan
    ).length;
  }

  private runReactiveDeadlockLadder(
    t: number,
    allSorted: readonly Robot[],
    blockedSet: ReadonlySet<string>,
    reservations: ReservationTable,
    horizon: number,
    horizonEnd: number
  ): void {
    const k = Math.max(1, this.state.policy.stallEscalationTicks);
    const stalled = allSorted.filter(
      (r) => r.status !== 'FAILED' && !r.inDeadzone && r.stallTicks >= k
    );
    if (stalled.length < 2) return;

    // Pick the lowest-priority stalled robot for ladder escalation
    const victim = stalled[stalled.length - 1]!;

    if (victim.stallTicks < k * 2) {
      // Ladder Step 1: Yield to bay
      const bayPath = findNearestYieldPocket(
        this.state.grid,
        blockedSet,
        reservations,
        victim.id,
        victim.cell,
        t,
        horizon,
        Math.min(400, this.state.policy.maxExpansions)
      );
      if (bayPath && bayPath.length > 0) {
        victim.plan = bayPath;
        victim.bufferedPlan = [...bayPath];
        reservations.reservePath(victim.id, victim.cell, t, bayPath, horizonEnd, 1);
        this.metrics.recordReactiveDeadlockResolved();
        const reason = `Ladder L1 (1_YIELD_BAY): ${victim.id} stalled ${victim.stallTicks} ticks; yielding to bay`;
        this.state.deadlockEvents.push({
          tick: t,
          predicted: false,
          cycleRobotIds: stalled.map((s) => s.id),
          level: '1_YIELD_BAY',
          chosenRobotId: victim.id,
          reason,
        });
        this.ledger.appendEvent(this.state, 'DEADLOCK_RECOVERY', 'APPLIED', reason);
      }
    } else if (victim.stallTicks < k * 3) {
      // Ladder Step 2: Local group replan
      for (const s of stalled) {
        s.needsReplan = true;
      }
      this.metrics.recordReactiveDeadlockResolved();
      const reason = `Ladder L2 (2_LOCAL_GROUP_REPLAN): joint local replan for stalled group [${stalled.map((s) => s.id).join(',')}]`;
      this.state.deadlockEvents.push({
        tick: t,
        predicted: false,
        cycleRobotIds: stalled.map((s) => s.id),
        level: '2_LOCAL_GROUP_REPLAN',
        chosenRobotId: victim.id,
        reason,
      });
      this.ledger.appendEvent(this.state, 'DEADLOCK_RECOVERY', 'APPLIED', reason);
    } else if (victim.assignedJobId && !victim.carryingPodId) {
      // Ladder Step 3: Back out & re-bid
      const job = this.state.jobs[victim.assignedJobId];
      if (job && job.status === 'ASSIGNED') {
        releaseJobToPool(
          this.state,
          this.ledger,
          this.metrics,
          victim,
          job,
          `Ladder L3 (3_BACKOUT_REBID) after ${victim.stallTicks} stalled ticks`
        );
        victim.stallTicks = 0;
        this.metrics.recordReactiveDeadlockResolved();
        const reason = `Ladder L3 (3_BACKOUT_REBID): ${victim.id} released ${job.id} and backed out`;
        this.state.deadlockEvents.push({
          tick: t,
          predicted: false,
          cycleRobotIds: stalled.map((s) => s.id),
          level: '3_BACKOUT_REBID',
          chosenRobotId: victim.id,
          reason,
        });
        this.ledger.appendEvent(this.state, 'DEADLOCK_RECOVERY', 'APPLIED', reason);
      }
    }
  }

  private computeRobotCarriedMass(r: Robot): number {
    if (!r.carryingPodId) return 0;
    const pod = this.state.pods[r.carryingPodId];
    if (!pod) return 0;
    let total = 0;
    for (const pid of pod.packageIds) {
      total += this.state.packages[pid]?.weight ?? 0;
    }
    return total;
  }

  private executeMoves(t: number, blockedSet: ReadonlySet<string>): void {
    const allRobots = Object.values(this.state.robots).sort((a, b) => {
      const pa = this.getRobotTrafficPriority(a);
      const pb = this.getRobotTrafficPriority(b);
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0;
    });
    const humans = Object.values(this.state.humans);

    interface ProposedMove {
      robot: Robot;
      from: Coord;
      to: Coord;
      wantsStep: boolean;
    }

    const proposals: ProposedMove[] = [];

    for (const r of allRobots) {
      r.sensorAlert = false;
      r.safetyStopReason = null;

      if (r.status === 'FAILED' || r.battery <= 0) {
        r.velocity = 0;
        r.moveProgress = 0;
        proposals.push({ robot: r, from: { ...r.cell }, to: { ...r.cell }, wantsStep: false });
        continue;
      }

      const nextStep = r.plan[0];
      const proposedTarget: Coord =
        nextStep && nextStep.t === t + 1
          ? { x: nextStep.x, y: nextStep.y }
          : { ...r.cell };

      // Query only nearby robots via spatial hash index for O(1) scaling
      const nearbyIds = this.spatialIndex.queryRadius(
        r.cell,
        Math.max(this.state.profile.sensorRange + 1, this.state.profile.humanBufferRadius + 2)
      );
      const nearbyRobots = nearbyIds
        .map((id) => this.state.robots[id]!)
        .filter(Boolean);

      const reading = scanProximityAndHumans(
        r,
        proposedTarget,
        nearbyRobots,
        humans,
        t,
        this.state.grid,
        blockedSet,
        this.state.profile,
        this.prng
      );

      if (reading.unsafe) {
        r.sensorAlert = true;
        r.safetyStopReason = reading.reason;
        r.velocity = 0;
        r.moveProgress = 0;
        if (!r.inDeadzone) r.needsReplan = true;
        this.metrics.recordSafetyStop();
        this.ledger.appendEvent(
          this.state,
          'SAFETY_STOP',
          'APPLIED',
          `Robot ${r.id} stopped: ${reading.reason ?? 'Proximity/Human safety'}`
        );
        this.recordDecision({
          category: 'HUMAN_SAFETY_STOP',
          robotId: r.id,
          jobId: r.assignedJobId ?? undefined,
          decision: 'EMERGENCY_SAFETY_STOP',
          inputs: {
            x: r.cell.x,
            y: r.cell.y,
            targetX: proposedTarget.x,
            targetY: proposedTarget.y,
          },
          alternativesRejected: ['PROCEED_STEP'],
          reason: reading.reason ?? 'Proximity/Human safety buffer violation',
        });
        proposals.push({ robot: r, from: { ...r.cell }, to: { ...r.cell }, wantsStep: false });
        continue;
      }

      if (!nextStep || nextStep.t !== t + 1) {
        r.velocity = Math.max(0, r.velocity - this.state.profile.deceleration);
        r.moveProgress = 0;
        proposals.push({ robot: r, from: { ...r.cell }, to: { ...r.cell }, wantsStep: false });
        continue;
      }

      const isWaitStep =
        proposedTarget.x === r.cell.x && proposedTarget.y === r.cell.y;
      if (isWaitStep) {
        r.velocity = Math.max(0, r.velocity - this.state.profile.deceleration);
        r.moveProgress = 0;
        r.plan.shift();
        r.bufferedPlan.shift();
        proposals.push({ robot: r, from: { ...r.cell }, to: { ...r.cell }, wantsStep: false });
        continue;
      }

      const cellType = this.state.grid.cells[r.cell.y]![r.cell.x]!;
      const cellMult = cellType === 'slow' ? 0.5 : 1.0;
      const mass = this.computeRobotCarriedMass(r);
      const payloadDivisor = 1 + mass * this.state.profile.payloadSpeedFactor;
      const frictionMult = 0.5 + 0.5 * this.state.profile.groundFriction;
      const maxEffectiveSpeed = Math.max(
        0.2,
        Math.min(1.0, (this.state.profile.baseSpeed * cellMult * frictionMult) / payloadDivisor)
      );

      r.velocity = Math.min(maxEffectiveSpeed, r.velocity + this.state.profile.acceleration);
      r.moveProgress += r.velocity;

      if (r.moveProgress >= 1.0 - 1e-9) {
        proposals.push({
          robot: r,
          from: { ...r.cell },
          to: proposedTarget,
          wantsStep: true,
        });
      } else {
        if (!r.inDeadzone) r.needsReplan = true;
        proposals.push({ robot: r, from: { ...r.cell }, to: { ...r.cell }, wantsStep: false });
      }
    }

    // Two-phase atomic conflict resolution
    const committedNext = new Map<string, Coord>();
    const occupiedTargets = new Set<string>();

    for (const p of proposals) {
      if (!p.wantsStep) {
        committedNext.set(p.robot.id, p.from);
        occupiedTargets.add(coordKey(p.from.x, p.from.y));
      }
    }

    for (const p of proposals) {
      if (!p.wantsStep) continue;
      const toKey = coordKey(p.to.x, p.to.y);

      if (
        !isCellTraversable(this.state.grid, blockedSet, p.to.x, p.to.y) ||
        occupiedTargets.has(toKey)
      ) {
        committedNext.set(p.robot.id, p.from);
        occupiedTargets.add(coordKey(p.from.x, p.from.y));
        p.robot.moveProgress = 0;
        if (!p.robot.inDeadzone) p.robot.needsReplan = true;
        continue;
      }

      let swapDetected = false;
      for (const other of proposals) {
        if (other.robot.id === p.robot.id) continue;
        const otherNext = committedNext.get(other.robot.id);
        if (
          otherNext &&
          other.from.x === p.to.x &&
          other.from.y === p.to.y &&
          otherNext.x === p.from.x &&
          otherNext.y === p.from.y
        ) {
          swapDetected = true;
          break;
        }
      }

      if (swapDetected) {
        committedNext.set(p.robot.id, p.from);
        occupiedTargets.add(coordKey(p.from.x, p.from.y));
        p.robot.moveProgress = 0;
        if (!p.robot.inDeadzone) p.robot.needsReplan = true;
        continue;
      }

      committedNext.set(p.robot.id, p.to);
      occupiedTargets.add(toKey);
      p.robot.moveProgress = 0;
      p.robot.plan.shift();
      p.robot.bufferedPlan.shift();
    }

    // Commit positions, rolling occupancy window, stall escalation, and battery drain
    for (const p of proposals) {
      const r = p.robot;
      const nextPos = committedNext.get(r.id)!;
      const moved = nextPos.x !== r.cell.x || nextPos.y !== r.cell.y;
      r.cell = { ...nextPos };

      const occKey = coordKey(r.cell.x, r.cell.y);
      const hist = this.state.rollingCellOccupancy[occKey] ?? [];
      hist.push(t);
      this.state.rollingCellOccupancy[occKey] = hist;

      const hasGoal = r.assignedJobId !== null || r.routingToCharger;
      const waitedWithGoal = !moved && hasGoal && r.status !== 'FAILED';
      this.metrics.recordCellOccupancy(r.cell.x, r.cell.y, waitedWithGoal);

      if (moved) {
        r.stallTicks = 0;
        r.escalatedPriorityBonus = 0;
      } else if (waitedWithGoal) {
        r.stallTicks++;
        const k = Math.max(1, this.state.policy.stallEscalationTicks);
        if (r.stallTicks > k && this.state.policy.conflictMode === 'PRIORITY_AGING') {
          const newBonus = Math.floor(r.stallTicks / k) * 2;
          if (newBonus > r.escalatedPriorityBonus) {
            r.escalatedPriorityBonus = newBonus;
            if (!r.inDeadzone) r.needsReplan = true;
            this.recordDecision({
              category: 'PRIORITY_CHANGE',
              robotId: r.id,
              jobId: r.assignedJobId ?? undefined,
              decision: 'ESCALATE_TRAFFIC_PRIORITY',
              inputs: { stallTicks: r.stallTicks, newBonus },
              alternativesRejected: ['KEEP_BASE_PRIORITY'],
              reason: `Robot ${r.id} waited ${r.stallTicks} ticks (> k=${k}); escalated traffic priority +${newBonus}`,
            });
          }
        }
      }

      if (r.carryingPodId) {
        const pod = this.state.pods[r.carryingPodId];
        if (pod) pod.cell = { ...nextPos };
        for (const pkgId of pod?.packageIds ?? []) {
          const rec = this.state.custody[pkgId];
          if (rec && rec.state === 'PICKED') {
            rec.cell = { ...nextPos };
          }
        }
      }

      if (r.status !== 'FAILED') {
        const mass = this.computeRobotCarriedMass(r);
        const drain = moved
          ? this.state.profile.baseBatteryDrain +
            mass * this.state.profile.payloadDrainFactor
          : this.state.profile.idleBatteryDrain;
        r.battery = Math.max(0, r.battery - drain);

        if (r.battery <= 0) {
          this.handleRobotFailure(r, `Robot ${r.id} depleted battery at (${r.cell.x},${r.cell.y})`);
        }
      }
    }
  }

  private executeStationActions(t: number): void {
    const robots = Object.values(this.state.robots).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    for (const r of robots) {
      if (r.status === 'FAILED') continue;

      const cellType = this.state.grid.cells[r.cell.y]![r.cell.x]!;
      if (cellType === 'charger' && !r.assignedJobId) {
        r.status = 'CHARGING';
        r.battery = Math.min(100, r.battery + this.state.profile.chargeRate);
        if (r.battery >= 95) {
          r.routingToCharger = false;
          r.status = 'IDLE';
        }
      }

      if (!r.assignedJobId) continue;
      const job = this.state.jobs[r.assignedJobId];
      if (!job) {
        r.assignedJobId = null;
        r.status = 'IDLE';
        continue;
      }

      if (
        job.status === 'ASSIGNED' &&
        r.cell.x === job.pickupCell.x &&
        r.cell.y === job.pickupCell.y
      ) {
        this.attemptPickup(r, job, t);
      } else if (
        job.status === 'PICKED_UP' &&
        r.cell.x === job.dropCell.x &&
        r.cell.y === job.dropCell.y
      ) {
        this.attemptDrop(r, job, t);
      }
    }
  }

  private recordMisplacedIncident(
    kind: 'MISPLACED' | 'LOCATION_MISMATCH',
    pkgId: string,
    expectedCell: Coord,
    observedCell: Coord,
    detail: string,
    podId?: string
  ): void {
    this.metrics.recordMisplacedIncident();
    const rec = this.state.custody[pkgId];
    if (rec) {
      rec.misplacedCount++;
      rec.cell = { ...observedCell };
      rec.lastUpdatedTick = this.state.tick;
    }

    this.ledger.appendEvent(
      this.state,
      kind,
      'REJECTED',
      `${detail} (expected=(${expectedCell.x},${expectedCell.y}), observed=(${observedCell.x},${observedCell.y}))`
    );

    this.recordDecision({
      category: 'PACKAGE_MISMATCH',
      packageId: pkgId,
      decision: `REJECT_${kind}`,
      inputs: {
        expectedX: expectedCell.x,
        expectedY: expectedCell.y,
        observedX: observedCell.x,
        observedY: observedCell.y,
      },
      alternativesRejected: ['SILENT_COMPLETE'],
      reason: detail,
    });

    if (this.state.policy.autoCreateInspectionTask && podId && this.state.pods[podId]) {
      const inspId = `INSPECT-${pkgId}-${++this.autoJobCounter}`;
      if (!this.state.jobs[inspId]) {
        this.state.jobs[inspId] = {
          id: inspId,
          kind: 'INSPECTION',
          podId,
          packageIds: Object.freeze([pkgId]),
          pickupCell: { ...observedCell },
          dropCell: { ...expectedCell },
          priority: 'HIGH',
          createdTick: this.state.tick,
          status: 'PENDING',
          assignedRobotId: null,
          epoch: 0,
          pickedUpPackageIds: [],
          deliveredPackageIds: [],
          pickedUpAtTick: null,
          completedAtTick: null,
          reassignmentCount: 0,
        };
        this.ledger.appendEvent(
          this.state,
          'COMMAND',
          'APPLIED',
          `Spawned inspection recovery task ${inspId} for package ${pkgId}`
        );
      }
    }
  }

  attemptPickup(
    robot: Robot,
    job: Job,
    tick = this.state.tick,
    claimedPodId?: string
  ): boolean {
    const targetPodId = claimedPodId ?? job.podId;
    const pod: Pod | undefined = this.state.pods[targetPodId];

    if (!pod || targetPodId !== job.podId) {
      for (const pid of job.packageIds) {
        this.recordMisplacedIncident(
          'MISPLACED',
          pid,
          job.pickupCell,
          robot.cell,
          `Wrong pod ${targetPodId} presented for job ${job.id} (expected ${job.podId})`,
          job.podId
        );
      }
      return false;
    }

    if (
      robot.cell.x !== job.pickupCell.x ||
      robot.cell.y !== job.pickupCell.y ||
      pod.cell.x !== job.pickupCell.x ||
      pod.cell.y !== job.pickupCell.y
    ) {
      for (const pid of job.packageIds) {
        this.recordMisplacedIncident(
          'LOCATION_MISMATCH',
          pid,
          job.pickupCell,
          pod.cell,
          `Pickup location mismatch for job ${job.id}`,
          pod.id
        );
      }
      return false;
    }

    if (job.pickedUpPackageIds.length > 0 || job.status !== 'ASSIGNED') {
      this.ledger.appendEvent(
        this.state,
        'VALIDATION_ERROR',
        'REJECTED',
        `Duplicate pickup rejected for job ${job.id}`
      );
      return false;
    }

    let latestEpoch = job.epoch;
    for (const pkgId of job.packageIds) {
      const cas = this.ledger.compareAndSwap(this.state, {
        packageId: pkgId,
        expectedStates: ['ASSIGNED'],
        expectedOwner: robot.id,
        expectedEpoch: robot.assignedEpoch,
        nextState: 'PICKED',
        nextOwner: robot.id,
        cell: robot.cell,
        detail: `Picked up by ${robot.id} for ${job.id}`,
      });
      if (!cas.ok) return false;
      latestEpoch = cas.newEpoch;
    }

    pod.carriedByRobotId = robot.id;
    robot.carryingPodId = pod.id;
    robot.assignedEpoch = latestEpoch;
    job.epoch = latestEpoch;
    job.pickedUpPackageIds = [...job.packageIds];
    job.pickedUpAtTick = tick;
    job.status = 'PICKED_UP';
    robot.needsReplan = true;

    this.ledger.appendEvent(
      this.state,
      'PICKUP',
      'APPLIED',
      `Robot ${robot.id} picked up pod ${pod.id} [${job.packageIds.join(',')}] (epoch=${latestEpoch})`
    );
    return true;
  }

  attemptDrop(
    robot: Robot,
    job: Job,
    tick = this.state.tick,
    claimedEpoch?: number
  ): boolean {
    const epochToCheck = claimedEpoch ?? robot.assignedEpoch;
    const pod: Pod | undefined = this.state.pods[job.podId];

    if (!pod) {
      this.ledger.appendEvent(
        this.state,
        'VALIDATION_ERROR',
        'REJECTED',
        `Drop rejected for job ${job.id}: pod ${job.podId} missing`
      );
      return false;
    }

    if (robot.cell.x !== job.dropCell.x || robot.cell.y !== job.dropCell.y) {
      for (const pid of job.packageIds) {
        this.recordMisplacedIncident(
          'LOCATION_MISMATCH',
          pid,
          job.dropCell,
          robot.cell,
          `Drop location mismatch by ${robot.id} for job ${job.id}`,
          pod.id
        );
      }
      return false;
    }

    if (robot.carryingPodId !== job.podId || pod.carriedByRobotId !== robot.id) {
      for (const pid of job.packageIds) {
        this.recordMisplacedIncident(
          'MISPLACED',
          pid,
          job.dropCell,
          robot.cell,
          `Wrong pod ${robot.carryingPodId ?? 'none'} at drop for job ${job.id} (expected ${job.podId})`,
          job.podId
        );
      }
      return false;
    }

    if (job.status === 'COMPLETED' || job.deliveredPackageIds.length > 0) {
      this.ledger.appendEvent(
        this.state,
        'VALIDATION_ERROR',
        'REJECTED',
        `Duplicate delivery rejected for job ${job.id}`
      );
      return false;
    }

    let latestEpoch = epochToCheck;
    for (const pkgId of job.packageIds) {
      const cas = this.ledger.compareAndSwap(this.state, {
        packageId: pkgId,
        expectedStates: ['PICKED'],
        expectedOwner: robot.id,
        expectedEpoch: epochToCheck,
        nextState: 'DELIVERED',
        nextOwner: null,
        cell: job.dropCell,
        detail: `Delivered by ${robot.id} for ${job.id}`,
      });
      if (!cas.ok) return false;
      latestEpoch = cas.newEpoch;
    }

    pod.carriedByRobotId = null;
    pod.cell = { ...job.dropCell };
    robot.carryingPodId = null;
    robot.assignedJobId = null;
    robot.assignedEpoch = 0;
    robot.status = 'IDLE';
    robot.plan = [];
    robot.bufferedPlan = [];

    job.epoch = latestEpoch;
    job.deliveredPackageIds = [...job.packageIds];
    job.completedAtTick = tick;
    job.status = 'COMPLETED';

    this.ledger.appendEvent(
      this.state,
      'DROP',
      'APPLIED',
      `Robot ${robot.id} delivered pod ${pod.id} [${job.packageIds.join(',')}] (epoch=${latestEpoch})`
    );
    return true;
  }
}
