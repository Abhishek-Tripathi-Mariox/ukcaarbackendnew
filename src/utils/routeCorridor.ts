/**
 * Geographic corridor check for scheduled routes.
 *
 * A coord is "on" a stop if its great-circle distance to the stop is within
 * the route's `corridorBufferMeters`. A route matches a pickup+drop pair if
 * there are stops A and B in the route with sequence(A) < sequence(B) such
 * that pickup is on A and drop is on B. When drop is omitted (pickup-only
 * discovery), we relax to: pickup is on any stop in the route.
 */

interface Stop {
  lat: number;
  lng: number;
  sequence: number;
}

interface RouteShape {
  stops: Stop[];
  corridorBufferMeters: number;
}

interface Coord {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in metres. */
export function distanceMeters(a: Coord, b: Coord): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function routeMatchesCorridor(
  route: RouteShape,
  args: { pickup: Coord; drop?: Coord },
): boolean {
  if (!route.stops || route.stops.length === 0) return false;
  const buffer = route.corridorBufferMeters;
  const onStop = (c: Coord, s: Stop) => distanceMeters(c, s) <= buffer;

  if (!args.drop) {
    return route.stops.some((s) => onStop(args.pickup, s));
  }

  const pickupStops = route.stops.filter((s) => onStop(args.pickup!, s));
  if (pickupStops.length === 0) return false;
  const dropStops = route.stops.filter((s) => onStop(args.drop!, s));
  if (dropStops.length === 0) return false;

  for (const p of pickupStops) {
    for (const d of dropStops) {
      if (p.sequence < d.sequence) return true;
    }
  }
  return false;
}
