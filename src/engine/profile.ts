import { SimulationProfile } from './types';

export const DEFAULT_SIMULATION_PROFILE: SimulationProfile = {
  name: 'standard-warehouse-v2',
  groundFriction: 0.85,
  baseSpeed: 1.0,
  acceleration: 1.0,
  deceleration: 1.0,
  payloadSpeedFactor: 0.015,
  payloadDrainFactor: 0.01,
  sensorRange: 3,
  sensorNoise: 0.0,
  baseBatteryDrain: 0.12,
  idleBatteryDrain: 0.01,
  chargeRate: 2.5,
  agingIntervalTicks: 50,
  batterySafetyReserve: 12.0,
  humanBufferRadius: 2,
  humanStaleTimeoutTicks: 8,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function createSimulationProfile(
  overrides: Partial<SimulationProfile> = {}
): SimulationProfile {
  const m: SimulationProfile = { ...DEFAULT_SIMULATION_PROFILE, ...overrides };
  return {
    name: String(m.name || 'custom-profile'),
    groundFriction: clamp(m.groundFriction, 0.1, 1.0),
    baseSpeed: clamp(m.baseSpeed, 0.2, 1.0),
    acceleration: clamp(m.acceleration, 0.1, 2.0),
    deceleration: clamp(m.deceleration, 0.1, 2.0),
    payloadSpeedFactor: clamp(m.payloadSpeedFactor, 0, 0.5),
    payloadDrainFactor: clamp(m.payloadDrainFactor, 0, 0.5),
    sensorRange: Math.round(clamp(m.sensorRange, 1, 10)),
    sensorNoise: clamp(m.sensorNoise, 0, 0.5),
    baseBatteryDrain: clamp(m.baseBatteryDrain, 0, 5),
    idleBatteryDrain: clamp(m.idleBatteryDrain, 0, 1),
    chargeRate: clamp(m.chargeRate, 0.1, 20),
    agingIntervalTicks: Math.max(1, Math.round(m.agingIntervalTicks)),
    batterySafetyReserve: clamp(m.batterySafetyReserve, 0, 80),
    humanBufferRadius: Math.round(clamp(m.humanBufferRadius, 1, 6)),
    humanStaleTimeoutTicks: Math.max(1, Math.round(m.humanStaleTimeoutTicks)),
  };
}

export function exportProfileJSON(profile: SimulationProfile): string {
  return JSON.stringify(profile, null, 2);
}

export function importProfileJSON(rawJson: string): SimulationProfile {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid simulation profile JSON');
  }
  return createSimulationProfile(parsed as Partial<SimulationProfile>);
}
