/**
 * Simple backtest of the SMA-crossover + bracket-exit strategy over
 * historical daily bars. Deliberately conservative: fills at next bar
 * open, and if both stop and target are hit within one bar, the STOP
 * is assumed to fill (worst case).
 *
 * Usage: pnpm build && pnpm backtest
 */
import { config } from './config.js';
import { sma } from './strategy.js';
import type { Bar } from './alpaca.js';

const FEE_PCT = 0; // Alpaca US stocks are commission-free
const SLIPPAGE_PCT = 0.02; // assume 2 bps slippage per side

async function fetchDailyBars(symbol: string, years: number): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - years * 365 * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    timeframe: '1Day',
    start: start.toISOString(),
    limit: '10000',
    feed: 'iex',
    adjustment: 'split',
  });
  const res = await fetch(`${config.dataUrl}/v2/stocks/${symbol}/bars?${params}`, {
    headers: {
      'APCA-API-KEY-ID': config.keyId,
      'APCA-API-SECRET-KEY': config.secretKey,
    },
  });
  if (!res.ok) throw new Error(`bars ${symbol}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { bars: Bar[] | null };
  return data.bars ?? [];
}

interface Trade {
  entry: number;
  exit: number;
  pnlPct: number;
  reason: 'target' | 'stop' | 'end';
}

function backtestSymbol(bars: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const closes = bars.map((b) => b.c);
  let position: { entry: number; target: number; stop: number } | null = null;

  for (let i = config.slowSma + 1; i < bars.length; i++) {
    const bar = bars[i]!;

    if (position) {
      // Worst case: stop fills before target when both are within the bar.
      if (bar.l <= position.stop) {
        const exit = position.stop * (1 - SLIPPAGE_PCT / 100);
        trades.push(closeTrade(position.entry, exit, 'stop'));
        position = null;
      } else if (bar.h >= position.target) {
        const exit = position.target * (1 - SLIPPAGE_PCT / 100);
        trades.push(closeTrade(position.entry, exit, 'target'));
        position = null;
      }
      continue;
    }

    const upto = closes.slice(0, i); // signal uses data up to previous bar only
    const fastNow = sma(upto, config.fastSma);
    const slowNow = sma(upto, config.slowSma);
    const fastPrev = sma(upto.slice(0, -1), config.fastSma);
    const slowPrev = sma(upto.slice(0, -1), config.slowSma);
    if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) continue;

    if (fastPrev <= slowPrev && fastNow > slowNow) {
      const entry = bar.o * (1 + SLIPPAGE_PCT / 100); // fill at next open + slippage
      position = {
        entry,
        target: entry * (1 + config.takeProfitPct / 100),
        stop: entry * (1 - config.stopLossPct / 100),
      };
    }
  }

  if (position) {
    const lastClose = closes[closes.length - 1]!;
    trades.push(closeTrade(position.entry, lastClose, 'end'));
  }
  return trades;
}

function closeTrade(entry: number, exit: number, reason: Trade['reason']): Trade {
  const pnlPct = ((exit - entry) / entry) * 100 - FEE_PCT * 2;
  return { entry, exit, pnlPct, reason };
}

async function main(): Promise<void> {
  console.log(
    `Backtest: SMA ${config.fastSma}/${config.slowSma}, ` +
      `TP ${config.takeProfitPct}% / SL ${config.stopLossPct}%, daily bars, 3 years\n`,
  );

  let totalTrades = 0;
  let totalPnl = 0;

  for (const symbol of config.symbols) {
    const bars = await fetchDailyBars(symbol, 3);
    if (bars.length < config.slowSma * 2) {
      console.log(`${symbol}: not enough data (${bars.length} bars), skipping`);
      continue;
    }
    const trades = backtestSymbol(bars);
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const stops = trades.filter((t) => t.reason === 'stop').length;
    const pnl = trades.reduce((sum, t) => sum + t.pnlPct, 0);
    totalTrades += trades.length;
    totalPnl += pnl;

    console.log(
      `${symbol.padEnd(6)} trades ${String(trades.length).padStart(3)} | ` +
        `wins ${wins} | stopped out ${stops} | ` +
        `cumulative P&L ${pnl.toFixed(2)}% (sequential, per-position)`,
    );
  }

  console.log(
    `\nTOTAL: ${totalTrades} trades, ${totalPnl.toFixed(2)}% cumulative per-position P&L.`,
  );
  console.log(
    'Note: past performance ≠ future results. A positive backtest is a prerequisite, not a promise.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
