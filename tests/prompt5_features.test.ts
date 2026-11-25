import { describe, expect, it } from 'vitest';
import {
  evaluateLayoutOptimization,
  proposeLayoutEdits,
  runInAppSelfTests,
  runLocalCopilot,
} from '../src/engine';
import { createPresetEngine } from '../src/presets/maps';
import { mapPointToCalibratedGrid } from '../src/vision/arucoTracker';

describe('Prompt 5: Local Copilot, Auto-Optimize Layout, ArUco Mapping & In-App Self-Tests', () => {
  it('runs the full in-app self-test suite and passes every check', () => {
    const report = runInAppSelfTests();
    expect(report.allPassed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('parses natural-language supervisor commands locally and answers operational questions from telemetry', () => {
    const sim = createPresetEngine('kiva-grid');
    sim.stepMany(6);

    const plan = runLocalCopilot(
      sim,
      'block aisle 6 and fail the busiest robot in 5 seconds',
      5
    );
    expect(plan.mode).toBe('Local');
    expect(plan.commands.some((c) => c.type === 'BLOCK_CELL')).toBe(true);
    expect(plan.commands.some((c) => c.type === 'FAIL_ROBOT')).toBe(true);

    for (const cmd of plan.commands) sim.dispatch(cmd);
    sim.stepMany(30);

    const whyWait = runLocalCopilot(sim, 'Why is R-01 waiting?');
    expect(whyWait.mode).toBe('Local');
    expect(whyWait.answer && whyWait.answer.length > 10).toBe(true);

    const postMortem = runLocalCopilot(sim, 'What caused the bottleneck?');
    expect(postMortem.answer).toContain('Local Post-Mortem');
  });

  it('proposes congestion-driven layout edits and measures real before/after KPI diffs', () => {
    const sim = createPresetEngine('narrow-aisle');
    sim.stepMany(35);

    const proposals = proposeLayoutEdits(sim);
    expect(proposals.length).toBeGreaterThan(0);

    const comparison = evaluateLayoutOptimization(sim, proposals, 35);
    expect(comparison.baseline.invariantOk).toBe(true);
    expect(comparison.optimized.invariantOk).toBe(true);
    expect(typeof comparison.deltas.throughputDelta).toBe('number');
  });

  it('maps ArUco marker coordinates inside a 4-corner calibrated quadrilateral onto grid cells', () => {
    const corners = [
      { x: 10, y: 10 },
      { x: 210, y: 10 },
      { x: 210, y: 110 },
      { x: 10, y: 110 },
    ];
    const centerCell = mapPointToCalibratedGrid({ x: 110, y: 60 }, corners, 20, 10);
    expect(centerCell).toEqual({ x: 10, y: 5 });

    const outside = mapPointToCalibratedGrid({ x: 280, y: 200 }, corners, 20, 10);
    expect(outside).toBeNull();
  });
});
