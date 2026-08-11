/**
 * Local paper broker: simulated fills at live market prices, with fees.
 * State (wallet, positions, trade history) persists to paper-state.json
 * so the bot can be restarted without losing track.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STATE_FILE = process.env.PAPER_STATE_FILE ?? 'paper-state.json';
const START_USDT = 10_000;

export interface PaperPosition {
  symbol: string;
  qtyBase: number;
  entry: number;
  enteredAtBar: number;
  costUsdt: number;
}

export interface PaperFill {
  time: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  price: number;
  qtyBase: number;
  feeUsdt: number;
  pnlUsdt?: number; // set on sells
  reason?: string;
}

interface State {
  usdt: number;
  positions: Record<string, PaperPosition>;
  fills: PaperFill[];
}

export class PaperBroker {
  private state: State;

  constructor(private readonly feePctPerSide: number) {
    if (existsSync(STATE_FILE)) {
      this.state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
    } else {
      this.state = { usdt: START_USDT, positions: {}, fills: [] };
      this.save();
    }
  }

  private save(): void {
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  get balanceUsdt(): number {
    return this.state.usdt;
  }

  get openPositions(): PaperPosition[] {
    return Object.values(this.state.positions);
  }

  get allFills(): PaperFill[] {
    return this.state.fills;
  }

  get startUsdt(): number {
    return START_USDT;
  }

  position(symbol: string): PaperPosition | undefined {
    return this.state.positions[symbol];
  }

  buy(symbol: string, usdtAmount: number, price: number, barIndex: number): PaperPosition {
    if (this.state.positions[symbol]) throw new Error(`${symbol}: position already open`);
    if (usdtAmount > this.state.usdt) throw new Error(`${symbol}: insufficient paper USDT`);
    const feeUsdt = usdtAmount * (this.feePctPerSide / 100);
    const qtyBase = (usdtAmount - feeUsdt) / price;
    const pos: PaperPosition = { symbol, qtyBase, entry: price, enteredAtBar: barIndex, costUsdt: usdtAmount };
    this.state.usdt -= usdtAmount;
    this.state.positions[symbol] = pos;
    this.state.fills.push({ time: new Date().toISOString(), symbol, side: 'Buy', price, qtyBase, feeUsdt });
    this.save();
    return pos;
  }

  sell(symbol: string, price: number, reason: string): PaperFill {
    const pos = this.state.positions[symbol];
    if (!pos) throw new Error(`${symbol}: no open position`);
    const gross = pos.qtyBase * price;
    const feeUsdt = gross * (this.feePctPerSide / 100);
    const proceeds = gross - feeUsdt;
    const pnlUsdt = proceeds - pos.costUsdt;
    this.state.usdt += proceeds;
    delete this.state.positions[symbol];
    const fill: PaperFill = {
      time: new Date().toISOString(),
      symbol,
      side: 'Sell',
      price,
      qtyBase: pos.qtyBase,
      feeUsdt,
      pnlUsdt,
      reason,
    };
    this.state.fills.push(fill);
    this.save();
    return fill;
  }

  summary(): string {
    const sells = this.state.fills.filter((f) => f.side === 'Sell');
    const realized = sells.reduce((s, f) => s + (f.pnlUsdt ?? 0), 0);
    return (
      `USDT ${this.state.usdt.toFixed(2)} | open positions ${this.openPositions.length} | ` +
      `closed trades ${sells.length} | realized P&L ${realized.toFixed(2)} USDT`
    );
  }
}
