import { AddOnRow, BandRow, bandForDistance, computeQuote, PricingError, RateRow } from '../../src/pricing/pricing';

const BANDS: BandRow[] = [
  { code: 'A', label: 'Up to 5 km', minKm: 0, maxKm: 5 },
  { code: 'B', label: '5 to 10 km', minKm: 5, maxKm: 10 },
  { code: 'C', label: '10 to 15 km', minKm: 10, maxKm: 15 },
];

const RATES: RateRow[] = [
  { capacityKl: 12, band: 'A', pricePaise: 140000, capPaise: 170000 },
  { capacityKl: 12, band: 'B', pricePaise: 155000, capPaise: 190000 },
  { capacityKl: 12, band: 'C', pricePaise: 175000, capPaise: 210000 },
];

const ADD_ONS: AddOnRow[] = [
  { code: 'overhead_pumping', label: 'Pump to overhead tank', pricePaise: 15000, unit: 'per_order', customerSelectable: true },
  { code: 'hill_road', label: 'Hill road access', pricePaise: 20000, unit: 'per_order', customerSelectable: false },
  { code: 'waiting', label: 'Waiting at the gate beyond 15 min', pricePaise: 10000, unit: 'per_15_min', customerSelectable: false },
];

describe('bandForDistance', () => {
  it.each([
    [0, 'A'], [3.4, 'A'], [5, 'A'],
    [5.1, 'B'], [7.2, 'B'], [10, 'B'],
    [10.1, 'C'], [15, 'C'],
  ])('%s km is band %s', (km, band) => {
    expect(bandForDistance(km, BANDS)).toBe(band);
  });

  it('returns null beyond the last band (quoted by operations)', () => {
    expect(bandForDistance(15.1, BANDS)).toBeNull();
    expect(bandForDistance(40, BANDS)).toBeNull();
  });

  it('rejects impossible distances', () => {
    expect(() => bandForDistance(-1, BANDS)).toThrow(PricingError);
    expect(() => bandForDistance(Number.NaN, BANDS)).toThrow(PricingError);
  });
});

describe('computeQuote', () => {
  it('charges the band price and platform fee only, with no per-km line', () => {
    const q = computeQuote({ capacityKl: 12, band: 'B', hillRoad: false, addOns: [] }, RATES, ADD_ONS, 2900);
    expect(q.lines.map((l) => l.code)).toEqual(['water', 'platform_fee']);
    expect(q.totalPaise).toBe(155000 + 2900);
  });

  it('gives the same price for the same address whatever lorry or route is used', () => {
    const input = { capacityKl: 12, band: 'A' as const, hillRoad: false, addOns: [] };
    expect(computeQuote(input, RATES, ADD_ONS, 2900)).toEqual(computeQuote({ ...input }, RATES, ADD_ONS, 2900));
  });

  it('adds hill road access automatically from the address, and chosen extras once', () => {
    const q = computeQuote(
      { capacityKl: 12, band: 'C', hillRoad: true, addOns: ['overhead_pumping', 'overhead_pumping'] },
      RATES, ADD_ONS, 2900,
    );
    expect(q.lines.map((l) => [l.code, l.amountPaise])).toEqual([
      ['water', 175000], ['hill_road', 20000], ['overhead_pumping', 15000], ['platform_fee', 2900],
    ]);
    expect(q.totalPaise).toBe(212900);
  });

  it('charges waiting per 15-minute block', () => {
    const q = computeQuote({ capacityKl: 12, band: 'A', hillRoad: false, addOns: [], waitingBlocks: 2 }, RATES, ADD_ONS, 2900);
    expect(q.lines.find((l) => l.code === 'waiting')?.amountPaise).toBe(20000);
    expect(() => computeQuote({ capacityKl: 12, band: 'A', hillRoad: false, addOns: [], waitingBlocks: 1.5 }, RATES, ADD_ONS, 2900)).toThrow(PricingError);
  });

  it('refuses unknown capacities, unknown extras, and extras only NeerNow may set', () => {
    expect(() => computeQuote({ capacityKl: 7, band: 'A', hillRoad: false, addOns: [] }, RATES, ADD_ONS, 2900)).toThrow(/No price/);
    expect(() => computeQuote({ capacityKl: 12, band: 'A', hillRoad: false, addOns: ['free_water'] }, RATES, ADD_ONS, 2900)).toThrow(/Unknown extra/);
    expect(() => computeQuote({ capacityKl: 12, band: 'A', hillRoad: false, addOns: ['hill_road'] }, RATES, ADD_ONS, 2900)).toThrow(/set by NeerNow/);
  });
});
