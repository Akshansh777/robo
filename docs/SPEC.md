# Warehouse Robot Coordination Arena — Simulation Engine Specification (v0.3)

## 1. Architectural Overview & Purity Guarantee
- `src/engine` is 100% pure TypeScript with **zero** DOM, Web API, or wall-clock dependencies affecting simulation behavior.
- Wall-clock telemetry (`lastTickWallClockMs`) is recorded strictly as diagnostic metadata and is **excluded** from `stateHash()` so replay determinism is never perturbed by host CPU load.
- **Single Source of Truth**: `(seed, simulationProfile, calibrationInputs, commandLog)` uniquely determines every state hash, ledger chain, decision record, and metric at every tick $t \ge 0$.

---

## 2. Smart Coordination Layer

### 2.1 Deadlock Prediction & Preemptive Backtrack (`src/engine/deadlock.ts`)
- **Projected Wait-For Graph**: At each tick $t$, the engine projects current space-time reservations `lookaheadTicks` ahead (default `10` ticks). A directed edge $R_i \to R_j$ is added if $R_i$ requires a cell reserved or occupied by $R_j$ at $t + \Delta t$ ($\Delta t \in [1, \text{lookaheadTicks}]$) while $R_i$ is blocked or waiting.
- **Cycle Detection**: Deterministic Tarjan/DFS cycle finder identifies elementary directed cycles $(R_{c_1} \to R_{c_2} \to \dots \to R_{c_k} \to R_{c_1})$ **before** robots physically lock up.
- **Preemptive Backtrack**: When a future cycle is detected, the predictor scores each cycle member by `rerouteCost + reverseCost` (accounting for carried payload and remaining distance) and instructs the lowest-cost robot to yield/reverse into the nearest unreserved `bay` or passing pocket before the gridlock forms.
- **Reactive Fallback Recovery Ladder**: If an unpredicted stall cycle occurs (`stallTicks >= stallEscalationTicks`), the engine escalates deterministically:
  1. `1_YIELD_BAY`: Lowest-priority stalled robot yields to the nearest free `bay` or pocket.
  2. `2_LOCAL_GROUP_REPLAN`: Clears reservations exclusively for the deadlocked robot subset and replans them jointly in priority order.
  3. `3_BACKOUT_REBID`: Releases unpicked jobs in the stalled group back to the CNP auction pool and forces a physical back-out maneuver.
- Every prediction and ladder action is logged in `eventLog` and `decisionTimeline`.

### 2.2 Dynamic Edge Pricing (`enableDynamicEdgePricing`)
- Maintains a rolling occupancy window (`congestionWindowTicks`, default `15` ticks) per grid cell `(x, y)`.
- When `enableDynamicEdgePricing` is enabled, space-time A* adds a congestion surcharge `congestionWeight * rollingDensity(x, y)` to traversal edges, steering fleets around emerging aisle bottlenecks. Also fed into CNP bid evaluation and pickup staggering.

### 2.3 Uncertainty: `DEADZONE` & `SLOW` Cells
- **`DEADZONE` Cells**:
  - Robots inside a `deadzone` lose live coordinator updates (`inDeadzone = true`) and continue executing their last buffered trajectory (`bufferedPlan`) without receiving central replans until exiting the zone.
  - Because live coordination is degraded, robots in a `deadzone` broadcast a **wider safety halo** (reserving 2 cells ahead along their trajectory instead of 1).
- **`SLOW` Cells**:
  - Halve effective velocity (`0.5x`). Space-time A* explicitly prices the extra traversal ticks (`slowPenalty`), weighing crawling through against detouring around open `floor` aisles.

---

## 3. Scaling, Computation Budgets & Caching
- **Dual Budgets**:
  1. Per-search cap: `maxExpansions` (default `4000`, tunable down to `400` for 100-robot fleets).
  2. Global per-tick work budget: `globalExpansionBudgetPerTick` (default `25000`).
- **Fair Deferral & Safety**: A deterministic round-robin cursor (`planningCursor`) ensures that if `globalExpansionBudgetPerTick` is exhausted mid-tick, remaining robots are deferred fairly (`deferredRequests++`, `planningBacklog`) and remain safely stopped (`WAIT`) or continue on already-verified conflict-free reservations—never bypassing proximity, human-buffer, or collision checks.
- **Spatial Indexing & Path Cache**:
  - Robots are indexed in a 2D spatial hash grid (`SpatialGridIndex`) for $O(1)$ neighborhood proximity queries.
  - Static/uncongested single-agent shortest paths are cached by `(gridRevision, start, goal, slowCost)` in a bounded deterministic LRU cache (`pathCache`) and invalidated automatically on `gridRevision` changes.

---

## 4. Explainable Decision Timeline (`decisionTimeline`)
- Bounded ring buffer (`maxDecisionHistory`, default `500` records) capturing deterministic `DecisionRecord` entries across:
  - `ASSIGNMENT`, `PRIORITY_CHANGE`, `ROUTE_SELECTION`, `WAITING`, `CONGESTION_AVOIDANCE`, `BATTERY_CHARGING`, `HUMAN_SAFETY_STOP`, `PACKAGE_MISMATCH`, `REPLANNING`, and `FAILURE_RECOVERY`.
- Each record links `robotId`, `jobId`, `packageId`, and `commandSeq`, capturing `inputs`, `alternativesRejected`, and a concise human-readable `reason`.

---

## 5. Seeded Chaos, Time Travel, A/B Runner & Sim-to-Real Calibration
- **Seeded Chaos Generator (`generateChaosCommands`)**: Deterministically emits `FAIL_ROBOT`, `RECOVER_ROBOT`, `BLOCK_CELL`, `UNBLOCK_CELL`, `PAINT_CELL` (`deadzone`), and job bursts from `(seed, intensity)` into the normal `SimCommand` log.
- **Time Travel (`rewindTo(tick)`, `branchFrom(tick, newPolicy)`)**:
  - Full state snapshots (including PRNG state, ledger, metrics, calibration inputs, and decision timeline) are captured every `snapshotIntervalTicks` (default `10`).
  - `rewindTo(tick)` restores the nearest prior snapshot and deterministically replays commands up to `tick`.
  - `branchFrom(tick, newPolicy)` clones the timeline at `tick`, applies `newPolicy`, and returns an independent `SimulationEngine` instance for counterfactual comparison.
- **A/B Policy Runner (`runABComparison`)**: Runs two engine instances on the identical command stream and chaos seed under `policyA` and `policyB`, producing aligned per-tick KPI series (`throughput`, `avgPickupDelay`, `p95PickupDelay`, `congestionScore`, `deadlocks`, `expansions`).
- **Simulation-to-Reality Calibration (`src/engine/calibration.ts`)**:
  - Imports offline measured observations (`friction`, `travelTimeTicks`, `payloadKg`, `batteryDrainPct`) and compares them against simulated predictions under the active `SimulationProfile`.
  - Generates a calibrated `SimulationProfile` and preserves both observations and profile in snapshots and replay bundles.
  - *Disclaimer*: Calibration tunes parameters of this simplified discrete-time simulator; it does not certify or guarantee identical physical robot behavior in real-world deployments.
