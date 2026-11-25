import { createSimulationProfile } from './profile';
import {
  CalibrationComparisonItem,
  CalibrationObservation,
  CalibrationReport,
  SimulationProfile,
} from './types';

export const CALIBRATION_DISCLAIMER =
  'Calibration adjusts parameters of a simplified discrete-time simulator against offline measurements; it is not proof that a physical warehouse robot will behave identically in production.';

/**
 * Predicts travel ticks and battery drain for a segment under a given SimulationProfile.
 */
export function simulateSegmentMetrics(
  profile: SimulationProfile,
  obs: Pick<CalibrationObservation, 'distanceCells' | 'payloadKg' | 'slowCellsCount'>
): { simulatedTravelTicks: number; simulatedBatteryDrainPct: number } {
  const normalCells = Math.max(0, obs.distanceCells - obs.slowCellsCount);
  const slowCells = Math.max(0, obs.slowCellsCount);

  const payloadDivisor = 1 + obs.payloadKg * profile.payloadSpeedFactor;
  const frictionMult = 0.5 + 0.5 * profile.groundFriction;

  const vNormal = Math.max(
    0.2,
    Math.min(1.0, (profile.baseSpeed * frictionMult) / payloadDivisor)
  );
  const vSlow = Math.max(
    0.2,
    Math.min(1.0, (profile.baseSpeed * 0.5 * frictionMult) / payloadDivisor)
  );

  const ticksNormal = normalCells / vNormal;
  const ticksSlow = slowCells / vSlow;
  const simulatedTravelTicks = ticksNormal + ticksSlow;

  const drainPerTick =
    profile.baseBatteryDrain + obs.payloadKg * profile.payloadDrainFactor;
  const simulatedBatteryDrainPct = simulatedTravelTicks * drainPerTick;

  return { simulatedTravelTicks, simulatedBatteryDrainPct };
}

/**
 * Compares offline empirical measurements with simulated predictions under `profile`.
 */
export function evaluateCalibration(
  profile: SimulationProfile,
  observations: readonly CalibrationObservation[]
): CalibrationReport {
  const items: CalibrationComparisonItem[] = [];
  let sumTravelErr = 0;
  let sumDrainErr = 0;

  for (const obs of observations) {
    const sim = simulateSegmentMetrics(profile, obs);
    const travelTickDelta = sim.simulatedTravelTicks - obs.observedTravelTicks;
    const batteryDrainDelta =
      sim.simulatedBatteryDrainPct - obs.observedBatteryDrainPct;

    sumTravelErr += Math.abs(travelTickDelta);
    sumDrainErr += Math.abs(batteryDrainDelta);

    items.push({
      observationId: obs.id,
      simulatedTravelTicks: Number(sim.simulatedTravelTicks.toFixed(3)),
      observedTravelTicks: obs.observedTravelTicks,
      travelTickDelta: Number(travelTickDelta.toFixed(3)),
      simulatedBatteryDrainPct: Number(sim.simulatedBatteryDrainPct.toFixed(3)),
      observedBatteryDrainPct: obs.observedBatteryDrainPct,
      batteryDrainDelta: Number(batteryDrainDelta.toFixed(3)),
    });
  }

  const n = Math.max(1, observations.length);
  return {
    disclaimer: CALIBRATION_DISCLAIMER,
    profileName: profile.name,
    sampleCount: observations.length,
    meanAbsTravelTickError: observations.length ? Number((sumTravelErr / n).toFixed(3)) : 0,
    meanAbsBatteryDrainError: observations.length ? Number((sumDrainErr / n).toFixed(3)) : 0,
    items,
  };
}

/**
 * Fits a revised SimulationProfile from offline measured observations (friction, speed, payload, battery drain).
 */
export function fitCalibratedProfile(
  baseProfile: SimulationProfile,
  observations: readonly CalibrationObservation[],
  revisedName = `${baseProfile.name}-calibrated`
): SimulationProfile {
  if (observations.length === 0) {
    return createSimulationProfile({ ...baseProfile, name: revisedName });
  }

  let frictionSum = 0;
  let frictionCount = 0;
  let drainPerTickSum = 0;
  let speedScaleSum = 0;

  for (const obs of observations) {
    if (obs.measuredFriction !== undefined) {
      frictionSum += obs.measuredFriction;
      frictionCount++;
    }
    const sim = simulateSegmentMetrics(baseProfile, obs);
    if (obs.observedTravelTicks > 0) {
      speedScaleSum += sim.simulatedTravelTicks / obs.observedTravelTicks;
      drainPerTickSum += obs.observedBatteryDrainPct / obs.observedTravelTicks;
    }
  }

  const avgFriction =
    frictionCount > 0 ? frictionSum / frictionCount : baseProfile.groundFriction;
  const avgSpeedScale = speedScaleSum / observations.length;
  const avgObservedDrain = drainPerTickSum / observations.length;

  return createSimulationProfile({
    ...baseProfile,
    name: revisedName,
    groundFriction: avgFriction,
    baseSpeed: baseProfile.baseSpeed * avgSpeedScale,
    baseBatteryDrain: Math.max(0.01, avgObservedDrain),
  });
}
