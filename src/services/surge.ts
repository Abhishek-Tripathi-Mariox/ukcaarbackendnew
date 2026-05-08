import { Types } from 'mongoose';
import { Zone, IZone, SurgeRule, ISurgeRule } from '../models';

export interface SurgeResolution {
  /** Multiplier applied to (base + distance + time) fare. 1 = no surge. */
  multiplier: number;
  /** Flat surcharge added on top after multiplier. */
  flatSurcharge: number;
  /** Surge fare amount = subtotal * (multiplier-1) + flatSurcharge. */
  surgeAmount: number;
  /** Reasons / sources that contributed (for transparency / receipts). */
  reasons: string[];
  /** Zones containing this point (for analytics). */
  zoneIds: Types.ObjectId[];
}

const NO_SURGE: SurgeResolution = {
  multiplier: 1,
  flatSurcharge: 0,
  surgeAmount: 0,
  reasons: [],
  zoneIds: [],
};

export const NO_PICKUP_REASON = '__no_pickup__';

/**
 * Find every active zone whose polygon contains (lat, lng).
 * Uses MongoDB $geoIntersects for true point-in-polygon (works for concave shapes).
 */
async function zonesContaining(lat: number, lng: number): Promise<IZone[]> {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    Number.isNaN(lat) ||
    Number.isNaN(lng)
  ) {
    return [];
  }
  return Zone.find({
    isActive: true,
    geometry: {
      $geoIntersects: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
      },
    },
  });
}

/** Returns true if the given pickup is inside any active no-pickup / restricted zone. */
export async function isPickupBlocked(
  lat: number,
  lng: number
): Promise<{ blocked: boolean; zone?: IZone }> {
  const zones = await zonesContaining(lat, lng);
  const blocker = zones.find((z) => z.kind === 'no_pickup' || z.kind === 'restricted');
  return { blocked: !!blocker, zone: blocker };
}

function ruleMatchesTime(rule: ISurgeRule, when: Date): boolean {
  if (rule.startDate && when < rule.startDate) return false;
  if (rule.endDate && when > rule.endDate) return false;
  const dow = when.getDay();
  if (rule.daysOfWeek.length && !rule.daysOfWeek.includes(dow)) return false;
  const minute = when.getHours() * 60 + when.getMinutes();
  const { startMinute, endMinute } = rule;
  if (startMinute === endMinute) return true; // 24h window
  if (startMinute < endMinute) {
    return minute >= startMinute && minute < endMinute;
  }
  // wraps midnight
  return minute >= startMinute || minute < endMinute;
}

/**
 * Resolve the active surge for a pickup point at a given time.
 * Logic:
 *  1. Look up zones containing the point.
 *  2. Start with multiplier from highest 'surge' kind zone (if any).
 *  3. Add flatSurcharge from every airport / surge zone the point sits in.
 *  4. Evaluate active surge rules whose schedule + zone scope match;
 *     pick the highest-priority match (then highest multiplier).
 *  5. Combine: rule overrides the zone multiplier when present.
 */
export async function resolveSurge(
  lat: number,
  lng: number,
  subtotal: number,
  when: Date = new Date()
): Promise<SurgeResolution> {
  const zones = await zonesContaining(lat, lng);
  const reasons: string[] = [];
  let multiplier = 1;
  let flatSurcharge = 0;

  // Zone-static surge (highest multiplier wins among 'surge' zones)
  const surgeZones = zones.filter((z) => z.kind === 'surge' && z.surgeMultiplier > 1);
  if (surgeZones.length) {
    const winner = surgeZones.reduce((a, b) =>
      a.surgeMultiplier >= b.surgeMultiplier ? a : b
    );
    multiplier = winner.surgeMultiplier;
    reasons.push(`Surge zone "${winner.name}" ×${winner.surgeMultiplier}`);
  }
  for (const z of zones) {
    if (z.flatSurcharge > 0) {
      flatSurcharge += z.flatSurcharge;
      reasons.push(`${z.name} surcharge +${z.flatSurcharge.toFixed(2)}`);
    }
  }

  // Schedule-based rules
  const zoneIds = zones.map((z) => z._id);
  const rules = await SurgeRule.find({
    isActive: true,
    $or: [{ zone: { $exists: false } }, { zone: null }, { zone: { $in: zoneIds } }],
  }).sort({ priority: -1, multiplier: -1 });

  const matchingRule = rules.find((r) => ruleMatchesTime(r, when));
  if (matchingRule) {
    if (matchingRule.multiplier > multiplier) {
      multiplier = matchingRule.multiplier;
      reasons.push(`Rule "${matchingRule.name}" ×${matchingRule.multiplier}`);
    }
    if (matchingRule.flatSurcharge > 0) {
      flatSurcharge += matchingRule.flatSurcharge;
      reasons.push(
        `Rule "${matchingRule.name}" +${matchingRule.flatSurcharge.toFixed(2)}`
      );
    }
  }

  if (multiplier === 1 && flatSurcharge === 0) {
    return { ...NO_SURGE, zoneIds };
  }

  const surgeAmount =
    Math.round((subtotal * (multiplier - 1) + flatSurcharge) * 100) / 100;

  return {
    multiplier,
    flatSurcharge,
    surgeAmount,
    reasons,
    zoneIds,
  };
}

export async function safeResolveSurge(
  lat: number,
  lng: number,
  subtotal: number,
  when: Date = new Date()
): Promise<SurgeResolution> {
  try {
    return await resolveSurge(lat, lng, subtotal, when);
  } catch (err) {
    console.error('[surge] resolution failed, defaulting to 1×:', err);
    return NO_SURGE;
  }
}
