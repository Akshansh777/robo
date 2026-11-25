import { describe, expect, it } from 'vitest';
import { CellType, createPRNG, SimulationEngine } from '../src/engine';

describe('Property Test: 2000 Random Chaos Runs', () => {
  it('maintains 0 custody invariant violations and valid ledger hash chain across 2000 chaos runs', () => {
    for (let run = 1; run <= 2000; run++) {
      const rng = createPRNG(run * 104729);
      const width = 10;
      const height = 8;
      const cells: CellType[][] = Array.from({ length: height }, () =>
        Array.from({ length: width }, (): CellType => 'floor')
      );
      cells[0]![0] = 'charger';
      cells[0]![width - 1] = 'charger';
      cells[2]![3] = 'shelf';
      cells[2]![6] = 'shelf';
      cells[5]![3] = 'bay';
      cells[5]![6] = 'bay';

      const sim = new SimulationEngine({
        seed: run,
        grid: { width, height, cells },
        profile: { sensorNoise: 0.03 },
      });

      const robotCount = 2 + (run % 5);
      for (let r = 0; r < robotCount; r++) {
        sim.dispatch({
          type: 'ADD_ROBOT',
          tick: 0,
          robot: { id: `R${r}`, cell: { x: r + 1, y: 1 } },
        });
      }

      // Inject random jobs, blocks, humans, and robot failures
      const jobCount = 2 + (run % 4);
      for (let j = 0; j < jobCount; j++) {
        const injectTick = rng.nextInt(0, 8);
        const px = 1 + rng.nextInt(0, width - 2);
        const py = 3 + (j % 4);
        const dx = 1 + rng.nextInt(0, width - 2);
        const dy = height - 1;
        cells[py]![px] = 'pickup';
        cells[dy]![dx] = 'drop';

        const pkgId = `PKG-${run}-${j}`;
        const podId = `POD-${run}-${j}`;
        sim.dispatch({
          type: 'REGISTER_PACKAGE',
          tick: injectTick,
          pkg: { id: pkgId, weight: 1 + (j % 4), priority: j === 0 ? 'URGENT' : 'NORMAL' },
        });
        sim.dispatch({
          type: 'REGISTER_POD',
          tick: injectTick,
          pod: { id: podId, cell: { x: px, y: py }, packageIds: [pkgId] },
        });
        sim.dispatch({
          type: 'ADD_JOB',
          tick: injectTick,
          job: {
            id: `JOB-${run}-${j}`,
            podId,
            packageIds: [pkgId],
            pickupCell: { x: px, y: py },
            dropCell: { x: dx, y: dy },
            priority: j === 0 ? 'URGENT' : 'NORMAL',
          },
        });
      }

      // Random block/unblock, human movement, and carrier failure
      const bx = 4;
      const by = 4;
      sim.dispatch({ type: 'BLOCK_CELL', tick: 4, cell: { x: bx, y: by } });
      sim.dispatch({ type: 'UNBLOCK_CELL', tick: 11, cell: { x: bx, y: by } });
      sim.dispatch({ type: 'ADD_HUMAN', tick: 3, human: { id: 'H1', cell: { x: 7, y: 4 } } });
      sim.dispatch({ type: 'MOVE_HUMAN', tick: 7, humanId: 'H1', cell: { x: 8, y: 4 } });
      sim.dispatch({ type: 'REMOVE_HUMAN', tick: 12, humanId: 'H1' });

      const victimId = `R${run % robotCount}`;
      sim.dispatch({ type: 'FAIL_ROBOT', tick: 6, robotId: victimId });
      sim.dispatch({ type: 'RECOVER_ROBOT', tick: 14, robotId: victimId });

      for (let t = 0; t < 20; t++) {
        sim.step();
        const inv = sim.checkInvariants();
        if (!inv.ok) {
          throw new Error(`Run ${run} tick ${t} violated invariants: ${inv.violations.join('; ')}`);
        }
      }

      expect(sim.verifyLedgerChain().valid).toBe(true);
    }
  }, 60_000);
});
