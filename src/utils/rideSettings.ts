import { Settings } from '../models/Settings';
import { config } from '../config';

/**
 * Resolved platform money settings used by ride settlement and the admin
 * Fare Calculation page. Values come from the `Settings` singleton when an
 * admin has overridden them, otherwise from the static `config.ride`
 * defaults. Cached briefly so hot ride paths don't hit Mongo every time.
 */
export interface RideSettings {
  commissionRate: number;
  onePassCommissionRate: number;
  cancellationFee: number;
  minFare: number;
  /** Driver-discovery radius in km — dispatch, ride-type list and socket
   *  broadcast all read this one value. */
  searchRadiusKm: number;
}

let cache: { value: RideSettings; at: number } | null = null;
const TTL_MS = 30_000;

export async function getRideSettings(force = false): Promise<RideSettings> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const doc = await Settings.findOne({ key: 'platform' }).lean();
  const value: RideSettings = {
    commissionRate: numOr(doc?.commissionRate, config.ride.commissionRate),
    onePassCommissionRate: numOr(
      doc?.onePassCommissionRate,
      config.ride.onePassCommissionRate
    ),
    cancellationFee: numOr(doc?.cancellationFee, config.ride.cancellationFee),
    minFare: numOr(doc?.minFare, config.ride.minFare),
    // Sourced from the admin Settings → General "Max Search Radius" field,
    // which already existed in the model, the save endpoint and the admin UI
    // but was read by nothing — an admin could change it and see no effect.
    searchRadiusKm: numOr(doc?.maxSearchRadius, config.ride.searchRadiusKm),
  };
  cache = { value, at: Date.now() };
  return value;
}

/** Drop the cache so the next read reflects a just-saved change. */
export function clearRideSettingsCache(): void {
  cache = null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
