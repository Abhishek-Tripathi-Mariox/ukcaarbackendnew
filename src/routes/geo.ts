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

const buildAddressLine = (hit: NominatimSearchHit): string => {
  const a = hit.address ?? {};
  const parts = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.suburb || a.neighbourhood,
    a.village || a.town || a.city,
    a.state,
    a.postcode,
  ].filter(Boolean);
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
        const acResp = await fetch(acUrl.toString());
        const acJson: any = await acResp.json();
        if (acJson?.status === 'OK' && Array.isArray(acJson.predictions)) {
          const preds = acJson.predictions.slice(0, limit);
          const results = await Promise.all(
            preds.map(async (p: any) => {
              try {
                const dUrl = new URL(`${GOOGLE_PLACES_BASE}/details/json`);
                dUrl.searchParams.set('place_id', p.place_id);
                dUrl.searchParams.set(
                  'fields',
                  'geometry/location,formatted_address,address_components,name'
                );
                dUrl.searchParams.set('key', key);
                const dResp = await fetch(dUrl.toString());
                const dJson: any = await dResp.json();
                const r = dJson?.result;
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
          res.status(200).json({
            success: true,
            data: { results: results.filter(Boolean) },
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

    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!upstream.ok) {
      res.status(502).json({ success: false, message: 'Geocoder unavailable' });
      return;
    }
    const hits = (await upstream.json()) as NominatimSearchHit[];

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

    res.status(200).json({ success: true, data: { results } });
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

    const url = new URL(`${NOMINATIM_BASE}/reverse`);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');

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

export default router;
