import { describe, expect, it } from 'vitest';
import { createCorridorBypassScenario } from '../src/presets/maps';

describe('1-Cell-Wide Corridor Head-On Passing Bay', () => {
  it('resolves two robots meeting head-on using the nearby passing bay with zero collisions', () => {
    const sim = createCorridorBypassScenario(42);
    const prevPos = new Map<string, { x: number; y: number }>();

    for (let tick = 0; tick < 80; tick++) {
      const before = sim.getState();
      for (const r of Object.values(before.robots)) {
        prevPos.set(r.id, { ...r.cell });
      }

      sim.step();

      const after = sim.getState();
      const robots = Object.values(after.robots);

      // Zero vertex conflicts
      const occupied = new Set<string>();
      for (const r of robots) {
        const key = `${r.cell.x},${r.cell.y}`;
        expect(occupied.has(key)).toBe(false);
        occupied.add(key);
      }

      // Zero edge-swap conflicts
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

    const finalState = sim.getState();
    expect(finalState.jobs['job-east']?.status).toBe('COMPLETED');
    expect(finalState.jobs['job-west']?.status).toBe('COMPLETED');
  });
});
