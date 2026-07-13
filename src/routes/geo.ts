import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { config } from '../config';

/**
 * Geo proxy. Prefers Google Places when GOOGLE_MAPS_API_KEY is configured
 * (much better POI / fuzzy search), falls back to free OpenStreetMap
 * Nominatim otherwise. Both expose the same response shape so the clients
 * (admin, customer, driver) don't care which provider answered.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const GOOGLE_PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
const GOOGLE_GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  'UKCAAR-Backend/1.0 (contact: support@ukcaar.com)';

const googleKey = (): string => {
  const k = config.google?.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY || '';
  if (!k || /your_google|YOUR_GOOGLE/i.test(k)) return '';
  return k;
};

// ── In-memory caches ──────────────────────────────────────────────────────
// The autocomplete endpoint was doing an N+1 on every keystroke: one Places
// Autocomplete call, then a Place Details call for EACH of up to 8 predictions
// — 9 round-trips to Google per character typed. As the user types
// "a" → "ai" → "air" → "airp", the top predictions (and thus their place_ids)
// overlap almost entirely, so the same details were re-fetched every keystroke.
//
// Two small TTL caches collapse that: place_ids resolve to details once (they
// almost never change → long TTL, high hit-rate across successive keystrokes),
// and whole-query responses are memoised briefly so a backspace/retype or two
// riders searching the same thing don't hit Google at all. Bounded in size so
// a busy server can't leak memory. Process-local (no Redis needed) — a cache
// miss just falls through to the live fetch, so correctness never depends on it.
interface CacheEntry<T> {
  value: T;
  exp: number;
}
const DETAILS_TTL_MS = 60 * 60 * 1000; // place details are effectively static
const AC_TTL_MS = 2 * 60 * 1000; // whole-query results: short, for repeats
const DETAILS_CACHE_MAX = 5000;
const AC_CACHE_MAX = 2000;

const placeDetailsCache = new Map<string, CacheEntry<any>>();
const autocompleteCache = new Map<string, CacheEntry<any[]>>();

const cacheGet = <T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU recency: re-insert so it moves to the end of the Map.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const cacheSet = <T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  max: number,
): void => {
  cache.set(key, { value, exp: Date.now() + ttlMs });
  // Evict oldest entries (Map preserves insertion order) once over budget.
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

const router = Router();
router.use(authenticate);

interface NominatimSearchHit {
  place_id?: number;
  osm_id?: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  address?: {
    house_number?: string;
    road?: string;
    suburb?: string;
    neighbourhood?: string;
    village?: string;
    town?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  };
}

// Haversine distance in kilometres. Used to post-filter autocomplete hits to
// the requested radius around the customer's current location — necessary
// because neither Google's locationbias nor Nominatim's viewbox is a hard
// cutoff (they're bias/preference hints, not strict bounding).
const haversineKm = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
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

const buildAddressLine = (hit: NominatimSearchHit): string => {
  const a = hit.address ?? {};
  const parts = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.suburb || a.neighbourhood,
    a.village || a.town || a.city,
    a.state,
    a.postcode,
  ].filter(Boolean);
  // Prefer the upstream display_name when it carries more granularity than our
  // structured parts (it usually does — Nominatim's display_name includes
  // landmark/POI names, building numbers, locality chains, etc. that the
  // address object frequently misses for residential India). Fall back to
  // the structured join only when display_name is missing.
  if (hit.display_name && hit.display_name.length > 0) return hit.display_name;
  return parts.length > 0 ? parts.join(', ') : hit.display_name;
};

/**
 * GET /api/v1/geo/autocomplete?q=...&countrycodes=in&limit=8
 * Returns an array of { id, displayName, address, lat, lng, parts } for the
 * autocomplete dropdown. Defaults country to India since that's the primary
 * market; pass ?countrycodes= to override (or empty string to disable).
 */
router.get('/autocomplete', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      res.status(200).json({ success: true, data: { results: [] } });
      return;
    }

    const countryCodes =
      typeof req.query.countrycodes === 'string'
        ? req.query.countrycodes
        : 'in';
    const limit = Math.min(parseInt(String(req.query.limit ?? '8'), 10) || 8, 15);

    // Optional location bias + hard cutoff. When the customer passes their
    // current coordinates we restrict results to a radius around them so the
    // app doesn't surface destinations on the other side of the country.
    // Defaults to 10 km when lat/lng are present; the customer app always
    // sends these for ride-booking searches.
    const biasLat = parseFloat(String(req.query.lat ?? ''));
    const biasLng = parseFloat(String(req.query.lng ?? ''));
    const radiusKm =
      Math.max(0.5, parseFloat(String(req.query.radius ?? '10')) || 10);
    const hasBias = Number.isFinite(biasLat) && Number.isFinite(biasLng);

    // Whole-query cache. Key on the normalized query + country + limit +
    // rounded bias (2 dp ≈ 1 km grid so nearby riders share entries). A hit
    // returns the already-filtered result set with zero upstream calls.
    const acKey = JSON.stringify({
      q: q.toLowerCase(),
      countryCodes,
      limit,
      lat: hasBias ? biasLat.toFixed(2) : '',
      lng: hasBias ? biasLng.toFixed(2) : '',
      r: radiusKm,
    });
    const cachedAc = cacheGet(autocompleteCache, acKey);
    if (cachedAc) {
      res.status(200).json({ success: true, data: { results: cachedAc } });
      return;
    }

    // ── Provider 1: Google Places (preferred when key present) ──────────
    const key = googleKey();
    if (key) {
      try {
        const acUrl = new URL(`${GOOGLE_PLACES_BASE}/autocomplete/json`);
        acUrl.searchParams.set('input', q);
        acUrl.searchParams.set('key', key);
        if (countryCodes) {
          // Google expects "country:in" or "country:in|country:gb"
          const components = countryCodes
            .split(',')
            .map((c) => `country:${c.trim()}`)
            .join('|');
          acUrl.searchParams.set('components', components);
        }
        if (hasBias) {
          // locationbias=circle:RADIUS_METERS@lat,lng is a soft bias; we
          // still post-filter below to enforce the cutoff strictly.
          acUrl.searchParams.set(
            'locationbias',
            `circle:${Math.round(radiusKm * 1000)}@${biasLat},${biasLng}`,
          );
        }
        const acResp = await fetch(acUrl.toString());
        const acJson: any = await acResp.json();
        if (acJson?.status === 'OK' && Array.isArray(acJson.predictions)) {
          const preds = acJson.predictions.slice(0, limit);
          const results = await Promise.all(
            preds.map(async (p: any) => {
              try {
                // Resolve the prediction's details from cache when we can —
                // successive keystrokes share the same place_ids, so this is
                // where most of the latency win comes from.
                let r = cacheGet(placeDetailsCache, String(p.place_id));
                if (!r) {
                  const dUrl = new URL(`${GOOGLE_PLACES_BASE}/details/json`);
                  dUrl.searchParams.set('place_id', p.place_id);
                  dUrl.searchParams.set(
                    'fields',
                    'geometry/location,formatted_address,address_components,name'
                  );
                  dUrl.searchParams.set('key', key);
                  const dResp = await fetch(dUrl.toString());
                  const dJson: any = await dResp.json();
                  r = dJson?.result;
                  if (r?.geometry?.location) {
                    cacheSet(
                      placeDetailsCache,
                      String(p.place_id),
                      r,
                      DETAILS_TTL_MS,
                      DETAILS_CACHE_MAX,
                    );
                  }
                }
                if (!r?.geometry?.location) return null;
                const comps: any[] = r.address_components ?? [];
                const compOf = (type: string) =>
                  comps.find((c) => c.types?.includes(type))?.long_name ?? '';
                const compShortOf = (type: string) =>
                  comps.find((c) => c.types?.includes(type))?.short_name ?? '';
                return {
                  id: String(p.place_id),
                  displayName: r.formatted_address || p.description,
                  address: r.formatted_address || p.description,
                  lat: r.geometry.location.lat,
                  lng: r.geometry.location.lng,
                  parts: {
                    houseNumber: compOf('street_number'),
                    road: compOf('route'),
                    area:
                      compOf('sublocality_level_1') ||
                      compOf('sublocality') ||
                      compOf('neighborhood'),
                    city:
                      compOf('locality') ||
                      compOf('administrative_area_level_2'),
                    state: compOf('administrative_area_level_1'),
                    pincode: compOf('postal_code'),
                    country: compOf('country'),
                    countryCode: compShortOf('country').toLowerCase(),
                  },
                };
              } catch {
                return null;
              }
            })
          );
          const cleaned = results.filter(Boolean) as Array<{
            lat: number;
            lng: number;
            [k: string]: any;
          }>;
          // Soft post-filter: keep results inside the radius first, but if
          // that produces an empty list (typed query is a place outside the
          // bias radius), fall back to the full, unfiltered set so the user
          // still sees their search results.
          const withinRadius = hasBias
            ? cleaned.filter(
                (r) =>
                  haversineKm(
                    { lat: biasLat, lng: biasLng },
                    { lat: r.lat, lng: r.lng },
                  ) <= radiusKm,
              )
            : cleaned;
          const bounded = withinRadius.length > 0 ? withinRadius : cleaned;
          cacheSet(autocompleteCache, acKey, bounded, AC_TTL_MS, AC_CACHE_MAX);
          res.status(200).json({
            success: true,
            data: { results: bounded },
          });
          return;
        }
        // status REQUEST_DENIED / OVER_QUERY_LIMIT etc → fall through to OSM
        console.warn('[geo] google autocomplete fallback:', acJson?.status, acJson?.error_message);
      } catch (gErr) {
        console.warn('[geo] google autocomplete error, falling back:', gErr);
      }
    }

    // ── Provider 2: Nominatim (free fallback) ───────────────────────────
    const url = new URL(`${NOMINATIM_BASE}/search`);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));
    if (countryCodes) url.searchParams.set('countrycodes', countryCodes);
    if (hasBias) {
      // viewbox is left,top,right,bottom (lng/lat). Convert radius → degrees:
      // 1° lat ≈ 111 km; 1° lng shrinks by cos(lat). bounded=1 makes
      // Nominatim hard-restrict to the box (still belt-and-braces with the
      // haversine post-filter below for the exact radius).
      const dLat = radiusKm / 111;
      const dLng =
        radiusKm / (111 * Math.cos((biasLat * Math.PI) / 180) || 111);
      const left = biasLng - dLng;
      const right = biasLng + dLng;
      const top = biasLat + dLat;
      const bottom = biasLat - dLat;
      url.searchParams.set('viewbox', `${left},${top},${right},${bottom}`);
      url.searchParams.set('bounded', '1');
    }

    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!upstream.ok) {
      res.status(502).json({ success: false, message: 'Geocoder unavailable' });
      return;
    }
    let hits = (await upstream.json()) as NominatimSearchHit[];
    let unboundedFallback = false;

    // If the bounded search returns nothing, retry once without the viewbox.
    // Users frequently search for destinations outside the 10 km bias radius
    // (airports, train stations, malls in the next town over) and an empty
    // dropdown looks broken. Country restriction is kept so we don't surface
    // places from the other side of the world.
    if (hasBias && hits.length === 0) {
      const fallback = new URL(`${NOMINATIM_BASE}/search`);
      fallback.searchParams.set('q', q);
      fallback.searchParams.set('format', 'jsonv2');
      fallback.searchParams.set('addressdetails', '1');
      fallback.searchParams.set('limit', String(limit));
      if (countryCodes) fallback.searchParams.set('countrycodes', countryCodes);
      const fbResp = await fetch(fallback.toString(), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (fbResp.ok) {
        hits = (await fbResp.json()) as NominatimSearchHit[];
        unboundedFallback = true;
      }
    }

    const results = hits.map((h) => {
      const a = h.address ?? {};
      return {
        id: String(h.place_id ?? h.osm_id ?? `${h.lat},${h.lon}`),
        displayName: h.display_name,
        address: buildAddressLine(h),
        lat: parseFloat(h.lat),
        lng: parseFloat(h.lon),
        parts: {
          houseNumber: a.house_number ?? '',
          road: a.road ?? '',
          area: a.suburb ?? a.neighbourhood ?? '',
          city: a.city ?? a.town ?? a.village ?? '',
          state: a.state ?? '',
          pincode: a.postcode ?? '',
          country: a.country ?? '',
          countryCode: a.country_code ?? '',
        },
      };
    });

    const boundedNominatim = hasBias && !unboundedFallback
      ? results.filter(
          (r) =>
            haversineKm(
              { lat: biasLat, lng: biasLng },
              { lat: r.lat, lng: r.lng },
            ) <= radiusKm,
        )
      : results;

    cacheSet(autocompleteCache, acKey, boundedNominatim, AC_TTL_MS, AC_CACHE_MAX);
    res.status(200).json({ success: true, data: { results: boundedNominatim } });
  } catch (error) {
    console.error('[geo] autocomplete error:', error);
    res.status(500).json({ success: false, message: 'Autocomplete failed' });
  }
});

/**
 * GET /api/v1/geo/reverse?lat=&lng=
 * Reverse geocodes a coordinate pair to a structured address.
 */
router.get('/reverse', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(String(req.query.lat ?? ''));
    const lng = parseFloat(String(req.query.lng ?? ''));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ success: false, message: 'lat and lng are required' });
      return;
    }

    // ── Provider 1: Google reverse geocode (preferred when key present) ──
    // Google has actual street-level data in India where OSM/Nominatim is
    // often blank — for residential coordinates Nominatim only returns
    // "City, State, Pincode" because OSM has no road/house mapped there.
    // We pick the most precise result Google returns (street_address >
    // premise > route > neighborhood > locality) so the pickup row shows
    // the exact building/road instead of a city-level fallback.
    const gKey = googleKey();
    if (gKey) {
      try {
        const gUrl = new URL(GOOGLE_GEOCODE_BASE);
        gUrl.searchParams.set('latlng', `${lat},${lng}`);
        gUrl.searchParams.set('key', gKey);
        // result_type ordering: ask Google for the precise types first.
        // If none match it returns its default (broadest) results which we
        // still parse below.
        const gResp = await fetch(gUrl.toString());
        const gJson: any = await gResp.json();
        if (gJson?.status === 'OK' && Array.isArray(gJson.results) && gJson.results.length > 0) {
          const precision = [
            'street_address',
            'premise',
            'subpremise',
            'route',
            'intersection',
            'neighborhood',
            'sublocality',
            'locality',
          ];
          const pickBest = () => {
            for (const t of precision) {
              const m = gJson.results.find((r: any) => Array.isArray(r.types) && r.types.includes(t));
              if (m) return m;
            }
            return gJson.results[0];
          };
          const best: any = pickBest();
          const comps: any[] = best.address_components ?? [];
          const compOf = (type: string) =>
            comps.find((c) => c.types?.includes(type))?.long_name ?? '';
          const compShortOf = (type: string) =>
            comps.find((c) => c.types?.includes(type))?.short_name ?? '';
          const formatted = best.formatted_address as string;
          res.status(200).json({
            success: true,
            data: {
              displayName: formatted,
              address: formatted,
              lat: best.geometry?.location?.lat ?? lat,
              lng: best.geometry?.location?.lng ?? lng,
              parts: {
                houseNumber: compOf('street_number'),
                road: compOf('route'),
                area:
                  compOf('sublocality_level_1') ||
                  compOf('sublocality') ||
                  compOf('neighborhood'),
                city:
                  compOf('locality') ||
                  compOf('administrative_area_level_2'),
                state: compOf('administrative_area_level_1'),
                pincode: compOf('postal_code'),
                country: compOf('country'),
                countryCode: compShortOf('country').toLowerCase(),
              },
            },
          });
          return;
        }
        console.warn('[geo] google reverse fallback:', gJson?.status, gJson?.error_message);
      } catch (gErr) {
        console.warn('[geo] google reverse error, falling back to nominatim:', gErr);
      }
    }

    // ── Provider 2: Nominatim (free fallback) ───────────────────────────
    const url = new URL(`${NOMINATIM_BASE}/reverse`);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    // zoom=18 is "building"-level — the highest precision Nominatim supports.
    // Lower zooms collapse the result to suburb/city which is why the
    // customer app was showing "City, State, Pincode" instead of the actual
    // street/building. namedetails+extratags give us alt names / POI labels
    // that flow into display_name.
    url.searchParams.set('zoom', '18');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('extratags', '1');

    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!upstream.ok) {
      res.status(502).json({ success: false, message: 'Geocoder unavailable' });
      return;
    }
    const hit = (await upstream.json()) as NominatimSearchHit;
    const a = hit.address ?? {};

    res.status(200).json({
      success: true,
      data: {
        displayName: hit.display_name,
        address: buildAddressLine(hit),
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
        parts: {
          houseNumber: a.house_number ?? '',
          road: a.road ?? '',
          area: a.suburb ?? a.neighbourhood ?? '',
          city: a.city ?? a.town ?? a.village ?? '',
          state: a.state ?? '',
          pincode: a.postcode ?? '',
          country: a.country ?? '',
          countryCode: a.country_code ?? '',
        },
      },
    });
  } catch (error) {
    console.error('[geo] reverse error:', error);
    res.status(500).json({ success: false, message: 'Reverse geocoding failed' });
  }
});

/**
 * GET /api/v1/geo/directions?originLat=&originLng=&destLat=&destLng=
 *
 * Returns the driving route between two coordinates as:
 *   { polyline: [{lat,lng}, …], distanceMeters, durationSeconds }
 *
 * Used by the customer SelectRide map to draw the route the cab will take.
 * Prefers Google Directions (real road snapping) when the key is configured;
 * falls back to OSRM (free public demo server) otherwise. As a last resort
 * we return a straight line so the map still has something to draw.
 */
router.get('/directions', async (req: Request, res: Response) => {
  try {
    const oLat = parseFloat(String(req.query.originLat ?? ''));
    const oLng = parseFloat(String(req.query.originLng ?? ''));
    const dLat = parseFloat(String(req.query.destLat ?? ''));
    const dLng = parseFloat(String(req.query.destLng ?? ''));
    if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) {
      res.status(400).json({
        success: false,
        message: 'originLat, originLng, destLat, destLng are required',
      });
      return;
    }

    // Google encoded polyline → [{lat,lng}, …]. Algorithm: ascii85-ish var-int
    // signed delta encoding. Lifted from Google's spec; small enough to inline
    // rather than pull a dep.
    const decodePolyline = (str: string): Array<{ lat: number; lng: number }> => {
      const points: Array<{ lat: number; lng: number }> = [];
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

    // ── Provider 1: Google Directions ──────────────────────────────────
    const gKey = googleKey();
    if (gKey) {
      try {
        const u = new URL('https://maps.googleapis.com/maps/api/directions/json');
        u.searchParams.set('origin', `${oLat},${oLng}`);
        u.searchParams.set('destination', `${dLat},${dLng}`);
        u.searchParams.set('mode', 'driving');
        u.searchParams.set('key', gKey);
        const r = await fetch(u.toString());
        const j: any = await r.json();
        if (j?.status === 'OK' && j.routes?.[0]) {
          const route = j.routes[0];
          const poly = decodePolyline(route.overview_polyline?.points ?? '');
          const leg = route.legs?.[0] ?? {};
          res.status(200).json({
            success: true,
            data: {
              provider: 'google',
              polyline: poly,
              distanceMeters: leg.distance?.value ?? 0,
              durationSeconds: leg.duration?.value ?? 0,
            },
          });
          return;
        }
        console.warn('[geo] google directions fallback:', j?.status, j?.error_message);
      } catch (gErr) {
        console.warn('[geo] google directions error, falling back:', gErr);
      }
    }

    // ── Provider 2: OSRM public router (free, demo-grade) ──────────────
    try {
      const osrmUrl =
        `https://router.project-osrm.org/route/v1/driving/` +
        `${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
      const r = await fetch(osrmUrl);
      const j: any = await r.json();
      if (j?.code === 'Ok' && j.routes?.[0]) {
        const route = j.routes[0];
        const coords: Array<[number, number]> = route.geometry?.coordinates ?? [];
        const poly = coords.map(([lng, lat]) => ({ lat, lng }));
        res.status(200).json({
          success: true,
          data: {
            provider: 'osrm',
            polyline: poly,
            distanceMeters: route.distance ?? 0,
            durationSeconds: route.duration ?? 0,
          },
        });
        return;
      }
    } catch (osrmErr) {
      console.warn('[geo] osrm directions error:', osrmErr);
    }

    // ── Provider 3: Straight line fallback ─────────────────────────────
    // Last resort so the map always has *something* — better than an empty
    // polyline. Distance is haversine; duration is a 30 km/h heuristic.
    const distKm = haversineKm(
      { lat: oLat, lng: oLng },
      { lat: dLat, lng: dLng },
    );
    res.status(200).json({
      success: true,
      data: {
        provider: 'straight',
        polyline: [
          { lat: oLat, lng: oLng },
          { lat: dLat, lng: dLng },
        ],
        distanceMeters: Math.round(distKm * 1000),
        durationSeconds: Math.round((distKm / 30) * 3600),
      },
    });
  } catch (error) {
    console.error('[geo] directions error:', error);
    res.status(500).json({ success: false, message: 'Directions failed' });
  }
});

export default router;
