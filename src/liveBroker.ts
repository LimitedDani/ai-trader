/**
 * Live broker backed by Bitvavo. Mirrors PaperBroker's interface so the
 * bot and dashboard work identically in both modes. Executes real market
 * orders; tracks strategy state (entries, hold timers, fills) locally in
 * live-state.json since the exchange doesn't know about our positions.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BitvavoClient } from './bitvavo.js';
import type { PaperFill, PaperPosition } from './paperBroker.js';

const STATE_FILE =
  process.env.LIVE_STATE_FILE ?? join(process.env.STATE_DIR ?? '.', 'live-state.json');

interface State {
  startQuote: number | null; // first observed EUR balance, baseline for the equity chart
  positions: Record<string, PaperPosition>;
  fills: PaperFill[];
}

export class LiveBroker {
  private state: State;
  private cachedBalance = 0;

  constructor(
    private readonly client: BitvavoClient,
    private readonly quote = 'EUR',
    /** 'maker': post-only limit entries at the bid (cheaper fee tier, may miss
     *  fills); 'taker': immediate market entries. Exits are always market. */
    private readonly entryStyle: 'maker' | 'taker' = 'maker',
    private readonly makerWaitMs = 45_000,
  ) {
    this.state = existsSync(STATE_FILE)
      ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State)
      : { startQuote: null, positions: {}, fills: [] };
  }

  private save(): void {
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  /** Call at startup and periodically; keeps the sync getters accurate. */
  async refreshBalance(): Promise<void> {
    this.cachedBalance = await this.client.balance(this.quote);
    if (this.state.startQuote === null) {
      // Baseline includes EUR already committed to tracked positions.
      const committed = Object.values(this.state.positions).reduce((s, p) => s + p.costUsdt, 0);
      this.state.startQuote = this.cachedBalance + committed;
      this.save();
    }
  }

  get balanceUsdt(): number {
    return this.cachedBalance;
  }

  get startUsdt(): number {
    return this.state.startQuote ?? this.cachedBalance;
  }

  get openPositions(): PaperPosition[] {
    return Object.values(this.state.positions);
  }

  get allFills(): PaperFill[] {
    return this.state.fills;
  }

  position(symbol: string): PaperPosition | undefined {
    return this.state.positions[symbol];
  }

  async buy(symbol: string, quoteAmount: number, price: number, barIndex: number, reason = 'signal'): Promise<PaperPosition> {
    if (this.state.positions[symbol]) throw new Error(`${symbol}: position already open`);
    if (quoteAmount > this.cachedBalance) throw new Error(`${symbol}: insufficient ${this.quote} (${this.cachedBalance.toFixed(2)})`);

    const fill =
      this.entryStyle === 'maker' && price > 0
        ? await this.client.limitBuy(symbol, quoteAmount, price, this.makerWaitMs)
        : await this.client.marketBuy(symbol, quoteAmount);
    const pos: PaperPosition = {
      symbol,
      qtyBase: fill.qtyBase,
      entry: fill.price,
      enteredAtBar: barIndex,
      costUsdt: fill.costQuote,
    };
    this.state.positions[symbol] = pos;
    this.state.fills.push({
      time: new Date().toISOString(),
      symbol,
      side: 'Buy',
      price: fill.price,
      qtyBase: fill.qtyBase,
      feeUsdt: fill.feeQuote,
      reason,
    });
    this.save();
    await this.refreshBalance();
    return pos;
  }

  async sell(symbol: string, _price: number, reason: string): Promise<PaperFill> {
    const pos = this.state.positions[symbol];
    if (!pos) throw new Error(`${symbol}: no open position`);

    const result = await this.client.marketSell(symbol, pos.qtyBase);
    const pnlUsdt = result.proceedsQuote - pos.costUsdt;
    delete this.state.positions[symbol];
    const fill: PaperFill = {
      time: new Date().toISOString(),
      symbol,
      side: 'Sell',
      price: result.price,
      qtyBase: result.qtySold,
      feeUsdt: result.feeQuote,
      pnlUsdt,
      reason,
    };
    this.state.fills.push(fill);
    this.save();
    await this.refreshBalance();
    return fill;
  }

  summary(): string {
    const sells = this.state.fills.filter((f) => f.side === 'Sell');
    const realized = sells.reduce((s, f) => s + (f.pnlUsdt ?? 0), 0);
    return (
      `${this.quote} ${this.cachedBalance.toFixed(2)} | open positions ${this.openPositions.length} | ` +
      `closed trades ${sells.length} | realized P&L ${realized.toFixed(2)} ${this.quote}`
    );
  }
}
