/**
 * Backtest the configured strategy over 3 years of daily bars.
 * Usage: pnpm build && pnpm backtest
 */
import { config } from './config.js';
import { fetchDailyBars } from './data.js';
import { backtestSymbol, summarize } from './engine.js';

async function main(): Promise<void> {
  const p = {
    fastSma: config.fastSma,
    slowSma: config.slowSma,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
  };
  console.log(
    `Backtest: SMA ${p.fastSma}/${p.slowSma}, TP ${p.takeProfitPct}% / SL ${p.stopLossPct}%, ` +
      `daily bars, 3 years\n`,
  );

  let totalTrades = 0;
  let totalPnl = 0;

  for (const symbol of config.symbols) {
    const bars = await fetchDailyBars(symbol, 3);
    if (bars.length < p.slowSma * 2) {
      console.log(`${symbol}: not enough data (${bars.length} bars), skipping`);
      continue;
    }
    const trades = backtestSymbol(bars, p);
    const s = summarize(trades);
    const stops = trades.filter((t) => t.reason === 'stop').length;
    totalTrades += s.trades;
    totalPnl += s.pnl;

    console.log(
      `${symbol.padEnd(6)} trades ${String(s.trades).padStart(3)} | wins ${s.wins} | ` +
        `stopped out ${stops} | P&L ${s.pnl.toFixed(2)}% | max drawdown ${s.maxDrawdown.toFixed(2)}%`,
    );
  }

  console.log(`\nTOTAL: ${totalTrades} trades, ${totalPnl.toFixed(2)}% cumulative per-position P&L.`);
  console.log(
    'Note: past performance ≠ future results. A positive backtest is a prerequisite, not a promise.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
