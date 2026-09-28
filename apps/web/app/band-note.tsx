import type { Address } from '@/lib/api';

/** Band, road distance and filling point for a saved address. */
export function BandNote({ a }: { a: Address }) {
  if (!a.serviceable) return <span className="pill bad">Outside delivery area</span>;
  return (
    <span className="band-note">
      <span className="pill info">Band {a.band}</span> {a.roadKm?.toFixed(1)} km by road from {a.fillingPoint}
      {a.distanceEstimated && <em> (estimated)</em>}
    </span>
  );
}
