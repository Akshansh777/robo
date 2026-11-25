import { Coord } from '../engine';

export type DetectedGesture = 'NONE' | 'PINCH' | 'POINT' | 'OPEN_PALM' | 'FIST';

export interface HandLandmarkPoint {
  x: number;
  y: number;
  z: number;
}

export interface HandFrameResult {
  gesture: DetectedGesture;
  cursorNorm: { x: number; y: number } | null;
  gridCell: Coord | null;
  landmarks: HandLandmarkPoint[];
}

interface VisionTaskLike {
  detectForVideo(
    video: HTMLVideoElement,
    timestampMs: number
  ): { landmarks?: HandLandmarkPoint[][] };
  close(): void;
}

/**
 * Offline-capable MediaPipe Hand Landmarker wrapper with:
 * - Local WASM & .task model loading (`/mediapipe/wasm`, `/mediapipe/hand_landmarker.task`)
 * - Exponential cursor smoothing + multi-frame gesture debouncing
 * - Graceful error handling when camera or local model files are unavailable
 */
export class WebcamHandController {
  private landmarker: VisionTaskLike | null = null;
  private smoothedX = 0.5;
  private smoothedY = 0.5;
  private candidateGesture: DetectedGesture = 'NONE';
  private candidateFrames = 0;
  private lastFiredGesture: DetectedGesture = 'NONE';
  private lastFireTimeMs = 0;

  async initLocal(
    wasmBasePath = '/mediapipe/wasm',
    modelAssetPath = '/mediapipe/hand_landmarker.task'
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmBasePath);
      this.landmarker = (await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      })) as unknown as VisionTaskLike;
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `Hand Landmarker unavailable (${(err as Error).message}). Mouse controls remain active.`,
      };
    }
  }

  detectFrame(
    video: HTMLVideoElement,
    nowMs: number,
    gridWidth: number,
    gridHeight: number
  ): { frame: HandFrameResult; debouncedTrigger: DetectedGesture | null } {
    if (!this.landmarker || video.readyState < 2) {
      return {
        frame: { gesture: 'NONE', cursorNorm: null, gridCell: null, landmarks: [] },
        debouncedTrigger: null,
      };
    }

    const res = this.landmarker.detectForVideo(video, nowMs);
    const hand = res.landmarks?.[0];
    if (!hand || hand.length < 21) {
      this.candidateGesture = 'NONE';
      this.candidateFrames = 0;
      return {
        frame: { gesture: 'NONE', cursorNorm: null, gridCell: null, landmarks: [] },
        debouncedTrigger: null,
      };
    }

    const wrist = hand[0]!;
    const thumbTip = hand[4]!;
    const indexTip = hand[8]!;
    const middleTip = hand[12]!;
    const ringTip = hand[16]!;
    const pinkyTip = hand[20]!;

    const dist = (a: HandLandmarkPoint, b: HandLandmarkPoint) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    const pinchDist = dist(thumbTip, indexTip);
    const indexExt = dist(indexTip, wrist) > dist(hand[6]!, wrist) * 1.15;
    const middleExt = dist(middleTip, wrist) > dist(hand[10]!, wrist) * 1.15;
    const ringExt = dist(ringTip, wrist) > dist(hand[14]!, wrist) * 1.15;
    const pinkyExt = dist(pinkyTip, wrist) > dist(hand[18]!, wrist) * 1.15;

    let rawGesture: DetectedGesture = 'NONE';
    if (pinchDist < 0.055) {
      rawGesture = 'PINCH';
    } else if (!indexExt && !middleExt && !ringExt && !pinkyExt) {
      rawGesture = 'FIST';
    } else if (indexExt && !middleExt && !ringExt && !pinkyExt) {
      rawGesture = 'POINT';
    } else if (indexExt && middleExt && ringExt && pinkyExt) {
      rawGesture = 'OPEN_PALM';
    }

    // Mirror X for natural webcam interaction + exponential smoothing
    const mirrorX = 1 - indexTip.x;
    this.smoothedX = this.smoothedX * 0.65 + mirrorX * 0.35;
    this.smoothedY = this.smoothedY * 0.65 + indexTip.y * 0.35;

    const gx = Math.max(0, Math.min(gridWidth - 1, Math.floor(this.smoothedX * gridWidth)));
    const gy = Math.max(0, Math.min(gridHeight - 1, Math.floor(this.smoothedY * gridHeight)));

    // Debounce: require 5 consecutive frames (~160ms at 30Hz) + 900ms cooldown
    if (rawGesture === this.candidateGesture && rawGesture !== 'NONE') {
      this.candidateFrames++;
    } else {
      this.candidateGesture = rawGesture;
      this.candidateFrames = rawGesture === 'NONE' ? 0 : 1;
    }

    let debouncedTrigger: DetectedGesture | null = null;
    const holdFramesNeeded = rawGesture === 'POINT' ? 12 : 5;
    if (
      this.candidateFrames >= holdFramesNeeded &&
      (rawGesture !== this.lastFiredGesture || nowMs - this.lastFireTimeMs > 1100)
    ) {
      debouncedTrigger = rawGesture;
      this.lastFiredGesture = rawGesture;
      this.lastFireTimeMs = nowMs;
    }

    return {
      frame: {
        gesture: rawGesture,
        cursorNorm: { x: this.smoothedX, y: this.smoothedY },
        gridCell: { x: gx, y: gy },
        landmarks: hand,
      },
      debouncedTrigger,
    };
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
