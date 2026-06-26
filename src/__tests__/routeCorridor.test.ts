import { routeMatchesCorridor } from '../utils/routeCorridor';

interface Stop {
  name: string;
  lat: number;
  lng: number;
  sequence: number;
}

const makeRoute = (stops: Stop[], bufferMeters = 1000) => ({
  stops,
  corridorBufferMeters: bufferMeters,
});

describe('routeMatchesCorridor', () => {
  const A: Stop = { name: 'A', lat: 28.7041, lng: 77.1025, sequence: 0 };
  const B: Stop = { name: 'B', lat: 28.5355, lng: 77.3910, sequence: 1 };
  const route = makeRoute([A, B], 1000);

  test('pickup near A, drop near B → match', () => {
    const result = routeMatchesCorridor(route, {
      pickup: { lat: 28.7042, lng: 77.1026 },
      drop: { lat: 28.5356, lng: 77.3911 },
    });
    expect(result).toBe(true);
  });

  test('pickup near B, drop near A (wrong direction) → no match', () => {
    const result = routeMatchesCorridor(route, {
      pickup: { lat: 28.5356, lng: 77.3911 },
      drop: { lat: 28.7042, lng: 77.1026 },
    });
    expect(result).toBe(false);
  });

  test('pickup nowhere near corridor → no match', () => {
    const result = routeMatchesCorridor(route, {
      pickup: { lat: 19.0760, lng: 72.8777 }, // Mumbai
      drop: { lat: 28.5356, lng: 77.3911 },
    });
    expect(result).toBe(false);
  });

  test('pickup-only (no drop) within corridor of any stop → match', () => {
    const result = routeMatchesCorridor(route, {
      pickup: { lat: 28.5356, lng: 77.3911 },
    });
    expect(result).toBe(true);
  });

  test('pickup-only, nowhere near any stop → no match', () => {
    const result = routeMatchesCorridor(route, {
      pickup: { lat: 19.0760, lng: 72.8777 },
    });
    expect(result).toBe(false);
  });
});
