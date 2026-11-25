import { describe, expect, it } from 'vitest';
import {
  exportProfileJSON,
  fitCalibratedProfile,
  generateChaosCommands,
  importProfileJSON,
} from '../src/engine';
import {
  createPresetEngine,
  PRESET_CATALOG,
} from '../src/presets/maps';
import { explainRobotPlainLanguage } from '../src/ui/explainability';

describe('Prompt 4 Control Wiring, Presets, Explainability & Profile Integration', () => {
  it('loads all 4 presets cleanly and advances without invariant violations', () => {
    for (const meta of PRESET_CATALOG) {
      const sim = createPresetEngine(meta.id);
      sim.stepMany(15);
      expect(sim.checkInvariants().ok).toBe(true);
      expect(sim.verifyLedgerChain().valid).toBe(true);
    }
  });

  it('wires map painting, blocking, robot failure/recovery, simulated humans, and job creation via command bus', () => {
    const sim = createPresetEngine('kiva-grid');

    // Paint cell & block/unblock
    sim.dispatch({ type: 'PAINT_CELL', tick: 0, cell: { x: 6, y: 5 }, cellType: 'bay' });
    sim.dispatch({ type: 'BLOCK_CELL', tick: 1, cell: { x: 10, y: 5 } });
    sim.dispatch({ type: 'UNBLOCK_CELL', tick: 4, cell: { x: 10, y: 5 } });

    // Simulated human add, move, remove
    sim.dispatch({ type: 'ADD_HUMAN', tick: 1, human: { id: 'H-TEST', cell: { x: 5, y: 5 } } });
    sim.dispatch({ type: 'MOVE_HUMAN', tick: 3, humanId: 'H-TEST', cell: { x: 6, y: 5 } });
    sim.dispatch({ type: 'REMOVE_HUMAN', tick: 6, humanId: 'H-TEST' });

    // Add high-priority custom job
    sim.dispatch({
      type: 'REGISTER_PACKAGE',
      tick: 2,
      pkg: { id: 'PKG-CUSTOM', weight: 3, priority: 'URGENT' },
    });
    sim.dispatch({
      type: 'REGISTER_POD',
      tick: 2,
      pod: { id: 'POD-CUSTOM', cell: { x: 1, y: 2 }, packageIds: ['PKG-CUSTOM'] },
    });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 2,
      job: {
        id: 'JOB-CUSTOM',
        podId: 'POD-CUSTOM',
        packageIds: ['PKG-CUSTOM'],
        pickupCell: { x: 1, y: 2 },
        dropCell: { x: 18, y: 10 },
        priority: 'URGENT',
      },
    });

    // Fail and recover a robot
    sim.dispatch({ type: 'FAIL_ROBOT', tick: 5, robotId: 'R-02' });
    sim.dispatch({ type: 'RECOVER_ROBOT', tick: 9, robotId: 'R-02' });

    sim.stepMany(15);

    const state = sim.getState();
    expect(state.jobs['JOB-CUSTOM']).toBeDefined();
    expect(explainRobotPlainLanguage(state, 'R-01').length).toBeGreaterThan(10);
    expect(sim.checkInvariants().ok).toBe(true);
    expect(sim.verifyLedgerChain().valid).toBe(true);
  });

  it('supports time-travel rewind, policy branching, and offline profile JSON roundtrip', () => {
    const sim = createPresetEngine('narrow-aisle');
    const chaos = generateChaosCommands(sim.getState().grid, {
      seed: 42,
      intensity: 0.5,
      durationTicks: 15,
      robotIds: ['R-01', 'R-02'],
      pickupCells: [{ x: 1, y: 2 }],
      dropCells: [{ x: 13, y: 2 }],
    });
    for (const c of chaos) sim.dispatch(c);

    sim.stepMany(12);
    const hashAt12 = sim.stateHash();

    const branch = sim.branchFrom(6, { conflictMode: 'AUCTION_REBID' });
    branch.stepMany(6);
    expect(branch.checkInvariants().ok).toBe(true);

    sim.rewindTo(6);
    sim.stepMany(6);
    expect(sim.stateHash()).toBe(hashAt12);

    // Offline profile JSON import/export & calibration
    const obs = [
      {
        id: 'obs-ui',
        distanceCells: 10,
        payloadKg: 3,
        slowCellsCount: 1,
        observedTravelTicks: 14,
        observedBatteryDrainPct: 2.5,
        measuredFriction: 0.8,
      },
    ];
    const fitted = fitCalibratedProfile(sim.getState().profile, obs);
    const roundtripped = importProfileJSON(exportProfileJSON(fitted));
    sim.setProfile(roundtripped, obs);
    expect(sim.getState().profile.name).toBe(fitted.name);
  });
});
