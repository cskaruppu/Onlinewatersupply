export interface LatLng {
  lat: number;
  lng: number;
}

/** Rough box around Coimbatore city and suburbs. Addresses outside it are refused. */
export const SERVICE_AREA = { minLat: 10.8, maxLat: 11.25, minLng: 76.75, maxLng: 77.2 };

export function inServiceArea(p: LatLng): boolean {
  return p.lat >= SERVICE_AREA.minLat && p.lat <= SERVICE_AREA.maxLat && p.lng >= SERVICE_AREA.minLng && p.lng <= SERVICE_AREA.maxLng;
}

/** Straight-line distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The n candidates closest in a straight line, nearest first. */
export function nearestByAir<T extends LatLng>(target: LatLng, candidates: T[], n: number): T[] {
  return [...candidates].sort((x, y) => haversineKm(target, x) - haversineKm(target, y)).slice(0, n);
}
