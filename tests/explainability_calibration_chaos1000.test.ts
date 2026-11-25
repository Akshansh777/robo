import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_DISCLAIMER,
  CellType,
  DEFAULT_SIMULATION_PROFILE,
  evaluateCalibration,
  fitCalibratedProfile,
  generateChaosCommands,
  SimulationEngine,
} from '../src/engine';

describe('Explainable Decision Timeline, Sim-to-Real Calibration & 1000 Chaos Seeds', () => {
  it('records explainable decision entries for battery rejection, human stop, and reproduces on replay', () => {
    const cells: CellType[][] = Array.from({ length: 5 }, () =>
      Array.from({ length: 7 }, (): CellType => 'floor')
    );
    cells[2]![1] = 'pickup';
    cells[2]![5] = 'drop';
    cells[0]![0] = 'charger';

    const sim = new SimulationEngine({
      seed: 1101,
      grid: { width: 7, height: 5, cells },
      profile: { batterySafetyReserve: 30, humanBufferRadius: 1 },
    });

    sim.dispatch({ type: 'REGISTER_PACKAGE', tick: 0, pkg: { id: 'P1', weight: 3, priority: 'HIGH' } });
    sim.dispatch({ type: 'REGISTER_POD', tick: 0, pod: { id: 'POD1', cell: { x: 1, y: 2 }, packageIds: ['P1'] } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R-LOW', cell: { x: 1, y: 2 }, battery: 12 } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R-OK', cell: { x: 0, y: 2 }, battery: 95 } });
    sim.dispatch({
      type: 'ADD_JOB',
      tick: 0,
      job: { id: 'J1', podId: 'POD1', packageIds: ['P1'], pickupCell: { x: 1, y: 2 }, dropCell: { x: 5, y: 2 } },
    });
    sim.dispatch({ type: 'ADD_HUMAN', tick: 2, human: { id: 'H1', cell: { x: 3, y: 2 } } });

    sim.stepMany(8);

    const decisions = sim.getDecisionTimeline();
    expect(decisions.some((d) => d.decision === 'BID_REJECTED_LOW_BATTERY')).toBe(true);
    expect(decisions.some((d) => d.category === 'HUMAN_SAFETY_STOP')).toBe(true);

    // Replay reproduces identical decision sequence and state hash
    const replayed = SimulationEngine.fromReplay(sim.exportReplay());
    replayed.stepMany(8);
    expect(replayed.stateHash()).toBe(sim.stateHash());
    expect(replayed.getDecisionTimeline().length).toBe(decisions.length);
  });

  it('calibrates simulation profile from offline observations and preserves calibration in replay', () => {
    const observations = [
      {
        id: 'obs-1',
        distanceCells: 10,
        payloadKg: 4,
        slowCellsCount: 2,
        observedTravelTicks: 16,
        observedBatteryDrainPct: 3.2,
        measuredFriction: 0.68,
      },
    ];

    const beforeReport = evaluateCalibration(DEFAULT_SIMULATION_PROFILE, observations);
    expect(beforeReport.disclaimer).toBe(CALIBRATION_DISCLAIMER);

    const calibrated = fitCalibratedProfile(DEFAULT_SIMULATION_PROFILE, observations);
    const afterReport = evaluateCalibration(calibrated, observations);
    expect(afterReport.meanAbsTravelTickError).toBeLessThan(beforeReport.meanAbsTravelTickError);

    const cells: CellType[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, (): CellType => 'floor')
    );
    const sim = new SimulationEngine({ seed: 1202, grid: { width: 4, height: 4, cells }, profile: calibrated });
    sim.setProfile(calibrated, observations);
    const bundle = sim.exportReplay();
    expect(bundle.calibrationObservations.length).toBe(1);
    expect(bundle.profile.name).toBe(calibrated.name);
  });

  it('runs 1000 chaos seeds within deterministic planner work budgets and zero invariant violations', () => {
    const cells: CellType[][] = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, (): CellType => 'floor')
    );
    cells[0]![0] = 'charger';
    cells[2]![2] = 'shelf';
    cells[5]![5] = 'bay';
    cells[1]![1] = 'pickup';
    cells[6]![6] = 'drop';
    const grid = { width: 8, height: 8, cells };

    for (let seed = 1; seed <= 1000; seed++) {
      const sim = new SimulationEngine({
        seed,
        grid,
        policy: {
          maxExpansions: 300,
          globalExpansionBudgetPerTick: 1200,
        },
      });

      sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R1', cell: { x: 1, y: 1 } } });
      sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R2', cell: { x: 6, y: 1 } } });
      sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R3', cell: { x: 1, y: 6 } } });

      const chaos = generateChaosCommands(grid, {
        seed,
        intensity: 0.7,
        durationTicks: 15,
        robotIds: ['R1', 'R2', 'R3'],
        pickupCells: [{ x: 1, y: 1 }],
        dropCells: [{ x: 6, y: 6 }],
      });
      for (const cmd of chaos) sim.dispatch(cmd);

      for (let t = 0; t < 15; t++) {
        sim.step();
        expect(sim.getState().plannerStats.expansionsThisTick).toBeLessThanOrEqual(1200);
        expect(sim.checkInvariants().ok).toBe(true);
      }
      expect(sim.verifyLedgerChain().valid).toBe(true);
    }
  }, 60_000);
});
