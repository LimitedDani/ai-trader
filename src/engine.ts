/**
 * Backtest engine, parameterized so both the single backtest and the
 * parameter sweep can reuse it. Conservative assumptions: fills at next
 * bar open plus slippage, and if both stop and target are hit within
 * one bar, the STOP is assumed to fill (worst case).
 */
import { sma } from './strategy.js';
import type { Bar } from './alpaca.js';

const SLIPPAGE_PCT = 0.02; // 2 bps per side; Alpaca US stocks are commission-free

export interface Params {
  fastSma: number;
  slowSma: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** Trading fee per side in percent (0 for Alpaca stocks, ~0.25 for Alpaca crypto taker). */
  feePct?: number;
}

export interface Trade {
  entry: number;
  exit: number;
  pnlPct: number;
  reason: 'target' | 'stop' | 'end';
}

export function backtestSymbol(bars: Bar[], p: Params): Trade[] {
  const trades: Trade[] = [];
  const closes = bars.map((b) => b.c);
  let position: { entry: number; target: number; stop: number } | null = null;

  for (let i = p.slowSma + 1; i < bars.length; i++) {
    const bar = bars[i]!;

    if (position) {
      if (bar.l <= position.stop) {
        trades.push(
          closeTrade(position.entry, position.stop * (1 - SLIPPAGE_PCT / 100), 'stop', p),
        );
        position = null;
      } else if (bar.h >= position.target) {
        trades.push(
          closeTrade(position.entry, position.target * (1 - SLIPPAGE_PCT / 100), 'target', p),
        );
        position = null;
      }
      continue;
    }

    const upto = closes.slice(0, i); // signal uses data up to previous bar only
    const fastNow = sma(upto, p.fastSma);
    const slowNow = sma(upto, p.slowSma);
    const fastPrev = sma(upto.slice(0, -1), p.fastSma);
    const slowPrev = sma(upto.slice(0, -1), p.slowSma);
    if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) continue;

    if (fastPrev <= slowPrev && fastNow > slowNow) {
      const entry = bar.o * (1 + SLIPPAGE_PCT / 100);
      position = {
        entry,
        target: entry * (1 + p.takeProfitPct / 100),
        stop: entry * (1 - p.stopLossPct / 100),
      };
    }
  }

  if (position) {
    trades.push(closeTrade(position.entry, closes[closes.length - 1]!, 'end', p));
  }
  return trades;
}

function closeTrade(entry: number, exit: number, reason: Trade['reason'], p: Params): Trade {
  const fees = (p.feePct ?? 0) * 2; // paid on entry and exit
  return { entry, exit, pnlPct: ((exit - entry) / entry) * 100 - fees, reason };
}

export function summarize(trades: Trade[]) {
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const pnl = trades.reduce((sum, t) => sum + t.pnlPct, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return { trades: trades.length, wins, pnl, maxDrawdown };
}
