import { config } from '../config';

/**
 * Road-routing lookup shared by the /geo/directions proxy and the ride
 * estimate/create fallbacks in rideController. Prefers Google Directions
 * (real road snapping) when the key is configured, falls back to OSRM's
 * public router, and as a last resort returns a straight line (haversine
 * distance + a 30 km/h duration heuristic) so callers always get
 * *something*. Never throws.
 */

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RouteResult {
  provider: 'google' | 'osrm' | 'straight';
  polyline: RoutePoint[];
  distanceMeters: number;
  durationSeconds: number;
}

const googleKey = (): string => {
  const k = config.google?.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY || '';
  if (!k || /your_google|YOUR_GOOGLE/i.test(k)) return '';
  return k;
};

/** Haversine distance in kilometres. */
export const haversineKm = (a: RoutePoint, b: RoutePoint): number => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Google encoded polyline → [{lat,lng}, …]. Algorithm: ascii85-ish var-int
// signed delta encoding. Lifted from Google's spec; small enough to inline
// rather than pull a dep.
const decodePolyline = (str: string): RoutePoint[] => {
  const points: RoutePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLatEnc = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLatEnc;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLngEnc = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLngEnc;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
};

/**
 * Driving route between two coordinates: Google → OSRM → straight line.
 * Always resolves — the straight-line fallback guarantees a result even
 * when both routers are unreachable.
 */
export async function getRoute(origin: RoutePoint, dest: RoutePoint): Promise<RouteResult> {
  // ── Provider 1: Google Directions ──────────────────────────────────
  const gKey = googleKey();
  if (gKey) {
    try {
      const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
      u.searchParams.set('origin', `${origin.lat},${origin.lng}`);
      u.searchParams.set('destination', `${dest.lat},${dest.lng}`);
      u.searchParams.set('mode', 'driving');
      u.searchParams.set('key', gKey);
      const r = await fetch(u.toString());
      const j: any = await r.json();
      if (j?.status === 'OK' && j.routes?.[0]) {
        const route = j.routes[0];
        const leg = route.legs?.[0] ?? {};
        return {
          provider: 'google',
          polyline: decodePolyline(route.overview_polyline?.points ?? ''),
          distanceMeters: leg.distance?.value ?? 0,
          durationSeconds: leg.duration?.value ?? 0,
        };
      }
      console.warn('[routing] google directions fallback:', j?.status, j?.error_message);
    } catch (gErr) {
      console.warn('[routing] google directions error, falling back:', gErr);
    }
  }

  // ── Provider 2: OSRM public router (free, demo-grade) ──────────────
  try {
    const osrmUrl =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
    const r = await fetch(osrmUrl);
    const j: any = await r.json();
    if (j?.code === 'Ok' && j.routes?.[0]) {
      const route = j.routes[0];
      const coords: Array<[number, number]> = route.geometry?.coordinates ?? [];
      return {
        provider: 'osrm',
        polyline: coords.map(([lng, lat]) => ({ lat, lng })),
        distanceMeters: route.distance ?? 0,
        durationSeconds: route.duration ?? 0,
      };
    }
  } catch (osrmErr) {
    console.warn('[routing] osrm directions error:', osrmErr);
  }

  // ── Provider 3: Straight line fallback ─────────────────────────────
  // Last resort so callers always get *something*. Distance is haversine;
  // duration is a 30 km/h heuristic.
  const distKm = haversineKm(origin, dest);
  return {
    provider: 'straight',
    polyline: [origin, dest],
    distanceMeters: Math.round(distKm * 1000),
    durationSeconds: Math.round((distKm / 30) * 3600),
  };
}

/**
 * Routed distance/duration in the units the ride pipeline persists:
 * km rounded to 1 decimal, whole minutes (min 1). Used by estimateFare /
 * createRide when the client didn't supply its own routed values.
 */
export async function getRouteEstimate(
  origin: RoutePoint,
  dest: RoutePoint,
): Promise<{ provider: RouteResult['provider']; distanceKm: number; durationMin: number }> {
  const r = await getRoute(origin, dest);
  return {
    provider: r.provider,
    distanceKm: Math.round((r.distanceMeters / 1000) * 10) / 10,
    durationMin: Math.max(1, Math.round(r.durationSeconds / 60)),
  };
}
