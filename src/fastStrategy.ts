/**
 * Fast crypto mean-reversion strategy on short-timeframe bars.
 *
 * Entry (long only): z-score of close vs rolling mean drops below -zEntry
 * AND recent volatility is high enough that the expected snap-back clears
 * round-trip fees with margin.
 * Exit: z-score reverts to >= zExit, or stop-loss, or max-hold timeout.
 */
import type { Kline } from './bybit.js';

export interface FastParams {
  lookback: number; // bars for rolling mean/std
  zEntry: number; // enter when z < -zEntry
  zExit: number; // exit when z >= zExit
  stopLossPct: number;
  maxHoldBars: number;
  feePctPerSide: number;
  minVolMultiple: number; // require std/price > multiple * round-trip fee
  /**
   * What happens when maxHoldBars expires:
   * 'sell'      — sell at market immediately (accepts whatever P&L is there)
   * 'breakeven' — keep holding, sell at the first price that nets a profit
   *               after fees; only the stop-loss can force a losing exit.
   */
  timeoutAction: 'sell' | 'breakeven';
}

export const DEFAULT_FAST_PARAMS: FastParams = {
  lookback: 48, // 4 hours of 5-min bars
  zEntry: 2.0,
  zExit: 0.0,
  stopLossPct: 1.5,
  maxHoldBars: 36, // 3 hours
  feePctPerSide: 0.1, // Bybit spot base tier
  minVolMultiple: 3,
  timeoutAction: 'sell',
};

/** Price at which selling nets a profit after both fee legs. */
export function breakevenPrice(entryPrice: number, p: FastParams): number {
  return entryPrice * (1 + (2 * p.feePctPerSide) / 100);
}

/**
 * Momentum strategy: buy coins that are rising, ride them with a trailing
 * stop, sell when they pull back. Only viable on low-fee (USDC) markets.
 */
export interface MomentumParams {
  lookback: number; // bars used to measure short-term momentum
  breakoutPct: number; // require this % rise over the lookback to enter
  trailPct: number; // sell when price falls this % from its peak since entry
  hardStopPct: number; // absolute floor from entry
  feePctPerSide: number;
  minVolMultiple: number; // require std/price > multiple * round-trip fee
}

export const DEFAULT_MOMENTUM_PARAMS: MomentumParams = {
  lookback: 6, // ~30 min on 5-min bars
  breakoutPct: 0.6,
  trailPct: 0.5,
  hardStopPct: 1.0,
  feePctPerSide: 0.05, // Bitvavo USDC taker
  minVolMultiple: 2,
};

/** Enter when price is rising: up breakoutPct over the lookback, volatile enough to clear fees. */
export function momentumEntry(closes: number[], price: number, p: MomentumParams): boolean {
  if (closes.length < p.lookback + 1) return false;
  const past = closes[closes.length - 1 - p.lookback]!;
  if (!(past > 0)) return false;
  const risePct = ((price - past) / past) * 100;
  if (risePct < p.breakoutPct) return false; // not rising enough
  // volatility floor so the trailing exit can clear the round-trip fee
  const stats = rollingStats(closes, Math.min(p.lookback * 4, closes.length - 1));
  if (stats && stats.std / price < p.minVolMultiple * ((p.feePctPerSide * 2) / 100)) return false;
  return true;
}

/**
 * Exit: trailing stop from the peak seen since entry (rides winners, sells on
 * a pullback), with a hard stop as the absolute floor.
 */
export function momentumExit(price: number, entry: number, peak: number, p: MomentumParams): 'trail' | 'stop' | null {
  if (price <= entry * (1 - p.hardStopPct / 100)) return 'stop';
  if (price <= peak * (1 - p.trailPct / 100)) return 'trail';
  return null;
}

export interface Stats {
  mean: number;
  std: number;
  z: number;
}

export function rollingStats(closes: number[], lookback: number): Stats | null {
  if (closes.length < lookback + 1) return null;
  const window = closes.slice(-lookback - 1, -1); // exclude current bar from baseline
  const mean = window.reduce((s, c) => s + c, 0) / window.length;
  const variance = window.reduce((s, c) => s + (c - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const current = closes[closes.length - 1]!;
  return { mean, std, z: (current - mean) / std };
}

export function shouldEnter(closes: number[], p: FastParams): boolean {
  const stats = rollingStats(closes, p.lookback);
  if (!stats) return false;
  return shouldEnterAtPrice(closes[closes.length - 1]!, stats, p);
}

/** Tick-level entry check: live price against stats computed from closed bars. */
export function shouldEnterAtPrice(price: number, stats: Stats, p: FastParams): boolean {
  // Volatility filter: expected reversion (~1 std) must clear fees with margin.
  const roundTripFee = (p.feePctPerSide * 2) / 100;
  if (stats.std / price < p.minVolMultiple * roundTripFee) return false;
  const z = (price - stats.mean) / stats.std;
  return z < -p.zEntry;
}

/** Tick-level exit check: live price against stats from closed bars. */
export function shouldExitAtPrice(
  price: number,
  stats: Stats | null,
  entryPrice: number,
  barsHeld: number,
  p: FastParams,
): ExitReason | null {
  if (price <= entryPrice * (1 - p.stopLossPct / 100)) return 'stop';
  if (barsHeld >= p.maxHoldBars) {
    if (p.timeoutAction === 'sell') return 'timeout';
    // Overtime: hold until the first net-profitable price. The reversion
    // exit is suspended here — it could realize a loss. Only the stop-loss
    // above can still force a losing exit.
    return price >= breakevenPrice(entryPrice, p) ? 'breakeven' : null;
  }
  if (stats && (price - stats.mean) / stats.std >= p.zExit) return 'revert';
  return null;
}

export type ExitReason = 'revert' | 'stop' | 'timeout' | 'breakeven';

export function shouldExit(closes: number[], entryPrice: number, barsHeld: number, p: FastParams): ExitReason | null {
  const stats = rollingStats(closes, p.lookback);
  return shouldExitAtPrice(closes[closes.length - 1]!, stats, entryPrice, barsHeld, p);
}

export interface FastTrade {
  entry: number;
  exit: number;
  pnlPct: number;
  barsHeld: number;
  reason: ExitReason | 'end';
}

export function backtestFast(klines: Kline[], p: FastParams): FastTrade[] {
  const trades: FastTrade[] = [];
  const closes = klines.map((k) => k.c);
  let position: { entry: number; enteredAt: number } | null = null;

  for (let i = p.lookback + 1; i < klines.length; i++) {
    const seen = closes.slice(0, i + 1);

    if (position) {
      const reason = shouldExit(seen, position.entry, i - position.enteredAt, p);
      if (reason) {
        // Fill on next bar open to avoid look-ahead; fall back to current close at the end.
        const fill = klines[i + 1]?.o ?? closes[i]!;
        trades.push(close(position.entry, fill, i - position.enteredAt, reason, p));
        position = null;
      }
      continue;
    }

    if (shouldEnter(seen, p)) {
      const fill = klines[i + 1]?.o;
      if (fill === undefined) continue;
      position = { entry: fill, enteredAt: i };
      i++; // entry consumed the next bar's open
    }
  }

  if (position) {
    trades.push(close(position.entry, closes[closes.length - 1]!, 0, 'end', p));
  }
  return trades;
}

function close(entry: number, exit: number, barsHeld: number, reason: FastTrade['reason'], p: FastParams): FastTrade {
  const pnlPct = ((exit - entry) / entry) * 100 - p.feePctPerSide * 2;
  return { entry, exit, pnlPct, barsHeld, reason };
}
