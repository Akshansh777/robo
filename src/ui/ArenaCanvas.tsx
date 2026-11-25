import React, { useEffect, useRef } from 'react';
import {
  buildProjectedWaitForGraph,
  CellType,
  Coord,
  coordKey,
  detectWaitForCycles,
  ReservationTable,
  SimState,
} from '../engine';

export interface OverlayFlags {
  reservations: boolean;
  waitForGraph: boolean;
  congestionHeatmap: boolean;
  plannedPaths: boolean;
}

export type CanvasToolMode =
  | 'INSPECT'
  | 'PAINT_CELL'
  | 'BLOCK_TOGGLE'
  | 'ADD_ROBOT'
  | 'ADD_JOB'
  | 'KILL_RECOVER_ROBOT'
  | 'HUMAN_TOOL';

interface ArenaCanvasProps {
  state: SimState;
  cellOccupancy: Record<string, number>;
  overlays: OverlayFlags;
  selectedRobotId: string | null;
  highlightedCell: Coord | null;
  pendingJobPickup: Coord | null;
  toolMode: CanvasToolMode;
  onCellClick: (coord: Coord) => void;
  onCellDrag: (coord: Coord) => void;
  onRobotClick: (robotId: string) => void;
  compact?: boolean;
}

const ROBOT_PALETTE = [
  '#C6FF3D',
  '#9FE8FF',
  '#F2EFE6',
  '#FFB84D',
  '#6EE7B7',
  '#F472B6',
  '#FBBF24',
  '#38BDF8',
];

export function robotColor(robotId: string): string {
  let sum = 0;
  for (let i = 0; i < robotId.length; i++) {
    sum = (sum * 31 + robotId.charCodeAt(i)) >>> 0;
  }
  return ROBOT_PALETTE[sum % ROBOT_PALETTE.length]!;
}

export const ArenaCanvas: React.FC<ArenaCanvasProps> = ({
  state,
  cellOccupancy,
  overlays,
  selectedRobotId,
  highlightedCell,
  pendingJobPickup,
  onCellClick,
  onCellDrag,
  onRobotClick,
  compact = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailsRef = useRef<Map<string, Coord[]>>(new Map());
  const prevPosRef = useRef<Map<string, { from: Coord; to: Coord; startMs: number }>>(
    new Map()
  );
  const isDraggingRef = useRef(false);
  const layoutRef = useRef({ offsetX: 0, offsetY: 0, cellSize: 36 });

  // Update trails & smooth interpolation anchors whenever simulation state updates
  useEffect(() => {
    const now = performance.now();
    for (const robot of Object.values(state.robots)) {
      const prev = prevPosRef.current.get(robot.id);
      if (!prev) {
        prevPosRef.current.set(robot.id, {
          from: { ...robot.cell },
          to: { ...robot.cell },
          startMs: now,
        });
      } else if (prev.to.x !== robot.cell.x || prev.to.y !== robot.cell.y) {
        prevPosRef.current.set(robot.id, {
          from: { ...prev.to },
          to: { ...robot.cell },
          startMs: now,
        });
        const trail = trailsRef.current.get(robot.id) ?? [];
        trail.push({ ...prev.to });
        if (trail.length > 7) trail.shift();
        trailsRef.current.set(robot.id, trail);
      }
    }
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let rafId = 0;
    let active = true;

    const renderFrame = (now: number) => {
      if (!active) return;

      const parent = canvas.parentElement;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewW = parent ? parent.clientWidth : window.innerWidth;
      const viewH = parent ? parent.clientHeight : window.innerHeight;

      if (canvas.width !== viewW * dpr || canvas.height !== viewH * dpr) {
        canvas.width = viewW * dpr;
        canvas.height = viewH * dpr;
        canvas.style.width = `${viewW}px`;
        canvas.style.height = `${viewH}px`;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Ink floor background (#0A0B0F)
      ctx.fillStyle = '#0A0B0F';
      ctx.fillRect(0, 0, viewW, viewH);

      const padX = compact ? 24 : 330;
      const padY = compact ? 52 : 128;
      const availW = Math.max(240, viewW - padX * 2);
      const availH = Math.max(200, viewH - padY * 2);
      const cellSize = Math.max(
        14,
        Math.min(54, Math.floor(Math.min(availW / state.grid.width, availH / state.grid.height)))
      );

      const gridPxW = state.grid.width * cellSize;
      const gridPxH = state.grid.height * cellSize;
      const offsetX = Math.floor((viewW - gridPxW) / 2);
      const offsetY = Math.floor((viewH - gridPxH) / 2) - (compact ? 0 : 8);

      layoutRef.current = { offsetX, offsetY, cellSize };
      const blocked = new Set(state.blockedCells);

      let maxOcc = 1;
      if (overlays.congestionHeatmap) {
        for (const v of Object.values(cellOccupancy)) {
          if (v > maxOcc) maxOcc = v;
        }
      }

      // 1. Render cells
      for (let y = 0; y < state.grid.height; y++) {
        for (let x = 0; x < state.grid.width; x++) {
          const px = offsetX + x * cellSize;
          const py = offsetY + y * cellSize;
          const type: CellType = state.grid.cells[y]![x]!;

          if (type === 'wall') {
            ctx.fillStyle = '#07080B';
            ctx.fillRect(px, py, cellSize, cellSize);
          } else if (type === 'shelf') {
            // Soft raised block
            ctx.fillStyle = '#181B25';
            ctx.fillRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
            ctx.strokeStyle = 'rgba(242, 239, 230, 0.14)';
            ctx.lineWidth = 1;
            ctx.strokeRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
          } else {
            // Slightly lighter aisle floor
            ctx.fillStyle = '#12151E';
            ctx.fillRect(px, py, cellSize, cellSize);
          }

          // Subtle grid lines
          ctx.strokeStyle = 'rgba(242, 239, 230, 0.055)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px, py, cellSize, cellSize);

          // Special cell accents
          if (type === 'pickup') {
            ctx.fillStyle = 'rgba(198, 255, 61, 0.14)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
            ctx.strokeStyle = 'rgba(198, 255, 61, 0.65)';
            ctx.strokeRect(px + 3, py + 3, cellSize - 6, cellSize - 6);
          } else if (type === 'drop') {
            ctx.fillStyle = 'rgba(159, 232, 255, 0.14)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
            ctx.strokeStyle = 'rgba(159, 232, 255, 0.65)';
            ctx.strokeRect(px + 3, py + 3, cellSize - 6, cellSize - 6);
          } else if (type === 'bay') {
            ctx.fillStyle = 'rgba(242, 239, 230, 0.08)';
            ctx.fillRect(px + 3, py + 3, cellSize - 6, cellSize - 6);
          } else if (type === 'charger') {
            ctx.fillStyle = 'rgba(198, 255, 61, 0.09)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
          } else if (type === 'slow') {
            ctx.fillStyle = 'rgba(255, 184, 77, 0.14)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
          } else if (type === 'deadzone') {
            ctx.fillStyle = 'rgba(255, 90, 78, 0.12)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
          }

          if (
            cellSize >= 24 &&
            type !== 'floor' &&
            type !== 'wall' &&
            type !== 'shelf'
          ) {
            ctx.fillStyle = 'rgba(242, 239, 230, 0.45)';
            ctx.font = '600 8px "JetBrains Mono", monospace';
            ctx.fillText(type.slice(0, 4).toUpperCase(), px + 4, py + 10);
          }

          // Congestion heatmap overlay
          if (overlays.congestionHeatmap) {
            const occ = cellOccupancy[coordKey(x, y)] ?? 0;
            if (occ > 0) {
              const alpha = Math.min(0.65, (occ / maxOcc) * 0.65);
              ctx.fillStyle = `rgba(255, 90, 78, ${alpha.toFixed(3)})`;
              ctx.fillRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
            }
          }

          // Runtime blocked cell overlay
          if (blocked.has(coordKey(x, y))) {
            ctx.fillStyle = 'rgba(255, 90, 78, 0.28)';
            ctx.fillRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
            ctx.strokeStyle = '#FF5A4E';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px + 5, py + 5);
            ctx.lineTo(px + cellSize - 5, py + cellSize - 5);
            ctx.moveTo(px + cellSize - 5, py + 5);
            ctx.lineTo(px + 5, py + cellSize - 5);
            ctx.stroke();
          }
        }
      }

      // Pending job pickup marker
      if (pendingJobPickup) {
        const px = offsetX + pendingJobPickup.x * cellSize;
        const py = offsetY + pendingJobPickup.y * cellSize;
        ctx.strokeStyle = '#C6FF3D';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
      }

      // Highlighted cell from Decision Timeline selection
      if (highlightedCell) {
        const px = offsetX + highlightedCell.x * cellSize;
        const py = offsetY + highlightedCell.y * cellSize;
        ctx.strokeStyle = '#9FE8FF';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
      }

      // 2. Simulated Humans & Protective Zones
      for (const h of Object.values(state.humans)) {
        const r = state.profile.humanBufferRadius;
        const isStale = state.tick - h.lastUpdateTick > state.profile.humanStaleTimeoutTicks;
        ctx.fillStyle = isStale
          ? 'rgba(255, 90, 78, 0.24)'
          : 'rgba(159, 232, 255, 0.14)';

        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > r) continue;
            const bx = h.cell.x + dx;
            const by = h.cell.y + dy;
            if (bx >= 0 && by >= 0 && bx < state.grid.width && by < state.grid.height) {
              ctx.fillRect(
                offsetX + bx * cellSize + 1,
                offsetY + by * cellSize + 1,
                cellSize - 2,
                cellSize - 2
              );
            }
          }
        }

        const hx = offsetX + (h.cell.x + 0.5) * cellSize;
        const hy = offsetY + (h.cell.y + 0.5) * cellSize;
        ctx.beginPath();
        ctx.arc(hx, hy, cellSize * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = isStale ? '#FF5A4E' : '#9FE8FF';
        ctx.fill();
        ctx.strokeStyle = '#0A0B0F';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 3. Space-time reservation table overlay
      if (overlays.reservations) {
        for (const robot of Object.values(state.robots)) {
          const col = robotColor(robot.id);
          for (let i = 0; i < Math.min(8, robot.plan.length); i++) {
            const step = robot.plan[i]!;
            const alpha = Math.max(0.06, 0.26 - i * 0.025);
            ctx.fillStyle = col;
            ctx.globalAlpha = alpha;
            ctx.fillRect(
              offsetX + step.x * cellSize + 6,
              offsetY + step.y * cellSize + 6,
              cellSize - 12,
              cellSize - 12
            );
          }
        }
        ctx.globalAlpha = 1;
      }

      // 4. Planned paths overlay
      if (overlays.plannedPaths) {
        for (const robot of Object.values(state.robots)) {
          if (robot.plan.length === 0) continue;
          ctx.strokeStyle = robotColor(robot.id);
          ctx.globalAlpha = robot.id === selectedRobotId ? 0.95 : 0.42;
          ctx.lineWidth = robot.id === selectedRobotId ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.moveTo(
            offsetX + (robot.cell.x + 0.5) * cellSize,
            offsetY + (robot.cell.y + 0.5) * cellSize
          );
          for (const step of robot.plan) {
            ctx.lineTo(
              offsetX + (step.x + 0.5) * cellSize,
              offsetY + (step.y + 0.5) * cellSize
            );
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 5. Wait-for-graph arrows (highlighting predicted cycles in coral)
      if (overlays.waitForGraph) {
        const resTable = new ReservationTable();
        for (const r of Object.values(state.robots)) {
          resTable.reservePath(r.id, r.cell, state.tick, r.plan, state.tick + 12, 1);
        }
        const edges = buildProjectedWaitForGraph(
          Object.values(state.robots),
          resTable,
          state.tick,
          state.policy.deadlockLookaheadTicks
        );
        const cycles = detectWaitForCycles(edges);
        const cycleSet = new Set<string>(cycles.flat());

        for (const e of edges) {
          const fromR = state.robots[e.fromRobotId];
          const toR = state.robots[e.toRobotId];
          if (!fromR || !toR) continue;
          const inCycle = cycleSet.has(e.fromRobotId) && cycleSet.has(e.toRobotId);
          const x1 = offsetX + (fromR.cell.x + 0.5) * cellSize;
          const y1 = offsetY + (fromR.cell.y + 0.5) * cellSize;
          const x2 = offsetX + (toR.cell.x + 0.5) * cellSize;
          const y2 = offsetY + (toR.cell.y + 0.5) * cellSize;

          ctx.strokeStyle = inCycle ? '#FF5A4E' : '#9FE8FF';
          ctx.lineWidth = inCycle ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // 6. Packages / Pods on floor
      for (const pod of Object.values(state.pods)) {
        if (pod.carriedByRobotId) continue;
        const isStranded = pod.packageIds.some(
          (pid) => state.custody[pid]?.state === 'STRANDED'
        );
        const isDelivered = pod.packageIds.every(
          (pid) => state.custody[pid]?.state === 'DELIVERED'
        );
        const px = offsetX + pod.cell.x * cellSize;
        const py = offsetY + pod.cell.y * cellSize;
        const inset = Math.max(6, Math.floor(cellSize * 0.26));

        ctx.fillStyle = isStranded
          ? '#FF5A4E'
          : isDelivered
          ? 'rgba(159, 232, 255, 0.5)'
          : '#F2EFE6';
        ctx.fillRect(px + inset, py + inset, cellSize - inset * 2, cellSize - inset * 2);
      }

      // 7. Robots with fading trails, battery ring, carrying indicator & conflict glow pulse
      const recentDeadlock =
        state.deadlockEvents.length > 0
          ? state.deadlockEvents[state.deadlockEvents.length - 1]
          : undefined;
      const pulseActive =
        !prefersReduced &&
        recentDeadlock !== undefined &&
        state.tick - recentDeadlock.tick <= 3;

      for (const robot of Object.values(state.robots)) {
        const col = robot.status === 'FAILED' ? '#FF5A4E' : robotColor(robot.id);

        // Fading motion trail
        if (!prefersReduced && robot.status !== 'FAILED') {
          const trail = trailsRef.current.get(robot.id) ?? [];
          for (let i = 0; i < trail.length; i++) {
            const pt = trail[i]!;
            const alpha = ((i + 1) / (trail.length + 1)) * 0.24;
            ctx.fillStyle = col;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(
              offsetX + (pt.x + 0.5) * cellSize,
              offsetY + (pt.y + 0.5) * cellSize,
              cellSize * 0.16,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }

        // Smooth sub-tick position interpolation
        let drawGridX = robot.cell.x;
        let drawGridY = robot.cell.y;
        const interp = prevPosRef.current.get(robot.id);
        if (!prefersReduced && interp) {
          const tNorm = Math.min(1, (now - interp.startMs) / 140);
          const ease = 1 - Math.pow(1 - tNorm, 2);
          drawGridX = interp.from.x + (interp.to.x - interp.from.x) * ease;
          drawGridY = interp.from.y + (interp.to.y - interp.from.y) * ease;
        }

        const cx = offsetX + (drawGridX + 0.5) * cellSize;
        const cy = offsetY + (drawGridY + 0.5) * cellSize;
        const radius = cellSize * 0.34;

        // Glow pulse on conflict resolution or selection
        if (
          (pulseActive && recentDeadlock?.chosenRobotId === robot.id) ||
          robot.id === selectedRobotId
        ) {
          const pulseRadius = radius + 6 + Math.sin(now * 0.01) * 2.5;
          ctx.beginPath();
          ctx.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
          ctx.strokeStyle =
            robot.id === selectedRobotId ? '#C6FF3D' : '#9FE8FF';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Robot chassis
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = robot.status === 'FAILED' ? '#2A1215' : '#12151E';
        ctx.fill();

        // Battery ring arc
        const batFrac = Math.max(0, Math.min(1, robot.battery / 100));
        ctx.beginPath();
        ctx.arc(
          cx,
          cy,
          radius,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * batFrac
        );
        ctx.strokeStyle =
          robot.status === 'FAILED' || robot.battery < 20 ? '#FF5A4E' : col;
        ctx.lineWidth = 2.6;
        ctx.stroke();

        // Carrying payload indicator core
        if (robot.carryingPodId) {
          ctx.fillStyle = '#C6FF3D';
          const s = radius * 0.72;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }

        if (cellSize >= 26) {
          ctx.fillStyle = robot.carryingPodId ? '#0A0B0F' : '#F2EFE6';
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(robot.id.replace(/^(BOT-|R-|MED-)/, ''), cx, cy + 3);
          ctx.textAlign = 'start';
        }
      }

      ctx.restore();

      if (!prefersReduced) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      active = false;
      cancelAnimationFrame(rafId);
    };
  }, [
    state,
    cellOccupancy,
    overlays,
    selectedRobotId,
    highlightedCell,
    pendingJobPickup,
    compact,
  ]);

  const pixelToCell = (clientX: number, clientY: number): Coord | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { offsetX, offsetY, cellSize } = layoutRef.current;
    const x = Math.floor((clientX - rect.left - offsetX) / cellSize);
    const y = Math.floor((clientY - rect.top - offsetY) / cellSize);
    if (x < 0 || y < 0 || x >= state.grid.width || y >= state.grid.height) {
      return null;
    }
    return { x, y };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cell = pixelToCell(e.clientX, e.clientY);
    if (!cell) return;
    isDraggingRef.current = true;

    const hitRobot = Object.values(state.robots).find(
      (r) => r.cell.x === cell.x && r.cell.y === cell.y
    );
    if (hitRobot) {
      onRobotClick(hitRobot.id);
    }
    onCellClick(cell);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const cell = pixelToCell(e.clientX, e.clientY);
    if (cell) onCellDrag(cell);
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
    />
  );
};
