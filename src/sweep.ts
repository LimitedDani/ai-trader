/**
 * Parameter sweep with train/validation split to limit overfitting:
 * parameters are ranked on the FIRST 2 years (train) and then shown
 * against the LAST year (validation), which the ranking never saw.
 * Trust a combo only if it holds up in the validation column.
 *
 * Usage: pnpm build && node --env-file=.env dist/sweep.js
 */
import { config } from './config.js';
import { CRYPTO_FEE_PCT, fetchBars, isCrypto } from './data.js';
import { backtestSymbol, summarize, type Params } from './engine.js';
import type { Bar } from './alpaca.js';

const FAST = [5, 9, 10, 20];
const SLOW = [21, 30, 50];
const TP = [1, 1.5, 2, 3];
const SL = [0.5, 1, 1.5, 2];

interface Row {
  p: Params;
  trainPnl: number;
  trainTrades: number;
  valPnl: number;
  valTrades: number;
  valDrawdown: number;
}

function run(barsBySymbol: Map<string, Bar[]>, p: Params): { pnl: number; trades: number; dd: number } {
  let pnl = 0;
  let trades = 0;
  let dd = 0;
  for (const [symbol, bars] of barsBySymbol) {
    const feePct = isCrypto(symbol) ? CRYPTO_FEE_PCT : 0;
    const s = summarize(backtestSymbol(bars, { ...p, feePct }));
    pnl += s.pnl;
    trades += s.trades;
    dd = Math.max(dd, s.maxDrawdown);
  }
  return { pnl, trades, dd };
}

async function sweep(symbols: string[], label: string): Promise<void> {
  if (symbols.length === 0) return;
  console.log(`\n=== ${label}: ${symbols.join(', ')} ===`);

  const train = new Map<string, Bar[]>();
  const val = new Map<string, Bar[]>();

  for (const symbol of symbols) {
    const bars = await fetchBars(symbol, 3);
    const cut = Math.floor(bars.length * (2 / 3)); // first ~2y train, last ~1y validation
    train.set(symbol, bars.slice(0, cut));
    val.set(symbol, bars.slice(cut));
    console.log(`${symbol}: ${bars.length} bars (${cut} train / ${bars.length - cut} validation)`);
  }

  const rows: Row[] = [];
  for (const fastSma of FAST) {
    for (const slowSma of SLOW) {
      if (fastSma >= slowSma) continue;
      for (const takeProfitPct of TP) {
        for (const stopLossPct of SL) {
          const p: Params = { fastSma, slowSma, takeProfitPct, stopLossPct };
          const t = run(train, p);
          const v = run(val, p);
          rows.push({
            p,
            trainPnl: t.pnl,
            trainTrades: t.trades,
            valPnl: v.pnl,
            valTrades: v.trades,
            valDrawdown: v.dd,
          });
        }
      }
    }
  }

  rows.sort((a, b) => b.trainPnl - a.trainPnl);

  console.log(`\n${rows.length} combinations.`);
  console.log('Ranked by TRAIN P&L (first 2y); VALIDATION (last 1y) was not used for ranking.\n');
  console.log(
    'SMA        TP%   SL%  | train P&L (trades) | validation P&L (trades)  maxDD',
  );
  for (const r of rows.slice(0, 12)) {
    console.log(
      `${`${r.p.fastSma}/${r.p.slowSma}`.padEnd(9)} ${String(r.p.takeProfitPct).padStart(4)} ` +
        `${String(r.p.stopLossPct).padStart(5)}  | ${r.trainPnl.toFixed(1).padStart(8)}% (${String(r.trainTrades).padStart(3)})    | ` +
        `${r.valPnl.toFixed(1).padStart(8)}% (${String(r.valTrades).padStart(3)})     ${r.valDrawdown.toFixed(1).padStart(5)}%`,
    );
  }

  const current = rows.find(
    (r) =>
      r.p.fastSma === config.fastSma &&
      r.p.slowSma === config.slowSma &&
      r.p.takeProfitPct === config.takeProfitPct &&
      r.p.stopLossPct === config.stopLossPct,
  );
  if (current) {
    const rank = rows.indexOf(current) + 1;
    console.log(
      `\nCurrent .env config (SMA ${config.fastSma}/${config.slowSma}, TP ${config.takeProfitPct}/SL ${config.stopLossPct}): ` +
        `rank ${rank}/${rows.length}, train ${current.trainPnl.toFixed(1)}%, validation ${current.valPnl.toFixed(1)}%`,
    );
  }
}

async function main(): Promise<void> {
  await sweep(config.symbols, 'STOCKS (fee 0%)');
  await sweep(config.cryptoSymbols, `CRYPTO (fee ${CRYPTO_FEE_PCT}% per side)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
