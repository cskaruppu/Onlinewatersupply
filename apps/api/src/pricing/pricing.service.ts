import { BadRequestException, Controller, Get, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { AddOnRow, BandCode, BandRow, bandForDistance, computeQuote, PricingError, Quote, QuoteInput, RateRow } from './pricing';

@Injectable()
export class PricingService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  async bands(): Promise<BandRow[]> {
    const { rows } = await this.db.query<{ code: BandCode; label: string; min_km: string; max_km: string }>(
      'SELECT code, label, min_km, max_km FROM price_bands ORDER BY min_km',
    );
    return rows.map((r) => ({ code: r.code, label: r.label, minKm: Number(r.min_km), maxKm: Number(r.max_km) }));
  }

  async rates(): Promise<RateRow[]> {
    const { rows } = await this.db.query<{ capacity_kl: number; band: BandCode; price_paise: number; cap_paise: number }>(
      'SELECT capacity_kl, band, price_paise, cap_paise FROM rate_card ORDER BY capacity_kl, band',
    );
    return rows.map((r) => ({ capacityKl: r.capacity_kl, band: r.band, pricePaise: r.price_paise, capPaise: r.cap_paise }));
  }

  async addOns(): Promise<AddOnRow[]> {
    const { rows } = await this.db.query<{ code: string; label: string; price_paise: number; unit: AddOnRow['unit']; customer_selectable: boolean }>(
      'SELECT code, label, price_paise, unit, customer_selectable FROM add_ons ORDER BY code',
    );
    return rows.map((r) => ({ code: r.code, label: r.label, pricePaise: r.price_paise, unit: r.unit, customerSelectable: r.customer_selectable }));
  }

  async bandFor(roadKm: number): Promise<BandCode | null> {
    return bandForDistance(roadKm, await this.bands());
  }

  /**
   * Prices an order. The caller must take band and hillRoad from the customer's saved
   * address on the server, never from the request body.
   */
  async quote(input: QuoteInput): Promise<Quote> {
    const [rates, addOns] = await Promise.all([this.rates(), this.addOns()]);
    try {
      return computeQuote(input, rates, addOns, this.config.platformFeePaise);
    } catch (err) {
      if (err instanceof PricingError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Public price list: what a customer pays by capacity and band, before any extras. */
  async rateCard() {
    const [bands, rates, addOns] = await Promise.all([this.bands(), this.rates(), this.addOns()]);
    const capacities = [...new Set(rates.map((r) => r.capacityKl))].map((kl) => ({
      capacityKl: kl,
      prices: Object.fromEntries(rates.filter((r) => r.capacityKl === kl).map((r) => [r.band, r.pricePaise])),
    }));
    return {
      currency: 'INR',
      unit: 'paise',
      basis: 'Road distance from the nearest approved filling point to the saved address, checked once when the address is saved.',
      bands,
      capacities,
      addOns: addOns.map(({ code, label, pricePaise, unit, customerSelectable }) => ({ code, label, pricePaise, unit, customerSelectable })),
      platformFeePaise: this.config.platformFeePaise,
    };
  }
}

@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('rate-card')
  rateCard() {
    return this.pricing.rateCard();
  }
}
