/**
 * Pure pricing rules, kept free of database and HTTP code so they are easy to test.
 *
 * A price depends only on: tanker capacity, the band of the saved address, and add-ons.
 * Traffic, detours, or which lorry is dispatched never change it.
 */

export type BandCode = 'A' | 'B' | 'C';

export interface BandRow {
  code: BandCode;
  label: string;
  minKm: number;
  maxKm: number;
}

export interface RateRow {
  capacityKl: number;
  band: BandCode;
  pricePaise: number;
  capPaise: number;
}

export interface AddOnRow {
  code: string;
  label: string;
  pricePaise: number;
  unit: 'per_order' | 'per_15_min';
  customerSelectable: boolean;
}

export interface QuoteInput {
  capacityKl: number;
  /** From the saved address, worked out on the server. Never taken from the customer. */
  band: BandCode;
  /** From the saved address. */
  hillRoad: boolean;
  /** Early-morning delivery slot: adds the night charge. Set by the server from the chosen slot. */
  earlyMorning?: boolean;
  /** Customer-chosen extras, e.g. overhead_pumping. */
  addOns: string[];
  /** 15-minute blocks the driver waited beyond the free 15 minutes (added after delivery). */
  waitingBlocks?: number;
}

export interface QuoteLine {
  code: string;
  label: string;
  amountPaise: number;
}

export interface Quote {
  capacityKl: number;
  band: BandCode;
  lines: QuoteLine[];
  totalPaise: number;
}

export class PricingError extends Error {}

/** Band for a road distance, or null when the address is beyond the last band (quoted manually). */
export function bandForDistance(roadKm: number, bands: BandRow[]): BandCode | null {
  if (!Number.isFinite(roadKm) || roadKm < 0) throw new PricingError('Distance must be a positive number of kilometres.');
  const sorted = [...bands].sort((a, b) => a.minKm - b.minKm);
  for (const b of sorted) {
    if (roadKm <= b.maxKm && (roadKm > b.minKm || b.minKm === 0)) return b.code;
  }
  return null;
}

export function computeQuote(
  input: QuoteInput,
  rateCard: RateRow[],
  addOns: AddOnRow[],
  platformFeePaise: number,
): Quote {
  const rate = rateCard.find((r) => r.capacityKl === input.capacityKl && r.band === input.band);
  if (!rate) throw new PricingError(`No price for a ${input.capacityKl} KL tanker in band ${input.band}.`);

  const byCode = new Map(addOns.map((a) => [a.code, a]));
  const chosen = [...new Set(input.addOns)];
  for (const code of chosen) {
    const addOn = byCode.get(code);
    if (!addOn) throw new PricingError(`Unknown extra: ${code}.`);
    if (!addOn.customerSelectable) throw new PricingError(`${addOn.label} is set by NeerNow, not chosen at booking.`);
  }

  const lines: QuoteLine[] = [
    { code: 'water', label: `Water, ${(input.capacityKl * 1000).toLocaleString('en-IN')} L (band ${input.band})`, amountPaise: rate.pricePaise },
  ];
  const add = (code: string, times = 1) => {
    const a = byCode.get(code);
    if (a && times > 0) lines.push({ code, label: a.label, amountPaise: a.pricePaise * times });
  };
  if (input.hillRoad) add('hill_road');
  if (input.earlyMorning) add('night_slot');
  chosen.forEach((code) => add(code));
  if (input.waitingBlocks) {
    if (!Number.isInteger(input.waitingBlocks) || input.waitingBlocks < 0) throw new PricingError('Waiting time must be whole 15-minute blocks.');
    add('waiting', input.waitingBlocks);
  }
  lines.push({ code: 'platform_fee', label: 'Platform fee', amountPaise: platformFeePaise });

  return {
    capacityKl: input.capacityKl,
    band: input.band,
    lines,
    totalPaise: lines.reduce((sum, l) => sum + l.amountPaise, 0),
  };
}
