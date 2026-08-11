import type { Bar } from './alpaca.js';

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((sum, c) => sum + c, 0) / period;
}

export type Signal = 'buy' | 'hold';

/**
 * Momentum entry: fast SMA crossing above slow SMA on the latest bar.
 * Exits are not signalled here — they are handled by the bracket order
 * (take-profit + stop-loss) attached at entry.
 */
export function evaluate(bars: Bar[], fastPeriod: number, slowPeriod: number): Signal {
  const closes = bars.map((b) => b.c);
  if (closes.length < slowPeriod + 1) return 'hold';

  const prev = closes.slice(0, -1);
  const fastNow = sma(closes, fastPeriod);
  const slowNow = sma(closes, slowPeriod);
  const fastPrev = sma(prev, fastPeriod);
  const slowPrev = sma(prev, slowPeriod);

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return 'hold';
  }

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  return crossedUp ? 'buy' : 'hold';
}
