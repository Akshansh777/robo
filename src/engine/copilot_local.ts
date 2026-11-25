import { generateChaosCommands } from './chaos';
import { SimulationEngine } from './engine';
import {
  ConflictPolicyMode,
  Coord,
  Priority,
  SimCommand,
  SimState,
} from './types';

export interface CopilotActionPlan {
  mode: 'AI' | 'Local';
  summary: string;
  commands: SimCommand[];
  answer?: string;
}

/**
 * Deterministic local natural-language command & Q&A interpreter.
 * Maps supervisor phrasing to valid SimCommands or answers operational questions
 * strictly from recorded DecisionTimeline entries and telemetry.
 */
export function runLocalCopilot(
  engine: SimulationEngine,
  prompt: string,
  ticksPerSecond = 5
): CopilotActionPlan {
  const state = engine.getState();
  const text = prompt.trim();
  const lower = text.toLowerCase();

  // Check if user is asking an operational "why" / status question
  if (
    lower.endsWith('?') ||
    lower.startsWith('why') ||
    lower.startsWith('what') ||
    lower.startsWith('how') ||
    lower.includes('explain')
  ) {
    return {
      mode: 'Local',
      summary: 'Answered from recorded decision timeline and telemetry',
      commands: [],
      answer: answerLocalQuestion(engine, text),
    };
  }

  const commands: SimCommand[] = [];
  const actions: string[] = [];

  // Parse optional time delay ("in 5 seconds" or "in 10 ticks")
  let delayTicks = 0;
  const secMatch = lower.match(/in\s+(\d+)\s*s(?:ec(?:ond)?s?)?/);
  const tickMatch = lower.match(/in\s+(\d+)\s*t(?:ick)?s?/);
  if (secMatch) {
    delayTicks = Math.max(1, Number(secMatch[1]) * ticksPerSecond);
  } else if (tickMatch) {
    delayTicks = Math.max(1, Number(tickMatch[1]));
  }
  const targetTick = state.tick + delayTicks;

  // 1. Block / Unblock aisle or cell ("block aisle 3", "block cell 4,5", "unblock aisle 3")
  const unblockMatch = lower.match(/unblock\s+(?:aisle|col(?:umn)?|cell)?\s*(\d+)(?:\s*,\s*(\d+))?/);
  const blockMatch = !unblockMatch
    ? lower.match(/block\s+(?:aisle|col(?:umn)?|cell)?\s*(\d+)(?:\s*,\s*(\d+))?/)
    : null;

  if (unblockMatch) {
    const x = Math.min(state.grid.width - 1, Math.max(0, Number(unblockMatch[1])));
    if (unblockMatch[2] !== undefined) {
      const y = Math.min(state.grid.height - 1, Math.max(0, Number(unblockMatch[2])));
      commands.push({ type: 'UNBLOCK_CELL', tick: targetTick, cell: { x, y } });
      actions.push(`Unblock (${x},${y}) at tick ${targetTick}`);
    } else {
      for (let y = 1; y < state.grid.height - 1; y++) {
        if (state.grid.cells[y]![x] === 'floor') {
          commands.push({ type: 'UNBLOCK_CELL', tick: targetTick, cell: { x, y } });
        }
      }
      actions.push(`Unblock aisle x=${x} at tick ${targetTick}`);
    }
  } else if (blockMatch) {
    const x = Math.min(state.grid.width - 1, Math.max(0, Number(blockMatch[1])));
    if (blockMatch[2] !== undefined) {
      const y = Math.min(state.grid.height - 1, Math.max(0, Number(blockMatch[2])));
      commands.push({ type: 'BLOCK_CELL', tick: targetTick, cell: { x, y } });
      actions.push(`Block (${x},${y}) at tick ${targetTick}`);
    } else {
      let blockedCount = 0;
      for (let y = 1; y < state.grid.height - 1; y++) {
        if (state.grid.cells[y]![x] === 'floor' && blockedCount < 3) {
          commands.push({ type: 'BLOCK_CELL', tick: targetTick, cell: { x, y } });
          blockedCount++;
        }
      }
      actions.push(`Block ${blockedCount} cells on aisle x=${x} at tick ${targetTick}`);
    }
  }

  // 2. Fail / Recover robot ("fail the busiest robot", "fail robot R-01", "recover R-01")
  const recoverMatch = text.match(/recover\s+(?:robot\s+)?([A-Za-z0-9_-]+)/i);
  if (recoverMatch) {
    const rid = recoverMatch[1]!.toUpperCase();
    commands.push({ type: 'RECOVER_ROBOT', tick: targetTick, robotId: rid });
    actions.push(`Recover ${rid} at tick ${targetTick}`);
  } else if (lower.includes('fail') || lower.includes('kill')) {
    const explicitBot = text.match(/(?:fail|kill)\s+(?:robot\s+)?([A-Za-z0-9_-]+)/i);
    let chosenId: string | null = null;
    if (
      explicitBot &&
      explicitBot[1] &&
      !['the', 'busiest', 'a', 'robot'].includes(explicitBot[1].toLowerCase())
    ) {
      chosenId = explicitBot[1].toUpperCase();
    } else {
      // Pick busiest operational robot (carrying pod > assigned job > longest remaining plan)
      const candidates = Object.values(state.robots)
        .filter((r) => r.status !== 'FAILED')
        .sort((a, b) => {
          const scoreA = (a.carryingPodId ? 100 : 0) + (a.assignedJobId ? 50 : 0) + a.plan.length;
          const scoreB = (b.carryingPodId ? 100 : 0) + (b.assignedJobId ? 50 : 0) + b.plan.length;
          return scoreB - scoreA || a.id.localeCompare(b.id);
        });
      chosenId = candidates[0]?.id ?? null;
    }
    if (chosenId) {
      commands.push({ type: 'FAIL_ROBOT', tick: targetTick, robotId: chosenId });
      actions.push(`Fail robot ${chosenId} at tick ${targetTick}`);
    }
  }

  // 3. Add urgent/high/normal job ("add urgent job", "dispatch job")
  if (lower.includes('add job') || lower.includes('new job') || lower.includes('urgent job')) {
    const pickups: Coord[] = [];
    const drops: Coord[] = [];
    for (let y = 0; y < state.grid.height; y++) {
      for (let x = 0; x < state.grid.width; x++) {
        if (state.grid.cells[y]![x] === 'pickup') pickups.push({ x, y });
        if (state.grid.cells[y]![x] === 'drop') drops.push({ x, y });
      }
    }
    if (pickups.length > 0 && drops.length > 0) {
      const idx = Object.keys(state.jobs).length + 1;
      const prio: Priority = lower.includes('urgent')
        ? 'URGENT'
        : lower.includes('high')
        ? 'HIGH'
        : 'NORMAL';
      const p = pickups[idx % pickups.length]!;
      const d = drops[idx % drops.length]!;
      const pkgId = `PKG-COP-${idx}`;
      const podId = `POD-COP-${idx}`;
      const jobId = `JOB-COP-${idx}`;
      commands.push(
        { type: 'REGISTER_PACKAGE', tick: targetTick, pkg: { id: pkgId, weight: 3, priority: prio } },
        { type: 'REGISTER_POD', tick: targetTick, pod: { id: podId, cell: p, packageIds: [pkgId] } },
        {
          type: 'ADD_JOB',
          tick: targetTick,
          job: { id: jobId, podId, packageIds: [pkgId], pickupCell: p, dropCell: d, priority: prio },
        }
      );
      actions.push(`Add ${prio} job ${jobId} at tick ${targetTick}`);
    }
  }

  // 4. Policy switch ("set policy auction", "use priority aging")
  if (lower.includes('policy') || lower.includes('auction') || lower.includes('aging')) {
    const mode: ConflictPolicyMode = lower.includes('auction')
      ? 'AUCTION_REBID'
      : 'PRIORITY_AGING';
    commands.push({ type: 'SET_POLICY', tick: targetTick, policy: { conflictMode: mode } });
    actions.push(`Set conflict policy to ${mode} at tick ${targetTick}`);
  }

  // 5. Chaos burst ("chaos 0.6" or "inject chaos")
  if (lower.includes('chaos')) {
    const numMatch = lower.match(/chaos\s*(?:intensity)?\s*(0?\.\d+|1(?:\.0)?|\d+%)/);
    let intensity = 0.5;
    if (numMatch) {
      const raw = numMatch[1]!;
      intensity = raw.endsWith('%') ? Number(raw.replace('%', '')) / 100 : Number(raw);
    }
    const pickups: Coord[] = [];
    const drops: Coord[] = [];
    for (let y = 0; y < state.grid.height; y++) {
      for (let x = 0; x < state.grid.width; x++) {
        if (state.grid.cells[y]![x] === 'pickup') pickups.push({ x, y });
        if (state.grid.cells[y]![x] === 'drop') drops.push({ x, y });
      }
    }
    const chaosCmds = generateChaosCommands(state.grid, {
      seed: state.seed + state.tick,
      intensity,
      durationTicks: 20,
      robotIds: Object.keys(state.robots),
      pickupCells: pickups,
      dropCells: drops,
    });
    for (const c of chaosCmds) {
      commands.push({ ...c, tick: targetTick + Math.max(0, c.tick - 2) });
    }
    actions.push(`Inject seeded chaos (intensity=${intensity.toFixed(2)}) at tick ${targetTick}`);
  }

  if (commands.length === 0) {
    return {
      mode: 'Local',
      summary: 'No matching local command rule',
      commands: [],
      answer:
        'Try commands like: "block aisle 3 and fail the busiest robot in 5 seconds", "add urgent job", "set policy auction", or ask "Why is this robot waiting?"',
    };
  }

  return {
    mode: 'Local',
    summary: actions.join('; '),
    commands,
  };
}

/**
 * Answers common operational questions strictly from recorded DecisionTimeline entries and telemetry.
 * Refuses to invent reasons when no supporting record exists.
 */
export function answerLocalQuestion(
  engine: SimulationEngine,
  question: string,
  selectedRobotId?: string | null
): string {
  const state: SimState = engine.getState();
  const timeline = [...state.decisionTimeline].reverse();
  const lower = question.toLowerCase();

  // Extract explicit robot/job ID if mentioned
  const idMatch = question.match(/\b([A-Za-z]+-\d+)\b/);
  const targetId = idMatch ? idMatch[1]!.toUpperCase() : selectedRobotId ?? undefined;

  if (lower.includes('wait')) {
    const rec = timeline.find(
      (d) =>
        (!targetId || d.robotId === targetId || d.jobId === targetId) &&
        (d.category === 'CONGESTION_AVOIDANCE' ||
          d.category === 'PRIORITY_CHANGE' ||
          d.category === 'WAITING')
    );
    if (rec) {
      return `At tick ${rec.tick}, ${rec.robotId ?? 'the unit'} executed ${rec.decision}: ${rec.reason}`;
    }
    if (targetId && state.robots[targetId]) {
      const r = state.robots[targetId]!;
      return `${r.id} has stallTicks=${r.stallTicks} and status=${r.status}. No congestion-hold decision record is present in the retained timeline window.`;
    }
    return 'Recorded telemetry does not establish a specific waiting event in the current decision timeline window.';
  }

  if (lower.includes('reassign')) {
    const rec = timeline.find(
      (d) =>
        (!targetId || d.jobId === targetId || d.robotId === targetId) &&
        (d.decision.includes('RELEASE') ||
          d.category === 'FAILURE_RECOVERY' ||
          d.category === 'BATTERY_CHARGING')
    );
    if (rec) {
      return `Reassignment recorded at tick ${rec.tick}: ${rec.reason}`;
    }
    const logEv = [...state.eventLog].reverse().find((e) => e.kind === 'REASSIGN');
    if (logEv) {
      return `Ledger event #${logEv.seq} at tick ${logEv.tick}: ${logEv.detail}`;
    }
    return 'No job reassignment event is recorded in the current timeline or ledger.';
  }

  if (lower.includes('pickup') || lower.includes('delay')) {
    const stagger = timeline.find((d) => d.decision === 'STAGGER_DISPATCH');
    if (stagger) {
      return `Pickup dispatch was staggered at tick ${stagger.tick}: ${stagger.reason}`;
    }
    const m = engine.getMetrics();
    return `Current pickup delay averages: URGENT=${m.pickupDelayByPriority.URGENT.avgPickupDelay.toFixed(1)}t, HIGH=${m.pickupDelayByPriority.HIGH.avgPickupDelay.toFixed(1)}t, NORMAL=${m.pickupDelayByPriority.NORMAL.avgPickupDelay.toFixed(1)}t, LOW=${m.pickupDelayByPriority.LOW.avgPickupDelay.toFixed(1)}t.`;
  }

  if (lower.includes('stop') || lower.includes('human') || lower.includes('safety')) {
    const stopRec = timeline.find(
      (d) =>
        (!targetId || d.robotId === targetId) &&
        d.category === 'HUMAN_SAFETY_STOP'
    );
    if (stopRec) {
      return `Safety stop at tick ${stopRec.tick} for ${stopRec.robotId}: ${stopRec.reason}`;
    }
    return 'No simulated human or proximity safety stop is recorded in the retained decision timeline.';
  }

  return generateLocalBottleneckPostMortem(engine);
}

/**
 * Deterministic local root-cause bottleneck analyzer using heatmap occupancy,
 * wait counts, wait-for deadlock events, and custody ledger metrics.
 */
export function generateLocalBottleneckPostMortem(engine: SimulationEngine): string {
  const state = engine.getState();
  const metrics = engine.getMetrics();

  // Identify hottest wait cell
  let hotspotKey = 'none';
  let maxWaits = 0;
  for (const [k, count] of Object.entries(metrics.cellWaitCounts)) {
    if (count > maxWaits) {
      maxWaits = count;
      hotspotKey = k;
    }
  }

  const latestDeadlock =
    state.deadlockEvents.length > 0
      ? state.deadlockEvents[state.deadlockEvents.length - 1]
      : undefined;

  const lines: string[] = [
    `Local Post-Mortem (Tick ${state.tick}, Seed ${state.seed}):`,
    `- Throughput: ${metrics.jobsCompleted} completed (${metrics.throughputPer100Ticks.toFixed(1)} jobs/100t), Avg Wait: ${metrics.avgWaitTime.toFixed(1)}t (p95: ${metrics.p95WaitTime.toFixed(0)}t).`,
    `- Primary Congestion Hotspot: cell (${hotspotKey}) accumulated ${maxWaits} robot wait-ticks (overall congestion index ${(metrics.congestionIndex * 100).toFixed(1)}%).`,
    `- Deadlock Prevention: ${metrics.predictedDeadlocksResolved} cycles preemptively resolved via wait-for graph; ${metrics.reactiveDeadlocksResolved} reactive recoveries.`,
    `- Custody & Incidents: ${metrics.failureCount} robot failures, ${metrics.reassignmentCount} reassignments, ${metrics.misplacedIncidents} package mismatches, ${metrics.safetyStops} safety stops.`,
  ];

  if (latestDeadlock) {
    lines.push(`- Most Recent Cycle Event: ${latestDeadlock.reason}`);
  }

  return lines.join('\n');
}
