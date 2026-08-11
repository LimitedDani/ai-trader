/**
 * Walk-forward re-tune: sweeps strategy parameters over the LAST 30 days
 * (train 20d / validate 10d) and prints a recommendation. Deliberately does
 * NOT auto-apply — review the validation column and update .env yourself.
 * Auto-applied rolling optimization is how overfitting gets a bank account.
 *
 * Usage: pnpm build && pnpm tune
 */
import { fetchKlines } from './bybit.js';
import { backtestFast, DEFAULT_FAST_PARAMS, type FastParams, type FastTrade } from './fastStrategy.js';
import type { Kline } from './bybit.js';

const SYMBOLS = (process.env.TUNE_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ADAUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FEE = Number(process.env.FAST_FEE_PCT ?? 0.1);
const DAYS = 30;

function pnl(trades: FastTrade[]): number {
  return trades.reduce((s, t) => s + t.pnlPct, 0);
}

async function main(): Promise<void> {
  console.log(`Walk-forward tune: last ${DAYS} days, 5-min bars, fee ${FEE}%/side, train 20d / validate 10d\n`);

  const data = new Map<string, Kline[]>();
  for (const symbol of SYMBOLS) {
    data.set(symbol, await fetchKlines(symbol, 5, DAYS));
  }

  const rows: { p: FastParams; label: string; train: number; val: number; n: number }[] = [];
  for (const zEntry of [2.0, 2.5, 3.0]) {
    for (const stopLossPct of [1.5, 2.5, 3.5]) {
      for (const maxHoldBars of [36, 72, 144]) {
        const p: FastParams = { ...DEFAULT_FAST_PARAMS, zEntry, stopLossPct, maxHoldBars, feePctPerSide: FEE };
        let train = 0, val = 0, n = 0;
        for (const klines of data.values()) {
          const cut = Math.floor(klines.length * (2 / 3));
          const t = backtestFast(klines.slice(0, cut), p);
          const v = backtestFast(klines.slice(cut), p);
          train += pnl(t);
          val += pnl(v);
          n += t.length + v.length;
        }
        rows.push({ p, label: `z${zEntry} SL${stopLossPct} hold${maxHoldBars}`, train, val, n });
      }
    }
  }

  rows.sort((a, b) => b.train - a.train);
  console.log('params                | train P&L  | validation P&L | trades');
  for (const r of rows.slice(0, 8)) {
    console.log(
      `${r.label.padEnd(21)} | ${r.train.toFixed(2).padStart(8)}%  | ${r.val.toFixed(2).padStart(10)}%    | ${r.n}`,
    );
  }

  const best = rows.filter((r) => r.val > 0).sort((a, b) => b.val - a.val)[0];
  console.log(
    best
      ? `\nRecommendation (best VALIDATION result): FAST_Z_ENTRY=${best.p.zEntry} FAST_STOP_LOSS_PCT=${best.p.stopLossPct} FAST_MAX_HOLD_BARS=${best.p.maxHoldBars}` +
        '\nOnly adopt it if the validation number convinces you — and re-run next week.'
      : '\nNo combination had positive validation P&L this window — do not re-tune into a losing month; keep current params.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
