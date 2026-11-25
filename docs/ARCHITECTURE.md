# System Architecture & Module Boundaries

## 1. Layered Separation
1. **Pure Deterministic Core (`src/engine/`)**:
   - Zero DOM, Web Audio, Canvas, `fetch`, or wall-clock dependencies (`lastTickWallClockMs` is diagnostic-only and excluded from `stateHash()`).
   - Deterministic `mulberry32` PRNG state is serialized inside `SimSnapshot` and `ReplayBundle`.
2. **Hardware Vision Adapters (`src/vision/`)**:
   - `handTracker.ts`: Wraps `@mediapipe/tasks-vision` using local `/mediapipe/wasm` and `/mediapipe/hand_landmarker.task` assets, throttled to 20Hz with exponential cursor smoothing and multi-frame debouncing.
   - `arucoTracker.ts`: Wraps `js-aruco2` with 4-corner bilinear quadrilateral calibration to map physical paper markers onto `BLOCK_CELL` / `UNBLOCK_CELL` commands.
3. **Copilot & Local Intelligence (`src/ui/geminiCopilot.ts` & `src/engine/copilot_local.ts`)**:
   - Uses Gemini function calling when a user-supplied `localStorage` key is present; automatically falls back to deterministic regex/rule parsing and local telemetry Q&A when offline or unconfigured.
4. **Presentation & Canvas Renderer (`src/ui/`)**:
   - Full-bleed Canvas 2D renderer with sub-tick visual interpolation, fading motion trails, conflict-resolution pulses, and floating liquid-glass panels.
