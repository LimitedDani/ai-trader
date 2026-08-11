/**
 * Backtest the fast mean-reversion strategy on Bybit 5-min spot data.
 * Uses PUBLIC market data — no API keys required.
 *
 * Usage: pnpm build && node dist/cryptoBacktest.js
 */
import { fetchKlines, type Kline } from './bybit.js';
import { backtestFast, DEFAULT_FAST_PARAMS, type FastParams, type FastTrade } from './fastStrategy.js';

const SYMBOLS = (process.env.FAST_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const DAYS = 90;
const INTERVAL_MIN = 5;

function summarize(trades: FastTrade[]) {
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const stops = trades.filter((t) => t.reason === 'stop').length;
  const avgHold = trades.length
    ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length
    : 0;
  return { n: trades.length, wins, pnl, stops, avgHold };
}

async function main(): Promise<void> {
  console.log(`Fast crypto backtest: ${INTERVAL_MIN}-min bars, last ${DAYS} days, fee ${DEFAULT_FAST_PARAMS.feePctPerSide}%/side\n`);

  const data = new Map<string, Kline[]>();
  for (const symbol of SYMBOLS) {
    const klines = await fetchKlines(symbol, INTERVAL_MIN, DAYS);
    data.set(symbol, klines);
    console.log(`${symbol}: ${klines.length} bars`);
  }

  // Train on first 60 days, validate on last 30.
  console.log('\n--- Default params per symbol (train 60d / validation 30d) ---');
  console.log('symbol    | train P&L (n, win%)      | validation P&L (n, win%)');
  for (const [symbol, klines] of data) {
    const cut = Math.floor(klines.length * (2 / 3));
    const t = summarize(backtestFast(klines.slice(0, cut), DEFAULT_FAST_PARAMS));
    const v = summarize(backtestFast(klines.slice(cut), DEFAULT_FAST_PARAMS));
    console.log(
      `${symbol.padEnd(9)} | ${t.pnl.toFixed(2).padStart(7)}% (${t.n}, ${t.n ? Math.round((100 * t.wins) / t.n) : 0}%) `.padEnd(28) +
        `| ${v.pnl.toFixed(2).padStart(7)}% (${v.n}, ${v.n ? Math.round((100 * v.wins) / v.n) : 0}%)`,
    );
  }

  // Small sweep, ranked on train, shown against validation.
  console.log('\n--- Sweep (all symbols combined, ranked by train, validation unseen) ---');
  const rows: { p: FastParams; label: string; train: number; val: number; trainN: number; valN: number }[] = [];
  for (const zEntry of [1.5, 2.0, 2.5]) {
    for (const stopLossPct of [1.0, 1.5, 2.5]) {
      for (const maxHoldBars of [24, 36, 72]) {
        const p: FastParams = { ...DEFAULT_FAST_PARAMS, zEntry, stopLossPct, maxHoldBars };
        let train = 0;
        let val = 0;
        let trainN = 0;
        let valN = 0;
        for (const klines of data.values()) {
          const cut = Math.floor(klines.length * (2 / 3));
          const t = summarize(backtestFast(klines.slice(0, cut), p));
          const v = summarize(backtestFast(klines.slice(cut), p));
          train += t.pnl;
          val += v.pnl;
          trainN += t.n;
          valN += v.n;
        }
        rows.push({ p, label: `z${zEntry} SL${stopLossPct} hold${maxHoldBars}`, train, val, trainN, valN });
      }
    }
  }
  rows.sort((a, b) => b.train - a.train);
  console.log('params               | train P&L (n)     | validation P&L (n)');
  for (const r of rows.slice(0, 10)) {
    console.log(
      `${r.label.padEnd(20)} | ${r.train.toFixed(2).padStart(8)}% (${String(r.trainN).padStart(3)}) | ${r.val.toFixed(2).padStart(8)}% (${String(r.valN).padStart(3)})`,
    );
  }
  console.log('\nNote: 90 days is a short sample. Positive validation = worth paper testing, nothing more.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
