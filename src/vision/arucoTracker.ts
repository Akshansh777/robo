import { Coord } from '../engine';

export interface DetectedArucoMarker {
  id: number;
  center: { x: number; y: number };
  gridCell: Coord | null;
}

/**
 * Maps camera pixel coordinates inside a 4-corner calibrated physical table quadrilateral
 * onto normalized [0, 1] x [0, 1] table coordinates via bilinear inverse interpolation.
 */
export function mapPointToCalibratedGrid(
  pt: { x: number; y: number },
  corners: readonly { x: number; y: number }[],
  gridWidth: number,
  gridHeight: number
): Coord | null {
  if (corners.length !== 4) return null;
  const [tl, tr, br, bl] = corners as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number }
  ];

  // Iterative Newton-Raphson inversion of bilinear quad mapping
  let u = 0.5;
  let v = 0.5;
  for (let iter = 0; iter < 6; iter++) {
    const px =
      (1 - u) * (1 - v) * tl.x +
      u * (1 - v) * tr.x +
      u * v * br.x +
      (1 - u) * v * bl.x;
    const py =
      (1 - u) * (1 - v) * tl.y +
      u * (1 - v) * tr.y +
      u * v * br.y +
      (1 - u) * v * bl.y;

    const errX = pt.x - px;
    const errY = pt.y - py;
    if (Math.abs(errX) + Math.abs(errY) < 0.5) break;

    const dPxDu = (1 - v) * (tr.x - tl.x) + v * (br.x - bl.x);
    const dPxDv = (1 - u) * (bl.x - tl.x) + u * (br.x - tr.x);
    const dPyDu = (1 - v) * (tr.y - tl.y) + v * (br.y - bl.y);
    const dPyDv = (1 - u) * (bl.y - tl.y) + u * (br.y - tr.y);

    const det = dPxDu * dPyDv - dPxDv * dPyDu;
    if (Math.abs(det) < 1e-5) break;

    u += (errX * dPyDv - errY * dPxDv) / det;
    v += (dPxDu * errY - dPyDu * errX) / det;
  }

  if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) return null;
  const gx = Math.max(0, Math.min(gridWidth - 1, Math.floor(u * gridWidth)));
  const gy = Math.max(0, Math.min(gridHeight - 1, Math.floor(v * gridHeight)));
  return { x: gx, y: gy };
}

export class PhysicalTableArucoTracker {
  private detector: { detect(imageData: ImageData): Array<{ id: number; corners: Array<{ x: number; y: number }> }> } | null = null;

  async init(): Promise<{ ok: boolean; error?: string }> {
    try {
      const mod = await import('js-aruco2');
      const AR = (mod as unknown as { AR?: { Detector: new () => unknown }; default?: { AR?: { Detector: new () => unknown } } }).AR ??
        (mod as unknown as { default?: { AR?: { Detector: new () => unknown } } }).default?.AR;
      if (!AR?.Detector) {
        return { ok: false, error: 'ArUco detector unavailable in bundle.' };
      }
      this.detector = new AR.Detector() as {
        detect(imageData: ImageData): Array<{ id: number; corners: Array<{ x: number; y: number }> }>;
      };
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `ArUco module failed to load (${(err as Error).message}).`,
      };
    }
  }

  detectMarkers(
    imageData: ImageData,
    tableCorners: readonly { x: number; y: number }[],
    gridWidth: number,
    gridHeight: number
  ): DetectedArucoMarker[] {
    if (!this.detector) return [];
    const raw = this.detector.detect(imageData);
    return raw.map((m) => {
      const cx = m.corners.reduce((s, c) => s + c.x, 0) / Math.max(1, m.corners.length);
      const cy = m.corners.reduce((s, c) => s + c.y, 0) / Math.max(1, m.corners.length);
      return {
        id: m.id,
        center: { x: cx, y: cy },
        gridCell: mapPointToCalibratedGrid({ x: cx, y: cy }, tableCorners, gridWidth, gridHeight),
      };
    });
  }
}
