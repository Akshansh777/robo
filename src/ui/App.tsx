import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertOctagon,
  BatteryCharging,
  Bot,
  Camera,
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  Flame,
  GitBranch,
  KeyRound,
  Layers,
  PackagePlus,
  Paintbrush,
  Pause,
  Play,
  Plus,
  QrCode,
  Send,
  ShieldAlert,
  ShieldCheck,
  Skull,
  Sliders,
  Sparkles,
  StepBack,
  StepForward,
  Upload,
  UserPlus,
  Wand2,
  Wrench,
} from 'lucide-react';
import {
  CALIBRATION_DISCLAIMER,
  CellType,
  Coord,
  coordKey,
  DecisionCategory,
  evaluateCalibration,
  evaluateLayoutOptimization,
  exportProfileJSON,
  fitCalibratedProfile,
  generateChaosCommands,
  importProfileJSON,
  KPISeriesPoint,
  LayoutOptimizationComparison,
  Priority,
  proposeLayoutEdits,
  runInAppSelfTests,
  SelfTestSuiteReport,
  SimulationEngine,
} from '../engine';
import {
  createPresetEngine,
  PRESET_CATALOG,
  PresetId,
} from '../presets/maps';
import {
  DetectedGesture,
  WebcamHandController,
} from '../vision/handTracker';
import { PhysicalTableArucoTracker } from '../vision/arucoTracker';
import { AnimatedTicker } from './AnimatedTicker';
import { ArenaCanvas, CanvasToolMode, OverlayFlags } from './ArenaCanvas';
import { ErrorBoundary } from './ErrorBoundary';
import { explainRobotPlainLanguage } from './explainability';
import {
  executeFloorSupervisorPrompt,
  getStoredGeminiApiKey,
  runRootCausePostMortem,
  setStoredGeminiApiKey,
} from './geminiCopilot';
import { TelemetryCharts } from './TelemetryCharts';

const PAINTABLE_CELLS: CellType[] = [
  'floor',
  'shelf',
  'wall',
  'pickup',
  'drop',
  'bay',
  'charger',
  'slow',
  'deadzone',
];

export const ArenaApp: React.FC = () => {
  const [presetId, setPresetId] = useState<PresetId>('kiva-grid');
  const engineRef = useRef<SimulationEngine>(createPresetEngine('kiva-grid'));
  const branchEngineRef = useRef<SimulationEngine | null>(null);
  const [, setVersion] = useState(0);

  const [running, setRunning] = useState<boolean>(true);
  const [speedMs, setSpeedMs] = useState<number>(180);
  const [toolMode, setToolMode] = useState<CanvasToolMode>('INSPECT');
  const [paintType, setPaintType] = useState<CellType>('shelf');
  const [newJobPriority, setNewJobPriority] = useState<Priority>('HIGH');
  const [pendingJobPickup, setPendingJobPickup] = useState<Coord | null>(null);
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>('R-01');
  const [highlightedCell, setHighlightedCell] = useState<Coord | null>(null);

  const [overlays, setOverlays] = useState<OverlayFlags>({
    reservations: false,
    waitForGraph: true,
    congestionHeatmap: false,
    plannedPaths: true,
  });

  // Chaos controls
  const [chaosSeed, setChaosSeed] = useState<number>(404);
  const [chaosIntensity, setChaosIntensity] = useState<number>(0.45);

  // Right floating cluster tabs
  const [rightTab, setRightTab] = useState<
    'telemetry' | 'custody' | 'decisions' | 'calibration' | 'optimize'
  >('telemetry');

  // Decision timeline filters
  const [decisionSearch, setDecisionSearch] = useState('');
  const [decisionCategoryFilter, setDecisionCategoryFilter] = useState<DecisionCategory | 'ALL'>(
    'ALL'
  );

  // Time travel & A/B split view
  const [maxRecordedTick, setMaxRecordedTick] = useState<number>(0);
  const [abSplitActive, setAbSplitActive] = useState<boolean>(false);
  const [branchPolicyMode, setBranchPolicyMode] = useState<'PRIORITY_AGING' | 'AUCTION_REBID'>(
    'AUCTION_REBID'
  );

  // KPI history series
  const seriesRef = useRef<KPISeriesPoint[]>([]);
  const branchSeriesRef = useRef<KPISeriesPoint[]>([]);

  // Scripted 4-minute Demo Mode
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [demoBanner, setDemoBanner] = useState<string | null>(null);

  // Map resize & Profile JSON
  const [resizeW, setResizeW] = useState<number>(20);
  const [resizeH, setResizeH] = useState<number>(13);
  const [profileText, setProfileText] = useState<string>(() =>
    exportProfileJSON(engineRef.current.getState().profile)
  );
  const [profileStatus, setProfileStatus] = useState<string | null>(null);

  // Floor Supervisor Copilot state
  const [copilotPrompt, setCopilotPrompt] = useState('');
  const [copilotResult, setCopilotResult] = useState<{
    mode: 'AI' | 'Local';
    summary: string;
    answer?: string;
  } | null>(null);
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(() => getStoredGeminiApiKey());
  const [postMortem, setPostMortem] = useState<{ mode: 'AI' | 'Local'; report: string } | null>(
    null
  );

  // Auto-Optimize Layout state
  const [optComparison, setOptComparison] = useState<LayoutOptimizationComparison | null>(null);

  // In-App Self-Test Modal state
  const [selfTestReport, setSelfTestReport] = useState<SelfTestSuiteReport | null>(null);

  // Webcam Hand Control & Physical Table ArUco state
  const [visionMode, setVisionMode] = useState<'OFF' | 'HAND' | 'ARUCO'>('OFF');
  const [visionError, setVisionError] = useState<string | null>(null);
  const [detectedGesture, setDetectedGesture] = useState<DetectedGesture>('NONE');
  const [tableCorners, setTableCorners] = useState<Array<{ x: number; y: number }>>([]);
  const [arucoActiveBlocks, setArucoActiveBlocks] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCtrlRef = useRef<WebcamHandController | null>(null);
  const arucoCtrlRef = useRef<PhysicalTableArucoTracker | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const recordKpiSample = useCallback((sim: SimulationEngine, target: KPISeriesPoint[]) => {
    const s = sim.getState();
    const m = sim.getMetrics();
    const prios: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
    let count = 0;
    let sum = 0;
    let p95 = 0;
    for (const p of prios) {
      const st = m.pickupDelayByPriority[p];
      count += st.count;
      sum += st.avgPickupDelay * st.count;
      if (st.p95PickupDelay > p95) p95 = st.p95PickupDelay;
    }
    target.push({
      tick: s.tick,
      jobsCompleted: m.jobsCompleted,
      throughputPer100Ticks: m.throughputPer100Ticks,
      avgPickupDelay: count > 0 ? sum / count : 0,
      p95PickupDelay: p95,
      congestionIndex: m.congestionIndex,
      predictedDeadlocksResolved: m.predictedDeadlocksResolved,
      reactiveDeadlocksResolved: m.reactiveDeadlocksResolved,
      expansionsThisTick: s.plannerStats.expansionsThisTick,
      deferredRequests: s.plannerStats.deferredRequests,
    });
    if (target.length > 240) target.shift();
  }, []);

  const stepSimulation = useCallback(() => {
    const sim = engineRef.current;
    sim.step();
    recordKpiSample(sim, seriesRef.current);
    setMaxRecordedTick((prev) => Math.max(prev, sim.getState().tick));

    if (branchEngineRef.current) {
      branchEngineRef.current.step();
      recordKpiSample(branchEngineRef.current, branchSeriesRef.current);
    }
    bump();
  }, [bump, recordKpiSample]);

  const loadPreset = useCallback(
    (id: PresetId) => {
      setPresetId(id);
      const nextEngine = createPresetEngine(id);
      engineRef.current = nextEngine;
      branchEngineRef.current = null;
      setAbSplitActive(false);
      setOptComparison(null);
      seriesRef.current = [];
      branchSeriesRef.current = [];
      setMaxRecordedTick(0);
      setPendingJobPickup(null);
      setHighlightedCell(null);
      const firstRobot = Object.keys(nextEngine.getState().robots)[0] ?? null;
      setSelectedRobotId(firstRobot);
      setResizeW(nextEngine.getState().grid.width);
      setResizeH(nextEngine.getState().grid.height);
      setProfileText(exportProfileJSON(nextEngine.getState().profile));
      bump();
    },
    [bump]
  );

  // Main simulation loop
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      stepSimulation();
    }, speedMs);
    return () => window.clearInterval(id);
  }, [running, speedMs, stepSimulation]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setRunning(false);
        stepSimulation();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setRunning(false);
        const target = Math.max(0, engineRef.current.getState().tick - 1);
        engineRef.current.rewindTo(target);
        bump();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bump, stepSimulation]);

  // Webcam Hand Control & Physical Table ArUco Loop (graceful fallback on denial/missing hardware)
  useEffect(() => {
    if (visionMode === 'OFF') {
      setVisionError(null);
      setDetectedGesture('NONE');
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let timerId = 0;

    const startVision = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setVisionError('Camera API unavailable in this browser. Mouse controls remain active.');
          setVisionMode('OFF');
          return;
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        if (visionMode === 'HAND') {
          const ctrl = new WebcamHandController();
          const initRes = await ctrl.initLocal();
          if (!initRes.ok) {
            setVisionError(initRes.error ?? 'Hand model unavailable.');
            setVisionMode('OFF');
            return;
          }
          handCtrlRef.current = ctrl;
        } else if (visionMode === 'ARUCO') {
          const tracker = new PhysicalTableArucoTracker();
          const initRes = await tracker.init();
          if (!initRes.ok) {
            setVisionError(initRes.error ?? 'ArUco detector unavailable.');
            setVisionMode('OFF');
            return;
          }
          arucoCtrlRef.current = tracker;
        }

        // Throttled 20Hz detection loop keeps main 60fps canvas completely smooth
        timerId = window.setInterval(() => {
          if (cancelled || !videoRef.current || !previewCanvasRef.current) return;
          const v = videoRef.current;
          const pCanvas = previewCanvasRef.current;
          const pCtx = pCanvas.getContext('2d');
          if (!pCtx || v.readyState < 2) return;

          pCtx.drawImage(v, 0, 0, pCanvas.width, pCanvas.height);
          const s = engineRef.current.getState();

          if (visionMode === 'HAND' && handCtrlRef.current) {
            const { frame, debouncedTrigger } = handCtrlRef.current.detectFrame(
              v,
              performance.now(),
              s.grid.width,
              s.grid.height
            );
            setDetectedGesture(frame.gesture);

            // Draw hand skeleton overlay on mini preview
            if (frame.landmarks.length > 0) {
              pCtx.fillStyle = '#C6FF3D';
              for (const lm of frame.landmarks) {
                pCtx.beginPath();
                pCtx.arc(lm.x * pCanvas.width, lm.y * pCanvas.height, 2.5, 0, Math.PI * 2);
                pCtx.fill();
              }
            }

            if (debouncedTrigger && frame.gridCell) {
              const cell = frame.gridCell;
              if (debouncedTrigger === 'OPEN_PALM') {
                setRunning((r) => !r);
              } else if (debouncedTrigger === 'PINCH') {
                engineRef.current.dispatch({ type: 'BLOCK_CELL', tick: s.tick, cell });
                bump();
              } else if (debouncedTrigger === 'POINT') {
                const idx = Object.keys(s.jobs).length + 1;
                const pkgId = `PKG-G${idx}`;
                const podId = `POD-G${idx}`;
                engineRef.current.dispatch({
                  type: 'REGISTER_PACKAGE',
                  tick: s.tick,
                  pkg: { id: pkgId, weight: 2, priority: 'HIGH' },
                });
                engineRef.current.dispatch({
                  type: 'REGISTER_POD',
                  tick: s.tick,
                  pod: { id: podId, cell, packageIds: [pkgId] },
                });
                engineRef.current.dispatch({
                  type: 'ADD_JOB',
                  tick: s.tick,
                  job: {
                    id: `JOB-G${idx}`,
                    podId,
                    packageIds: [pkgId],
                    pickupCell: cell,
                    dropCell: { x: s.grid.width - 2, y: s.grid.height - 2 },
                    priority: 'HIGH',
                  },
                });
                bump();
              } else if (debouncedTrigger === 'FIST') {
                const hit = Object.values(s.robots).find(
                  (r) => Math.abs(r.cell.x - cell.x) <= 1 && Math.abs(r.cell.y - cell.y) <= 1
                );
                if (hit && hit.status !== 'FAILED') {
                  engineRef.current.dispatch({
                    type: 'FAIL_ROBOT',
                    tick: s.tick,
                    robotId: hit.id,
                  });
                  bump();
                }
              }
            }
          } else if (visionMode === 'ARUCO' && arucoCtrlRef.current) {
            // Draw calibrated table quad if 4 corners clicked
            if (tableCorners.length > 0) {
              pCtx.strokeStyle = '#9FE8FF';
              pCtx.lineWidth = 2;
              pCtx.beginPath();
              tableCorners.forEach((c, i) => {
                if (i === 0) pCtx.moveTo(c.x, c.y);
                else pCtx.lineTo(c.x, c.y);
              });
              if (tableCorners.length === 4) pCtx.closePath();
              pCtx.stroke();
            }

            if (tableCorners.length === 4) {
              const imgData = pCtx.getImageData(0, 0, pCanvas.width, pCanvas.height);
              const markers = arucoCtrlRef.current.detectMarkers(
                imgData,
                tableCorners,
                s.grid.width,
                s.grid.height
              );
              const nextKeys = new Set<string>();
              for (const m of markers) {
                if (m.gridCell) {
                  nextKeys.add(coordKey(m.gridCell.x, m.gridCell.y));
                }
              }

              // Diff against previous ArUco blocked cells and emit normal BLOCK/UNBLOCK commands
              setArucoActiveBlocks((prev) => {
                const prevSet = new Set(prev);
                for (const k of nextKeys) {
                  if (!prevSet.has(k)) {
                    const [bx, by] = k.split(',').map(Number);
                    engineRef.current.dispatch({
                      type: 'BLOCK_CELL',
                      tick: s.tick,
                      cell: { x: bx!, y: by! },
                    });
                  }
                }
                for (const k of prevSet) {
                  if (!nextKeys.has(k)) {
                    const [ux, uy] = k.split(',').map(Number);
                    engineRef.current.dispatch({
                      type: 'UNBLOCK_CELL',
                      tick: s.tick,
                      cell: { x: ux!, y: uy! },
                    });
                  }
                }
                if (nextKeys.size !== prevSet.size) bump();
                return Array.from(nextKeys);
              });
            }
          }
        }, 50);
      } catch {
        setVisionError('Camera permission denied or unavailable. Mouse controls remain active.');
        setVisionMode('OFF');
      }
    };

    startVision();
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
      handCtrlRef.current?.dispose();
      handCtrlRef.current = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [visionMode, tableCorners, bump]);

  // Scripted 4-minute reproducible Demo Mode sequence
  useEffect(() => {
    if (!demoMode) {
      setDemoBanner(null);
      return;
    }

    loadPreset('narrow-aisle');
    setRunning(true);
    setSpeedMs(220);

    const stages: Array<{ delayMs: number; action: () => void }> = [
      {
        delayMs: 0,
        action: () =>
          setDemoBanner(
            'Demo 1/5: Narrow Aisle Showdown - Wait-for graph predicts head-on conflict and yields to passing bay.'
          ),
      },
      {
        delayMs: 35_000,
        action: () => {
          loadPreset('kiva-grid');
          setDemoBanner(
            'Demo 2/5: Kiva Grid - Contract Net bidding balances ETA, congestion, and battery safety reserves.'
          );
        },
      },
      {
        delayMs: 85_000,
        action: () => {
          const s = engineRef.current.getState();
          engineRef.current.dispatch({ type: 'FAIL_ROBOT', tick: s.tick, robotId: 'R-01' });
          engineRef.current.dispatch({ type: 'BLOCK_CELL', tick: s.tick, cell: { x: 6, y: 5 } });
          setRightTab('custody');
          setDemoBanner(
            'Demo 3/5: Mid-route carrier failure + live aisle block - Custody Ledger strands cargo and dispatches URGENT rescue.'
          );
        },
      },
      {
        delayMs: 145_000,
        action: () => {
          const s = engineRef.current.getState();
          const rewindTick = Math.max(2, s.tick - 12);
          branchEngineRef.current = engineRef.current.branchFrom(rewindTick, {
            enableDynamicEdgePricing: false,
            conflictMode: 'AUCTION_REBID',
          });
          branchSeriesRef.current = [];
          setAbSplitActive(true);
          setRightTab('telemetry');
          setDemoBanner(
            'Demo 4/5: Time-travel branch - Side-by-side A/B comparison of Smart Policy vs Baseline AUCTION_REBID.'
          );
        },
      },
      {
        delayMs: 200_000,
        action: () => {
          loadPreset('hospital-corridor');
          setRightTab('decisions');
          setDemoBanner(
            'Demo 5/5: Hospital Corridor - Simulated human safety buffer, RF deadzone halo, and Explainable Decision Timeline.'
          );
        },
      },
      {
        delayMs: 240_000,
        action: () => {
          setDemoMode(false);
          setDemoBanner(null);
        },
      },
    ];

    const timers = stages.map((st) => window.setTimeout(st.action, st.delayMs));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [demoMode, loadPreset]);

  const handleCanvasCellAction = (cell: Coord, isDrag = false) => {
    const sim = engineRef.current;
    const state = sim.getState();

    if (toolMode === 'PAINT_CELL') {
      sim.dispatch({ type: 'PAINT_CELL', tick: state.tick, cell, cellType: paintType });
      if (!running) sim.step();
      bump();
      return;
    }

    if (isDrag) return;

    if (toolMode === 'BLOCK_TOGGLE') {
      const k = coordKey(cell.x, cell.y);
      if (state.blockedCells.includes(k)) {
        sim.dispatch({ type: 'UNBLOCK_CELL', tick: state.tick, cell });
      } else {
        sim.dispatch({ type: 'BLOCK_CELL', tick: state.tick, cell });
      }
      bump();
    } else if (toolMode === 'ADD_ROBOT') {
      const nextIdx = Object.keys(state.robots).length + 1;
      const newId = `R-${String(nextIdx).padStart(2, '0')}`;
      sim.dispatch({ type: 'ADD_ROBOT', tick: state.tick, robot: { id: newId, cell } });
      setSelectedRobotId(newId);
      bump();
    } else if (toolMode === 'ADD_JOB') {
      if (!pendingJobPickup) {
        setPendingJobPickup(cell);
      } else {
        const idx = Object.keys(state.jobs).length + 1;
        const pkgId = `PKG-U${idx}`;
        const podId = `POD-U${idx}`;
        const jobId = `JOB-U${idx}`;
        sim.dispatch({
          type: 'REGISTER_PACKAGE',
          tick: state.tick,
          pkg: { id: pkgId, weight: 3, priority: newJobPriority },
        });
        sim.dispatch({
          type: 'REGISTER_POD',
          tick: state.tick,
          pod: { id: podId, cell: pendingJobPickup, packageIds: [pkgId] },
        });
        sim.dispatch({
          type: 'ADD_JOB',
          tick: state.tick,
          job: {
            id: jobId,
            podId,
            packageIds: [pkgId],
            pickupCell: pendingJobPickup,
            dropCell: cell,
            priority: newJobPriority,
          },
        });
        setPendingJobPickup(null);
        bump();
      }
    } else if (toolMode === 'KILL_RECOVER_ROBOT') {
      const hit = Object.values(state.robots).find(
        (r) => r.cell.x === cell.x && r.cell.y === cell.y
      );
      if (hit) {
        sim.dispatch({
          type: hit.status === 'FAILED' ? 'RECOVER_ROBOT' : 'FAIL_ROBOT',
          tick: state.tick,
          robotId: hit.id,
        });
        bump();
      }
    } else if (toolMode === 'HUMAN_TOOL') {
      const existingHuman = Object.values(state.humans)[0];
      const hitHuman = Object.values(state.humans).find(
        (h) => h.cell.x === cell.x && h.cell.y === cell.y
      );
      if (hitHuman) {
        sim.dispatch({ type: 'REMOVE_HUMAN', tick: state.tick, humanId: hitHuman.id });
      } else if (existingHuman) {
        sim.dispatch({
          type: 'MOVE_HUMAN',
          tick: state.tick,
          humanId: existingHuman.id,
          cell,
        });
      } else {
        sim.dispatch({
          type: 'ADD_HUMAN',
          tick: state.tick,
          human: { id: 'STAFF-01', cell },
        });
      }
      bump();
    }
  };

  const handleCopilotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!copilotPrompt.trim() || copilotBusy) return;
    setCopilotBusy(true);
    try {
      const plan = await executeFloorSupervisorPrompt(engineRef.current, copilotPrompt);
      for (const cmd of plan.commands) {
        engineRef.current.dispatch(cmd);
      }
      setCopilotResult({
        mode: plan.mode,
        summary: plan.summary,
        answer: plan.answer,
      });
      setCopilotPrompt('');
      bump();
    } finally {
      setCopilotBusy(false);
    }
  };

  const handleRunAutoOptimize = () => {
    const proposals = proposeLayoutEdits(engineRef.current);
    const diff = evaluateLayoutOptimization(engineRef.current, proposals);
    setOptComparison(diff);
    setRightTab('optimize');
  };

  const handleRunSelfTest = () => {
    const report = runInAppSelfTests();
    setSelfTestReport(report);
  };

  const triggerChaosBurst = () => {
    const sim = engineRef.current;
    const state = sim.getState();
    const pickups: Coord[] = [];
    const drops: Coord[] = [];
    for (let y = 0; y < state.grid.height; y++) {
      for (let x = 0; x < state.grid.width; x++) {
        if (state.grid.cells[y]![x] === 'pickup') pickups.push({ x, y });
        if (state.grid.cells[y]![x] === 'drop') drops.push({ x, y });
      }
    }
    const cmds = generateChaosCommands(state.grid, {
      seed: chaosSeed,
      intensity: chaosIntensity,
      durationTicks: 24,
      robotIds: Object.keys(state.robots),
      pickupCells: pickups,
      dropCells: drops,
    });
    for (const c of cmds) {
      sim.dispatch({ ...c, tick: state.tick + Math.max(0, c.tick - 2) });
    }
    bump();
  };

  const handleBranchPolicy = () => {
    const sim = engineRef.current;
    const currentTick = sim.getState().tick;
    const branch = sim.branchFrom(currentTick, {
      conflictMode: branchPolicyMode,
      enableDynamicEdgePricing: branchPolicyMode === 'PRIORITY_AGING',
    });
    branchEngineRef.current = branch;
    branchSeriesRef.current = [];
    setAbSplitActive(true);
    bump();
  };

  const handleResizeGrid = () => {
    const w = Math.max(8, Math.min(40, resizeW));
    const h = Math.max(6, Math.min(30, resizeH));
    const oldGrid = engineRef.current.getState().grid;
    const cells: CellType[][] = Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x): CellType => {
        if (y < oldGrid.height && x < oldGrid.width) return oldGrid.cells[y]![x]!;
        return 'floor';
      })
    );
    const nextEngine = new SimulationEngine({
      seed: engineRef.current.getState().seed,
      grid: { width: w, height: h, cells },
      profile: engineRef.current.getState().profile,
    });
    engineRef.current = nextEngine;
    branchEngineRef.current = null;
    setAbSplitActive(false);
    seriesRef.current = [];
    setMaxRecordedTick(0);
    bump();
  };

  const handleSaveMapJson = () => {
    const bundle = engineRef.current.exportReplay();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arena-${presetId}-tick${engineRef.current.getState().tick}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadMapJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const restored = SimulationEngine.fromReplay(parsed);
        engineRef.current = restored;
        branchEngineRef.current = null;
        setAbSplitActive(false);
        seriesRef.current = [];
        setMaxRecordedTick(0);
        setResizeW(restored.getState().grid.width);
        setResizeH(restored.getState().grid.height);
        bump();
      } catch (err) {
        setProfileStatus(`Failed to load JSON: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  const state = engineRef.current.getState();
  const metrics = engineRef.current.getMetrics();
  const chainCheck = engineRef.current.verifyLedgerChain();
  const inv = state.lastInvariantReport;
  const activeTimeline = branchEngineRef.current
    ? branchEngineRef.current.getDecisionTimeline()
    : state.decisionTimeline;

  const filteredDecisions = useMemo(() => {
    return [...activeTimeline]
      .reverse()
      .filter((d) => {
        if (decisionCategoryFilter !== 'ALL' && d.category !== decisionCategoryFilter) {
          return false;
        }
        if (decisionSearch.trim()) {
          const q = decisionSearch.toLowerCase();
          const blob = `${d.tick} ${d.robotId ?? ''} ${d.jobId ?? ''} ${d.packageId ?? ''} ${d.decision} ${d.reason}`.toLowerCase();
          if (!blob.includes(q)) return false;
        }
        return true;
      })
      .slice(0, 45);
  }, [activeTimeline, decisionCategoryFilter, decisionSearch]);

  const calibrationReport = useMemo(() => {
    const sampleObs =
      state.calibrationObservations.length > 0
        ? state.calibrationObservations
        : [
            {
              id: 'field-run-1',
              distanceCells: 12,
              payloadKg: 4,
              slowCellsCount: 2,
              observedTravelTicks: 17,
              observedBatteryDrainPct: 3.1,
              measuredFriction: 0.78,
            },
          ];
    return evaluateCalibration(state.profile, sampleObs);
  }, [state.profile, state.calibrationObservations]);

  const selectedRobot = selectedRobotId ? state.robots[selectedRobotId] : undefined;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <svg width="0" height="0" style={{ position: 'absolute', pointerEvents: 'none' }}>
        <defs>
          <filter id="liquid-glass-refract">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.02 0.04"
              numOctaves="2"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="3.5"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* Full-Bleed Central Arena */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          gridTemplateColumns: abSplitActive && branchEngineRef.current ? '1fr 1fr' : '1fr',
          gap: 2,
          background: '#0A0B0F',
        }}
      >
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <ArenaCanvas
            state={state}
            cellOccupancy={metrics.cellOccupancy}
            overlays={overlays}
            selectedRobotId={selectedRobotId}
            highlightedCell={highlightedCell}
            pendingJobPickup={pendingJobPickup}
            toolMode={toolMode}
            compact={abSplitActive}
            onCellClick={(c) => handleCanvasCellAction(c, false)}
            onCellDrag={(c) => handleCanvasCellAction(c, true)}
            onRobotClick={(id) => setSelectedRobotId(id)}
          />
        </div>

        {abSplitActive && branchEngineRef.current && (
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              borderLeft: '1px solid rgba(159,232,255,0.25)',
            }}
          >
            <ArenaCanvas
              state={branchEngineRef.current.getState()}
              cellOccupancy={branchEngineRef.current.getMetrics().cellOccupancy}
              overlays={overlays}
              selectedRobotId={selectedRobotId}
              highlightedCell={highlightedCell}
              pendingJobPickup={null}
              toolMode="INSPECT"
              compact
              onCellClick={() => {}}
              onCellDrag={() => {}}
              onRobotClick={(id) => setSelectedRobotId(id)}
            />
          </div>
        )}
      </div>

      {/* TOP COMMAND BAR */}
      <header
        className="liquid-glass liquid-glass-edge"
        style={{
          position: 'fixed',
          top: 10,
          left: 12,
          right: 12,
          height: 50,
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          zIndex: 35,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Cpu size={17} color="#C6FF3D" />
          <span className="display-heading" style={{ fontSize: 14, whiteSpace: 'nowrap' }}>
            WAREHOUSE ARENA
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {PRESET_CATALOG.map((p) => (
              <button
                key={p.id}
                className={`glass-btn ${presetId === p.id ? 'glass-btn-active' : ''}`}
                onClick={() => loadPreset(p.id)}
                title={p.subtitle}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <button
            className="glass-btn glass-btn-accent"
            onClick={() => setRunning((r) => !r)}
            title="Play or Pause (Space)"
          >
            {running ? <Pause size={13} /> : <Play size={13} />}
            {running ? 'Pause' : 'Play'}
          </button>

          <button
            className="glass-btn"
            onClick={() => {
              setRunning(false);
              stepSimulation();
            }}
          >
            <StepForward size={13} />
            Step
          </button>

          <select
            className="glass-select"
            value={speedMs}
            onChange={(e) => setSpeedMs(Number(e.target.value))}
            aria-label="Simulation Speed"
          >
            <option value={450}>0.5x</option>
            <option value={180}>1.0x</option>
            <option value={75}>2.5x</option>
            <option value={25}>6.0x</option>
          </select>

          <button className="glass-btn" onClick={handleRunSelfTest} title="Run In-App Verification Suite">
            <CheckCircle2 size={13} color="#C6FF3D" />
            Self-test
          </button>

          <button className="glass-btn" onClick={handleRunAutoOptimize} title="Analyze Heatmap & Compare Layout">
            <Wand2 size={13} color="#9FE8FF" />
            Auto-Optimize
          </button>

          <button
            className={`glass-btn ${demoMode ? 'glass-btn-danger' : 'glass-btn-ice'}`}
            onClick={() => setDemoMode((d) => !d)}
          >
            <Sparkles size={13} />
            {demoMode ? 'Stop Demo' : 'Demo Mode'}
          </button>
        </div>
      </header>

      {/* FLOOR SUPERVISOR COPILOT FLOATING COMMAND BAR */}
      <div
        className="liquid-glass"
        style={{
          position: 'fixed',
          top: 66,
          left: 280,
          right: 308,
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          zIndex: 32,
        }}
      >
        <form
          onSubmit={handleCopilotSubmit}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span
            style={{
              padding: '2px 7px',
              borderRadius: 5,
              fontSize: 10,
              fontWeight: 700,
              background: getStoredGeminiApiKey() ? 'var(--ice-soft)' : 'var(--lime-soft)',
              color: getStoredGeminiApiKey() ? '#9FE8FF' : '#C6FF3D',
              border: '1px solid rgba(242,239,230,0.16)',
            }}
          >
            {getStoredGeminiApiKey() ? 'AI' : 'Local'}
          </span>
          <input
            type="text"
            className="glass-input"
            style={{ flex: 1 }}
            placeholder='Supervisor Copilot: "block aisle 3 and fail the busiest robot in 5 seconds" or "Why is R-01 waiting?"'
            value={copilotPrompt}
            onChange={(e) => setCopilotPrompt(e.target.value)}
          />
          <button type="submit" className="glass-btn glass-btn-accent" disabled={copilotBusy}>
            <Send size={12} />
            Run
          </button>
          <button
            type="button"
            className="glass-btn"
            onClick={async () => {
              const res = await runRootCausePostMortem(engineRef.current);
              setPostMortem(res);
            }}
          >
            Post-Mortem
          </button>
          <button
            type="button"
            className="glass-btn"
            onClick={() => setShowKeyModal((s) => !s)}
            title="Configure optional Gemini API key in localStorage"
          >
            <KeyRound size={12} />
          </button>
        </form>

        {copilotResult && (
          <div style={{ fontSize: 10.5, color: 'var(--bone)', display: 'flex', justifyContent: 'space-between' }}>
            <span>
              <b style={{ color: copilotResult.mode === 'AI' ? '#9FE8FF' : '#C6FF3D' }}>
                [{copilotResult.mode}]
              </b>{' '}
              {copilotResult.answer ?? copilotResult.summary}
            </span>
            <button
              className="glass-btn"
              style={{ padding: '1px 6px', fontSize: 9 }}
              onClick={() => setCopilotResult(null)}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Optional Gemini API Key Dialog (stored strictly in localStorage) */}
      {showKeyModal && (
        <div
          className="liquid-glass"
          style={{
            position: 'fixed',
            top: 114,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 420,
            padding: 14,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div className="display-heading" style={{ fontSize: 14 }}>
            Floor Supervisor Copilot API Key (Optional)
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--bone-muted)', lineHeight: 1.4 }}>
            Stored only in browser <code>localStorage</code> and never written to the repository. Leave empty to use the deterministic offline Local parser and bottleneck analyzer.
          </div>
          <input
            type="password"
            className="glass-input"
            placeholder="AIza..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              className="glass-btn"
              onClick={() => {
                setStoredGeminiApiKey('');
                setApiKeyInput('');
                setShowKeyModal(false);
                bump();
              }}
            >
              Clear Key (Use Local)
            </button>
            <button
              className="glass-btn glass-btn-accent"
              onClick={() => {
                setStoredGeminiApiKey(apiKeyInput);
                setShowKeyModal(false);
                bump();
              }}
            >
              Save to localStorage
            </button>
          </div>
        </div>
      )}

      {/* Root-Cause Post-Mortem Overlay */}
      {postMortem && (
        <div
          className="liquid-glass"
          style={{
            position: 'fixed',
            top: 114,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 520,
            padding: 14,
            zIndex: 48,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="display-heading" style={{ fontSize: 14, color: '#C6FF3D' }}>
              Root-Cause Bottleneck Post-Mortem ({postMortem.mode})
            </span>
            <button className="glass-btn" onClick={() => setPostMortem(null)}>
              Close
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              lineHeight: 1.45,
              background: 'rgba(10,11,15,0.65)',
              padding: 10,
              borderRadius: 8,
            }}
          >
            {postMortem.report}
          </pre>
        </div>
      )}

      {/* In-App Self-Test Report Modal */}
      {selfTestReport && (
        <div
          className="liquid-glass"
          style={{
            position: 'fixed',
            top: 114,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 500,
            padding: 14,
            zIndex: 49,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              className="display-heading"
              style={{
                fontSize: 14,
                color: selfTestReport.allPassed ? '#C6FF3D' : '#FF5A4E',
              }}
            >
              In-App Self-Test Suite: {selfTestReport.allPassed ? 'ALL PASSED' : 'FAILED'} (
              {selfTestReport.durationMs}ms)
            </span>
            <button className="glass-btn" onClick={() => setSelfTestReport(null)}>
              Close
            </button>
          </div>
          {selfTestReport.checks.map((c, idx) => (
            <div
              key={idx}
              style={{
                padding: '6px 8px',
                borderRadius: 7,
                background: 'rgba(10,11,15,0.65)',
                borderLeft: `3px solid ${c.passed ? '#C6FF3D' : '#FF5A4E'}`,
                fontSize: 10.5,
              }}
            >
              <div>
                <b>{c.passed ? 'PASS' : 'FAIL'}</b>: {c.name}
              </div>
              <div style={{ color: 'var(--bone-muted)', marginTop: 2 }}>{c.detail}</div>
            </div>
          ))}
        </div>
      )}

      {/* Demo Mode Narrator Banner */}
      {demoBanner && (
        <div
          className="liquid-glass"
          style={{
            position: 'fixed',
            bottom: 74,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '7px 14px',
            borderColor: 'rgba(159, 232, 255, 0.5)',
            color: '#9FE8FF',
            zIndex: 32,
            maxWidth: 640,
          }}
        >
          {demoBanner}
        </div>
      )}

      {/* LEFT SLIM GLASS DOCK */}
      <aside
        className="liquid-glass liquid-glass-edge thin-scroll"
        style={{
          position: 'fixed',
          top: 68,
          left: 12,
          bottom: 74,
          width: 256,
          padding: 11,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflowY: 'auto',
          zIndex: 25,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 5 }}>
            ARENA & SAFETY TOOLS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <button
              className={`glass-btn ${toolMode === 'INSPECT' ? 'glass-btn-active' : ''}`}
              onClick={() => setToolMode('INSPECT')}
            >
              <Eye size={12} />
              Inspect
            </button>
            <button
              className={`glass-btn ${toolMode === 'PAINT_CELL' ? 'glass-btn-active' : ''}`}
              onClick={() => setToolMode('PAINT_CELL')}
            >
              <Paintbrush size={12} />
              Paint Map
            </button>
            <button
              className={`glass-btn ${toolMode === 'BLOCK_TOGGLE' ? 'glass-btn-active' : ''}`}
              onClick={() => setToolMode('BLOCK_TOGGLE')}
            >
              <AlertOctagon size={12} />
              Block Aisle
            </button>
            <button
              className={`glass-btn ${toolMode === 'ADD_ROBOT' ? 'glass-btn-active' : ''}`}
              onClick={() => setToolMode('ADD_ROBOT')}
            >
              <Plus size={12} />
              Add Robot
            </button>
            <button
              className={`glass-btn ${toolMode === 'ADD_JOB' ? 'glass-btn-active' : ''}`}
              onClick={() => {
                setPendingJobPickup(null);
                setToolMode('ADD_JOB');
              }}
            >
              <PackagePlus size={12} />
              Add Job
            </button>
            <button
              className={`glass-btn ${toolMode === 'KILL_RECOVER_ROBOT' ? 'glass-btn-danger' : ''}`}
              onClick={() => setToolMode('KILL_RECOVER_ROBOT')}
            >
              <Skull size={12} />
              Kill/Recover
            </button>
            <button
              className={`glass-btn ${toolMode === 'HUMAN_TOOL' ? 'glass-btn-ice' : ''}`}
              style={{ gridColumn: '1 / -1' }}
              onClick={() => setToolMode('HUMAN_TOOL')}
            >
              <UserPlus size={12} />
              Manual Human Zone (Offline)
            </button>
          </div>

          {toolMode === 'PAINT_CELL' && (
            <select
              className="glass-select"
              style={{ width: '100%', marginTop: 6 }}
              value={paintType}
              onChange={(e) => setPaintType(e.target.value as CellType)}
            >
              {PAINTABLE_CELLS.map((c) => (
                <option key={c} value={c}>
                  Brush: {c.toUpperCase()}
                </option>
              ))}
            </select>
          )}

          {toolMode === 'ADD_JOB' && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <select
                className="glass-select"
                value={newJobPriority}
                onChange={(e) => setNewJobPriority(e.target.value as Priority)}
              >
                <option value="LOW">Priority: LOW</option>
                <option value="NORMAL">Priority: NORMAL</option>
                <option value="HIGH">Priority: HIGH</option>
                <option value="URGENT">Priority: URGENT</option>
              </select>
              <div style={{ fontSize: 10, color: 'var(--lime)' }}>
                {pendingJobPickup
                  ? `Pickup (${pendingJobPickup.x},${pendingJobPickup.y}) set. Click Drop.`
                  : 'Click Pickup cell on arena.'}
              </div>
            </div>
          )}
        </div>

        {/* Vision Sensors: Webcam Hand Control & Physical Table ArUco */}
        <div style={{ borderTop: '1px solid rgba(242,239,230,0.1)', paddingTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 5 }}>
            CAMERA & TABLE SENSORS (OPTIONAL)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <button
              className={`glass-btn ${visionMode === 'HAND' ? 'glass-btn-active' : ''}`}
              onClick={() => setVisionMode((m) => (m === 'HAND' ? 'OFF' : 'HAND'))}
            >
              <Camera size={12} />
              Hand Gestures
            </button>
            <button
              className={`glass-btn ${visionMode === 'ARUCO' ? 'glass-btn-ice' : ''}`}
              onClick={() => {
                setTableCorners([]);
                setVisionMode((m) => (m === 'ARUCO' ? 'OFF' : 'ARUCO'));
              }}
            >
              <QrCode size={12} />
              Table ArUco
            </button>
          </div>

          {visionError && (
            <div style={{ fontSize: 10, color: '#FF5A4E', marginTop: 5 }}>{visionError}</div>
          )}

          {visionMode !== 'OFF' && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
              <canvas
                ref={previewCanvasRef}
                width={232}
                height={150}
                onClick={(e) => {
                  if (visionMode !== 'ARUCO') return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                  setTableCorners((prev) => (prev.length >= 4 ? [pt] : [...prev, pt]));
                }}
                style={{
                  width: '100%',
                  borderRadius: 8,
                  border: '1px solid rgba(242,239,230,0.2)',
                  cursor: visionMode === 'ARUCO' ? 'crosshair' : 'default',
                }}
              />
              {visionMode === 'HAND' ? (
                <div style={{ fontSize: 10, color: 'var(--lime)' }}>
                  Gesture: <b>{detectedGesture}</b> (Pinch=Block, Point=Job, Palm=Pause, Fist=Fail)
                </div>
              ) : (
                <div style={{ fontSize: 10, color: 'var(--ice)' }}>
                  {tableCorners.length < 4
                    ? `Click 4 table corners (${tableCorners.length}/4)`
                    : `Calibrated: ${arucoActiveBlocks.length} ArUco block(s) active`}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Visual Overlays */}
        <div style={{ borderTop: '1px solid rgba(242,239,230,0.1)', paddingTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 5 }}>
            <Layers size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            VISUAL OVERLAYS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {(
              [
                ['plannedPaths', 'Paths'],
                ['waitForGraph', 'Wait Graph'],
                ['reservations', 'Reservations'],
                ['congestionHeatmap', 'Heatmap'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`glass-btn ${overlays[key] ? 'glass-btn-active' : ''}`}
                onClick={() => setOverlays((o) => ({ ...o, [key]: !o[key] }))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Chaos Generator */}
        <div style={{ borderTop: '1px solid rgba(242,239,230,0.1)', paddingTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 5 }}>
            <Flame size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            SEEDED CHAOS INJECTOR
          </div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 5 }}>
            <input
              type="number"
              className="glass-input"
              style={{ width: 68 }}
              value={chaosSeed}
              onChange={(e) => setChaosSeed(Number(e.target.value))}
            />
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={chaosIntensity}
              onChange={(e) => setChaosIntensity(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#C6FF3D' }}
            />
            <span style={{ fontSize: 10 }}>{Math.round(chaosIntensity * 100)}%</span>
          </div>
          <button
            className="glass-btn glass-btn-danger"
            style={{ width: '100%' }}
            onClick={triggerChaosBurst}
          >
            Inject Chaos Burst
          </button>
        </div>

        {/* Map Resize & Save/Load JSON */}
        <div style={{ borderTop: '1px solid rgba(242,239,230,0.1)', paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 5 }}>
            <input
              type="number"
              className="glass-input"
              style={{ width: 48 }}
              value={resizeW}
              onChange={(e) => setResizeW(Number(e.target.value))}
            />
            <span>x</span>
            <input
              type="number"
              className="glass-input"
              style={{ width: 48 }}
              value={resizeH}
              onChange={(e) => setResizeH(Number(e.target.value))}
            />
            <button className="glass-btn" style={{ flex: 1 }} onClick={handleResizeGrid}>
              Resize
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="glass-btn" style={{ flex: 1 }} onClick={handleSaveMapJson}>
              <Download size={11} />
              Save
            </button>
            <label className="glass-btn" style={{ flex: 1, cursor: 'pointer' }}>
              <Upload size={11} />
              Load
              <input type="file" accept=".json" onChange={handleLoadMapJson} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        {/* Selected Robot Explainability Card */}
        {selectedRobot && (
          <div style={{ borderTop: '1px solid rgba(242,239,230,0.1)', paddingTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ fontWeight: 700, color: 'var(--lime)' }}>
                <Bot size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                {selectedRobot.id}
              </span>
              <span>
                {selectedRobot.status} | {selectedRobot.battery.toFixed(1)}%
              </span>
            </div>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 10.5,
                lineHeight: 1.4,
                background: 'rgba(10,11,15,0.62)',
                padding: 7,
                borderRadius: 7,
              }}
            >
              {explainRobotPlainLanguage(state, selectedRobot.id)}
            </p>
          </div>
        )}
      </aside>

      {/* RIGHT FLOATING TELEMETRY, CUSTODY, TIMELINE, OPTIMIZER & CALIBRATION CLUSTER */}
      <aside
        className="liquid-glass liquid-glass-edge thin-scroll"
        style={{
          position: 'fixed',
          top: 68,
          right: 12,
          bottom: 74,
          width: 284,
          padding: 11,
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          overflowY: 'auto',
          zIndex: 25,
        }}
      >
        {/* Custody Invariant Status Badge */}
        <div
          style={{
            padding: '7px 9px',
            borderRadius: 8,
            background: inv.ok && chainCheck.valid ? 'var(--lime-soft)' : 'var(--coral-soft)',
            border: `1px solid ${inv.ok && chainCheck.valid ? 'rgba(198,255,61,0.45)' : '#FF5A4E'}`,
            color: inv.ok && chainCheck.valid ? '#C6FF3D' : '#FF5A4E',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 7,
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {inv.ok && chainCheck.valid ? (
            <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          ) : (
            <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          )}
          <div>
            {inv.ok && chainCheck.valid
              ? '0 duplicate carries - 0 double deliveries - chain verified'
              : `VIOLATION: ${inv.violations[0] ?? 'Ledger hash chain broken'}`}
          </div>
        </div>

        {/* Prominent Non-Certified Simulator Safety Notice */}
        <div
          style={{
            fontSize: 9.5,
            color: 'var(--bone-muted)',
            background: 'rgba(10,11,15,0.58)',
            padding: '5px 7px',
            borderRadius: 6,
            border: '1px solid rgba(242,239,230,0.08)',
          }}
        >
          Simulation tool only: not a real-world safety controller or substitute for certified sensors, emergency stops, or on-site risk assessment.
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
          {(
            [
              ['telemetry', 'KPIs'],
              ['custody', 'Custody'],
              ['decisions', 'Log'],
              ['optimize', 'Layout'],
              ['calibration', 'Profile'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`glass-btn ${rightTab === id ? 'glass-btn-active' : ''}`}
              style={{ padding: '4px 2px', fontSize: 9.5 }}
              onClick={() => setRightTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {rightTab === 'telemetry' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <div style={{ background: 'rgba(10,11,15,0.55)', padding: 7, borderRadius: 7 }}>
                <div style={{ fontSize: 9, color: 'var(--bone-muted)' }}>COMPLETED</div>
                <AnimatedTicker value={metrics.jobsCompleted} />
              </div>
              <div style={{ background: 'rgba(10,11,15,0.55)', padding: 7, borderRadius: 7 }}>
                <div style={{ fontSize: 9, color: 'var(--bone-muted)' }}>THROUGHPUT</div>
                <AnimatedTicker value={metrics.throughputPer100Ticks} decimals={1} suffix="/100t" />
              </div>
              <div style={{ background: 'rgba(10,11,15,0.55)', padding: 7, borderRadius: 7 }}>
                <div style={{ fontSize: 9, color: 'var(--bone-muted)' }}>AVG / P95 WAIT</div>
                <div className="display-num" style={{ fontSize: 13 }}>
                  {metrics.avgWaitTime.toFixed(1)}t / {metrics.p95WaitTime.toFixed(0)}t
                </div>
              </div>
              <div style={{ background: 'rgba(10,11,15,0.55)', padding: 7, borderRadius: 7 }}>
                <div style={{ fontSize: 9, color: 'var(--bone-muted)' }}>DEADLOCKS PREV.</div>
                <div className="display-num" style={{ fontSize: 13, color: 'var(--lime)' }}>
                  {metrics.predictedDeadlocksResolved} / {metrics.reactiveDeadlocksResolved}
                </div>
              </div>
            </div>

            <TelemetryCharts
              series={seriesRef.current}
              compareSeries={abSplitActive ? branchSeriesRef.current : undefined}
            />

            <div>
              <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 4 }}>
                <BatteryCharging size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                FLEET BATTERY ({state.profile.batterySafetyReserve}% RESERVE)
              </div>
              {Object.values(state.robots)
                .slice(0, 7)
                .map((r) => (
                  <div
                    key={r.id}
                    onClick={() => setSelectedRobotId(r.id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 10.5,
                      padding: '2px 5px',
                      cursor: 'pointer',
                      color: r.battery < state.profile.batterySafetyReserve + 10 ? '#FF5A4E' : 'var(--bone)',
                    }}
                  >
                    <span>{r.id}</span>
                    <span>{r.battery.toFixed(1)}%</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {rightTab === 'custody' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {Object.values(state.custody).map((c) => (
              <div
                key={c.packageId}
                style={{
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: 'rgba(10,11,15,0.6)',
                  fontSize: 10.5,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <b>{c.packageId}</b>
                  <span style={{ color: c.state === 'STRANDED' ? '#FF5A4E' : '#C6FF3D' }}>
                    {c.state} (ep.{c.epoch})
                  </span>
                </div>
                <div style={{ color: 'var(--bone-muted)' }}>
                  Owner: {c.ownerRobotId ?? 'none'} | ({c.cell.x},{c.cell.y})
                </div>
              </div>
            ))}
          </div>
        )}

        {rightTab === 'decisions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              type="text"
              className="glass-input"
              placeholder="Search robot, job, package, tick..."
              value={decisionSearch}
              onChange={(e) => setDecisionSearch(e.target.value)}
            />
            <select
              className="glass-select"
              value={decisionCategoryFilter}
              onChange={(e) => setDecisionCategoryFilter(e.target.value as DecisionCategory | 'ALL')}
            >
              <option value="ALL">All Categories</option>
              <option value="ASSIGNMENT">Assignment</option>
              <option value="PRIORITY_CHANGE">Priority Change</option>
              <option value="CONGESTION_AVOIDANCE">Congestion / Deadlock</option>
              <option value="BATTERY_CHARGING">Battery</option>
              <option value="HUMAN_SAFETY_STOP">Human Safety</option>
              <option value="PACKAGE_MISMATCH">Package Mismatch</option>
              <option value="FAILURE_RECOVERY">Failure Recovery</option>
            </select>
            {filteredDecisions.map((d) => (
              <div
                key={d.seq}
                onClick={() => {
                  if (d.robotId && state.robots[d.robotId]) {
                    setSelectedRobotId(d.robotId);
                    setHighlightedCell({ ...state.robots[d.robotId]!.cell });
                  }
                }}
                style={{
                  padding: '5px 7px',
                  borderRadius: 6,
                  background: 'rgba(10,11,15,0.6)',
                  cursor: 'pointer',
                  fontSize: 10,
                }}
              >
                <div style={{ color: 'var(--lime)' }}>
                  t={d.tick} {d.decision}
                </div>
                <div style={{ marginTop: 2 }}>{d.reason}</div>
              </div>
            ))}
          </div>
        )}

        {rightTab === 'optimize' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="glass-btn glass-btn-accent" onClick={handleRunAutoOptimize}>
              <Wrench size={12} />
              Analyze Heatmap & Simulate Diff
            </button>
            {optComparison ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10.5 }}>
                <div style={{ background: 'rgba(10,11,15,0.62)', padding: 8, borderRadius: 7 }}>
                  <div>
                    Throughput: {optComparison.baseline.throughputPer100Ticks} -&gt;{' '}
                    <b style={{ color: '#C6FF3D' }}>{optComparison.optimized.throughputPer100Ticks}</b>{' '}
                    ({optComparison.deltas.throughputDelta >= 0 ? '+' : ''}
                    {optComparison.deltas.throughputDelta})
                  </div>
                  <div>
                    Avg Wait: {optComparison.baseline.avgWaitTime}t -&gt;{' '}
                    <b>{optComparison.optimized.avgWaitTime}t</b> ({optComparison.deltas.avgWaitDelta}t)
                  </div>
                  <div>
                    Congestion: {(optComparison.baseline.congestionIndex * 100).toFixed(1)}% -&gt;{' '}
                    <b>{(optComparison.optimized.congestionIndex * 100).toFixed(1)}%</b>
                  </div>
                </div>
                {optComparison.proposals.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      padding: 6,
                      borderRadius: 6,
                      background: 'rgba(10,11,15,0.55)',
                      fontSize: 10,
                    }}
                  >
                    <b>{p.kind}</b>: {p.reason}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 10.5, color: 'var(--bone-muted)' }}>
                Click above to inspect congestion hotspots, propose passing bays/cross-aisles, and verify real counterfactual KPIs.
              </div>
            )}
          </div>
        )}

        {rightTab === 'calibration' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontSize: 9.5, color: 'var(--ice)', background: 'var(--ice-soft)', padding: 6, borderRadius: 6 }}>
              {CALIBRATION_DISCLAIMER}
            </div>
            <div style={{ fontSize: 10.5, background: 'rgba(10,11,15,0.6)', padding: 7, borderRadius: 7 }}>
              <div>Travel Error: <b>{calibrationReport.meanAbsTravelTickError}t</b></div>
              <div>Battery Error: <b>{calibrationReport.meanAbsBatteryDrainError}%</b></div>
              <button
                className="glass-btn glass-btn-accent"
                style={{ width: '100%', marginTop: 5 }}
                onClick={() => {
                  const obs = [
                    {
                      id: 'field-run-1',
                      distanceCells: 12,
                      payloadKg: 4,
                      slowCellsCount: 2,
                      observedTravelTicks: 17,
                      observedBatteryDrainPct: 3.1,
                      measuredFriction: 0.78,
                    },
                  ];
                  const fitted = fitCalibratedProfile(state.profile, obs);
                  engineRef.current.setProfile(fitted, obs);
                  setProfileText(exportProfileJSON(fitted));
                  setProfileStatus(`Applied calibrated profile "${fitted.name}"`);
                  bump();
                }}
              >
                <Sliders size={12} />
                Fit Calibrated Profile
              </button>
            </div>
            <textarea
              className="glass-input thin-scroll"
              rows={9}
              value={profileText}
              onChange={(e) => setProfileText(e.target.value)}
            />
            <button
              className="glass-btn"
              onClick={() => {
                try {
                  const imported = importProfileJSON(profileText);
                  engineRef.current.setProfile(imported);
                  setProfileStatus(`Applied profile "${imported.name}"`);
                  bump();
                } catch (err) {
                  setProfileStatus(`Invalid JSON: ${(err as Error).message}`);
                }
              }}
            >
              Apply Profile JSON
            </button>
            {profileStatus && <div style={{ fontSize: 10, color: 'var(--lime)' }}>{profileStatus}</div>}
          </div>
        )}
      </aside>

      {/* BOTTOM TIME-TRAVEL SCRUBBER */}
      <footer
        className="liquid-glass liquid-glass-edge"
        style={{
          position: 'fixed',
          bottom: 10,
          left: 12,
          right: 12,
          height: 52,
          padding: '0 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          zIndex: 35,
        }}
      >
        <button
          className="glass-btn"
          onClick={() => {
            setRunning(false);
            engineRef.current.rewindTo(Math.max(0, state.tick - 1));
            bump();
          }}
        >
          <StepBack size={13} />
        </button>

        <span className="display-num" style={{ fontSize: 13, minWidth: 70 }}>
          TICK {state.tick}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(state.tick, maxRecordedTick)}
          value={state.tick}
          onChange={(e) => {
            setRunning(false);
            engineRef.current.rewindTo(Number(e.target.value));
            bump();
          }}
          style={{ flex: 1, accentColor: '#C6FF3D' }}
        />

        <span style={{ fontSize: 10, color: 'var(--bone-muted)', minWidth: 88 }}>
          HASH {engineRef.current.stateHash().slice(0, 8)}
        </span>

        <select
          className="glass-select"
          value={branchPolicyMode}
          onChange={(e) =>
            setBranchPolicyMode(e.target.value as 'PRIORITY_AGING' | 'AUCTION_REBID')
          }
        >
          <option value="AUCTION_REBID">Branch: Auction Rebid</option>
          <option value="PRIORITY_AGING">Branch: Priority Aging</option>
        </select>

        <button className="glass-btn glass-btn-ice" onClick={handleBranchPolicy}>
          <GitBranch size={13} />
          Branch with Policy
        </button>

        {abSplitActive && (
          <button
            className="glass-btn"
            onClick={() => {
              branchEngineRef.current = null;
              setAbSplitActive(false);
              bump();
            }}
          >
            Close A/B
          </button>
        )}
      </footer>
    </div>
  );
};

export const App: React.FC = () => {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary key={resetKey} onReset={() => setResetKey((k) => k + 1)}>
      <ArenaApp />
    </ErrorBoundary>
  );
};
