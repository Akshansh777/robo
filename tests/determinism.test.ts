import { describe, expect, it } from 'vitest';
import {
  exportProfileJSON,
  importProfileJSON,
  SimulationEngine,
} from '../src/engine';
import { createDemoWarehouseScenario } from '../src/presets/maps';

describe('Determinism & Simulation Profile Replay', () => {
  it('produces byte-identical stateHash() at every tick for identical seed, profile, and commands', () => {
    const runWithTrace = () => {
      const sim = createDemoWarehouseScenario(2026);
      sim.dispatch({ type: 'BLOCK_CELL', tick: 6, cell: { x: 5, y: 5 } });
      sim.dispatch({ type: 'UNBLOCK_CELL', tick: 14, cell: { x: 5, y: 5 } });
      sim.dispatch({ type: 'FAIL_ROBOT', tick: 10, robotId: 'BOT-04' });
      sim.dispatch({ type: 'RECOVER_ROBOT', tick: 18, robotId: 'BOT-04' });

      const hashes: string[] = [sim.stateHash()];
      for (let t = 0; t < 60; t++) {
        sim.step();
        hashes.push(sim.stateHash());
      }
      return { sim, hashes };
    };

    const runA = runWithTrace();
    const runB = runWithTrace();

    expect(runA.hashes).toEqual(runB.hashes);

    // Replay bundle roundtrip also produces identical final state hash
    const replayed = SimulationEngine.fromReplay(runA.sim.exportReplay());
    replayed.stepMany(60);
    expect(replayed.stateHash()).toBe(runA.sim.stateHash());
  });

  it('records simulation profile in state/replay and supports offline profile import', () => {
    const sim = createDemoWarehouseScenario(99);
    const json = exportProfileJSON({
      ...sim.getState().profile,
      name: 'measured-concrete-floor',
      groundFriction: 0.72,
      sensorRange: 4,
    });

    const imported = importProfileJSON(json);
    expect(imported.name).toBe('measured-concrete-floor');
    expect(imported.groundFriction).toBe(0.72);
    expect(imported.sensorRange).toBe(4);

    const replay = sim.exportReplay();
    expect(replay.profile.name).toBe('standard-warehouse-v1');
  });
});
