import {
  CopilotActionPlan,
  generateChaosCommands,
  generateLocalBottleneckPostMortem,
  Priority,
  runLocalCopilot,
  SimCommand,
  SimulationEngine,
} from '../engine';

const STORAGE_KEY = 'warehouse_arena_gemini_key';

export function getStoredGeminiApiKey(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredGeminiApiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota/privacy mode errors
  }
}

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'block_cells',
        description: 'Block one or more grid cells as runtime obstacles at a specific tick.',
        parameters: {
          type: 'OBJECT',
          properties: {
            cells: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  x: { type: 'INTEGER' },
                  y: { type: 'INTEGER' },
                },
                required: ['x', 'y'],
              },
            },
            delayTicks: { type: 'INTEGER', description: 'Ticks from now to execute' },
          },
          required: ['cells'],
        },
      },
      {
        name: 'fail_robot',
        description: 'Simulate a hardware failure on a specific robot ID at a given tick.',
        parameters: {
          type: 'OBJECT',
          properties: {
            robotId: { type: 'STRING' },
            delayTicks: { type: 'INTEGER' },
          },
          required: ['robotId'],
        },
      },
      {
        name: 'recover_robot',
        description: 'Recover a failed robot ID so it can resume bidding.',
        parameters: {
          type: 'OBJECT',
          properties: {
            robotId: { type: 'STRING' },
            delayTicks: { type: 'INTEGER' },
          },
          required: ['robotId'],
        },
      },
      {
        name: 'add_job',
        description: 'Dispatch a new delivery job between pickup and drop cells.',
        parameters: {
          type: 'OBJECT',
          properties: {
            pickupX: { type: 'INTEGER' },
            pickupY: { type: 'INTEGER' },
            dropX: { type: 'INTEGER' },
            dropY: { type: 'INTEGER' },
            priority: { type: 'STRING', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
            delayTicks: { type: 'INTEGER' },
          },
          required: ['pickupX', 'pickupY', 'dropX', 'dropY'],
        },
      },
      {
        name: 'set_policy',
        description: 'Update scheduler conflict resolution policy.',
        parameters: {
          type: 'OBJECT',
          properties: {
            conflictMode: { type: 'STRING', enum: ['PRIORITY_AGING', 'AUCTION_REBID'] },
            enableDynamicEdgePricing: { type: 'BOOLEAN' },
            enableDeadlockPrediction: { type: 'BOOLEAN' },
          },
        },
      },
      {
        name: 'set_chaos',
        description: 'Inject a reproducible seeded chaos disruption burst.',
        parameters: {
          type: 'OBJECT',
          properties: {
            intensity: { type: 'NUMBER', description: '0.1 to 1.0' },
            delayTicks: { type: 'INTEGER' },
          },
          required: ['intensity'],
        },
      },
    ],
  },
];

export async function executeFloorSupervisorPrompt(
  engine: SimulationEngine,
  prompt: string
): Promise<CopilotActionPlan> {
  const apiKey = getStoredGeminiApiKey();
  if (!apiKey) {
    return runLocalCopilot(engine, prompt);
  }

  const state = engine.getState();
  const compactContext = {
    tick: state.tick,
    gridSize: `${state.grid.width}x${state.grid.height}`,
    robots: Object.values(state.robots).map((r) => ({
      id: r.id,
      cell: r.cell,
      status: r.status,
      carrying: r.carryingPodId,
      battery: Math.round(r.battery),
    })),
    recentDecisions: state.decisionTimeline.slice(-6).map((d) => ({
      tick: d.tick,
      robotId: d.robotId,
      decision: d.decision,
      reason: d.reason,
    })),
  };

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: 'You are the Warehouse Floor Supervisor Copilot. Translate operator requests strictly into the provided simulation tool calls, or answer questions concisely from the supplied telemetry JSON. Never invent metrics.',
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `State context: ${JSON.stringify(compactContext)}\nOperator prompt: ${prompt}`,
                },
              ],
            },
          ],
          tools: GEMINI_TOOLS,
        }),
      }
    );
    window.clearTimeout(timeout);

    if (!response.ok) {
      return runLocalCopilot(engine, prompt);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const commands: SimCommand[] = [];
    const summaries: string[] = [];
    let textAnswer = '';

    for (const part of parts) {
      if (part.text) textAnswer += part.text;
      const fc = part.functionCall;
      if (!fc) continue;
      const args = fc.args ?? {};
      const delay = Math.max(0, Number(args.delayTicks ?? 0));
      const execTick = state.tick + delay;

      if (fc.name === 'block_cells' && Array.isArray(args.cells)) {
        for (const c of args.cells as Array<{ x: number; y: number }>) {
          commands.push({ type: 'BLOCK_CELL', tick: execTick, cell: { x: Number(c.x), y: Number(c.y) } });
        }
        summaries.push(`Block ${(args.cells as unknown[]).length} cell(s) at t=${execTick}`);
      } else if (fc.name === 'fail_robot' && typeof args.robotId === 'string') {
        commands.push({ type: 'FAIL_ROBOT', tick: execTick, robotId: args.robotId });
        summaries.push(`Fail ${args.robotId} at t=${execTick}`);
      } else if (fc.name === 'recover_robot' && typeof args.robotId === 'string') {
        commands.push({ type: 'RECOVER_ROBOT', tick: execTick, robotId: args.robotId });
        summaries.push(`Recover ${args.robotId} at t=${execTick}`);
      } else if (fc.name === 'add_job') {
        const idx = Object.keys(state.jobs).length + commands.length + 1;
        const prio = (args.priority as Priority) ?? 'NORMAL';
        const pkgId = `PKG-AI-${idx}`;
        const podId = `POD-AI-${idx}`;
        const jobId = `JOB-AI-${idx}`;
        const pickup = { x: Number(args.pickupX), y: Number(args.pickupY) };
        const drop = { x: Number(args.dropX), y: Number(args.dropY) };
        commands.push(
          { type: 'REGISTER_PACKAGE', tick: execTick, pkg: { id: pkgId, weight: 3, priority: prio } },
          { type: 'REGISTER_POD', tick: execTick, pod: { id: podId, cell: pickup, packageIds: [pkgId] } },
          {
            type: 'ADD_JOB',
            tick: execTick,
            job: { id: jobId, podId, packageIds: [pkgId], pickupCell: pickup, dropCell: drop, priority: prio },
          }
        );
        summaries.push(`Add ${prio} job ${jobId} at t=${execTick}`);
      } else if (fc.name === 'set_policy') {
        commands.push({
          type: 'SET_POLICY',
          tick: execTick,
          policy: {
            ...(args.conflictMode ? { conflictMode: args.conflictMode as 'PRIORITY_AGING' | 'AUCTION_REBID' } : {}),
            ...(typeof args.enableDynamicEdgePricing === 'boolean'
              ? { enableDynamicEdgePricing: args.enableDynamicEdgePricing }
              : {}),
            ...(typeof args.enableDeadlockPrediction === 'boolean'
              ? { enableDeadlockPrediction: args.enableDeadlockPrediction }
              : {}),
          },
        });
        summaries.push(`Update scheduler policy at t=${execTick}`);
      } else if (fc.name === 'set_chaos') {
        const intensity = Math.max(0.1, Math.min(1, Number(args.intensity ?? 0.5)));
        const generated = generateChaosCommands(state.grid, {
          seed: state.seed + state.tick,
          intensity,
          durationTicks: 20,
          robotIds: Object.keys(state.robots),
          pickupCells: [{ x: 1, y: 2 }],
          dropCells: [{ x: state.grid.width - 2, y: 2 }],
        });
        for (const c of generated) {
          commands.push({ ...c, tick: execTick + Math.max(0, c.tick - 2) });
        }
        summaries.push(`Inject chaos (${intensity}) at t=${execTick}`);
      }
    }

    if (commands.length === 0 && !textAnswer.trim()) {
      return runLocalCopilot(engine, prompt);
    }

    return {
      mode: 'AI',
      summary: summaries.length > 0 ? summaries.join('; ') : 'AI Supervisor response',
      commands,
      answer: textAnswer.trim() || undefined,
    };
  } catch {
    return runLocalCopilot(engine, prompt);
  }
}

export async function runRootCausePostMortem(
  engine: SimulationEngine
): Promise<{ mode: 'AI' | 'Local'; report: string }> {
  const apiKey = getStoredGeminiApiKey();
  const localReport = generateLocalBottleneckPostMortem(engine);

  if (!apiKey) {
    return { mode: 'Local', report: localReport };
  }

  const metrics = engine.getMetrics();
  const state = engine.getState();
  const payload = {
    tick: state.tick,
    jobsCompleted: metrics.jobsCompleted,
    throughputPer100Ticks: metrics.throughputPer100Ticks,
    avgWaitTime: metrics.avgWaitTime,
    p95WaitTime: metrics.p95WaitTime,
    congestionIndex: metrics.congestionIndex,
    predictedDeadlocksResolved: metrics.predictedDeadlocksResolved,
    reactiveDeadlocksResolved: metrics.reactiveDeadlocksResolved,
    custodySummary: Object.values(state.custody).map((c) => ({
      id: c.packageId,
      state: c.state,
      epoch: c.epoch,
      misplacedCount: c.misplacedCount,
    })),
    topWaitCells: Object.entries(metrics.cellWaitCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  };

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Provide a concise, plain-language root-cause bottleneck post-mortem based strictly on this warehouse telemetry JSON (do not invent numbers): ${JSON.stringify(
                    payload
                  )}`,
                },
              ],
            },
          ],
        }),
      }
    );
    window.clearTimeout(timeout);
    if (!res.ok) return { mode: 'Local', report: localReport };

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return { mode: 'Local', report: localReport };
    return { mode: 'AI', report: text };
  } catch {
    return { mode: 'Local', report: localReport };
  }
}
