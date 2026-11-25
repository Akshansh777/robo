import { describe, expect, it } from 'vitest';
import { CellType, coordKey, SimulationEngine } from '../src/engine';
import { generateRandomScenario } from '../src/presets/maps';

describe('Navigation Safety & 1000 Random Seeded Scenarios', () => {
  it('never moves outside map boundaries or into blocked or occupied cells', () => {
    const cells: CellType[][] = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, (): CellType => 'floor')
    );
    const sim = new SimulationEngine({
      seed: 101,
      grid: { width: 5, height: 5, cells },
    });

    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R1', cell: { x: 0, y: 0 } } });
    sim.dispatch({ type: 'ADD_ROBOT', tick: 0, robot: { id: 'R2', cell: { x: 1, y: 0 } } });
    sim.dispatch({ type: 'BLOCK_CELL', tick: 0, cell: { x: 0, y: 1 } });

    sim.stepMany(15);
    const state = sim.getState();
    const blocked = new Set(state.blockedCells);

    for (const r of Object.values(state.robots)) {
      expect(r.cell.x).toBeGreaterThanOrEqual(0);
      expect(r.cell.y).toBeGreaterThanOrEqual(0);
      expect(r.cell.x).toBeLessThan(5);
      expect(r.cell.y).toBeLessThan(5);
      expect(blocked.has(coordKey(r.cell.x, r.cell.y))).toBe(false);
    }
  });

  it('runs 1000 random seeded scenarios with 2 to 20 robots with zero vertex or swap conflicts', () => {
    for (let scenario = 1; scenario <= 1000; scenario++) {
      const robotCount = 2 + (scenario % 19); // 2..20 robots
      const sim = generateRandomScenario(scenario * 7919, robotCount);
      const prevPos = new Map<string, { x: number; y: number }>();

      for (let tick = 0; tick < 25; tick++) {
        const before = sim.getState();
        for (const r of Object.values(before.robots)) {
          prevPos.set(r.id, { ...r.cell });
        }

        sim.step();

        const after = sim.getState();
        const robots = Object.values(after.robots);
        const blocked = new Set(after.blockedCells);
        const occupied = new Set<string>();

        for (const r of robots) {
          // Boundary & obstacle check
          expect(r.cell.x).toBeGreaterThanOrEqual(0);
          expect(r.cell.y).toBeGreaterThanOrEqual(0);
          expect(r.cell.x).toBeLessThan(after.grid.width);
          expect(r.cell.y).toBeLessThan(after.grid.height);
          const key = coordKey(r.cell.x, r.cell.y);
          expect(blocked.has(key)).toBe(false);

          // Vertex conflict check
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
        }

        // Edge-swap conflict check
        for (let i = 0; i < robots.length; i++) {
          for (let j = i + 1; j < robots.length; j++) {
            const a = robots[i]!;
            const b = robots[j]!;
            const prevA = prevPos.get(a.id)!;
            const prevB = prevPos.get(b.id)!;
            const swapped =
              a.cell.x === prevB.x &&
              a.cell.y === prevB.y &&
              b.cell.x === prevA.x &&
              b.cell.y === prevA.y;
            expect(swapped).toBe(false);
          }
        }
      }
    }
  }, 60_000);
});
