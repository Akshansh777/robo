import { describe, expect, it } from 'vitest';
import {
  CellType,
  planSpaceTimePath,
  ReservationTable,
} from '../src/engine';

describe('Space-Time A* Planner Bounds & Unreachable Handling', () => {
  it('never exceeds maxExpansions and returns a clean unreachable result for a fully blocked goal', () => {
    const width = 10;
    const height = 10;
    const cells: CellType[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, (): CellType => 'floor')
    );

    cells[7]![8] = 'wall';
    cells[9]![8] = 'wall';
    cells[8]![7] = 'wall';
    cells[8]![9] = 'wall';

    const maxExpansions = 25;
    const result = planSpaceTimePath({
      robotId: 'R1',
      start: { x: 1, y: 1 },
      goal: { x: 8, y: 8 },
      startTick: 0,
      horizon: 30,
      maxExpansions,
      grid: { width, height, cells },
      blockedSet: new Set(),
      reservations: new ReservationTable(),
    });

    expect(result.status).toBe('unreachable');
    expect(result.expanded).toBeLessThanOrEqual(maxExpansions);
  });

  it('caps search expansions cleanly when open maze exceeds expansion budget', () => {
    const width = 20;
    const height = 20;
    const cells: CellType[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, (): CellType => 'floor')
    );

    const maxExpansions = 15;
    const result = planSpaceTimePath({
      robotId: 'R1',
      start: { x: 0, y: 0 },
      goal: { x: 19, y: 19 },
      startTick: 0,
      horizon: 40,
      maxExpansions,
      grid: { width, height, cells },
      blockedSet: new Set(),
      reservations: new ReservationTable(),
    });

    expect(result.expanded).toBeLessThanOrEqual(maxExpansions);
  });
});
