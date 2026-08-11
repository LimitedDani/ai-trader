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
}

export const DEFAULT_FAST_PARAMS: FastParams = {
  lookback: 48, // 4 hours of 5-min bars
  zEntry: 2.0,
  zExit: 0.0,
  stopLossPct: 1.5,
  maxHoldBars: 36, // 3 hours
  feePctPerSide: 0.1, // Bybit spot base tier
  minVolMultiple: 3,
};

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
): 'revert' | 'stop' | 'timeout' | null {
  if (price <= entryPrice * (1 - p.stopLossPct / 100)) return 'stop';
  if (barsHeld >= p.maxHoldBars) return 'timeout';
  if (stats && (price - stats.mean) / stats.std >= p.zExit) return 'revert';
  return null;
}

export function shouldExit(closes: number[], entryPrice: number, barsHeld: number, p: FastParams): 'revert' | 'stop' | 'timeout' | null {
  const price = closes[closes.length - 1]!;
  if (price <= entryPrice * (1 - p.stopLossPct / 100)) return 'stop';
  if (barsHeld >= p.maxHoldBars) return 'timeout';
  const stats = rollingStats(closes, p.lookback);
  if (stats && stats.z >= p.zExit) return 'revert';
  return null;
}

export interface FastTrade {
  entry: number;
  exit: number;
  pnlPct: number;
  barsHeld: number;
  reason: 'revert' | 'stop' | 'timeout' | 'end';
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
