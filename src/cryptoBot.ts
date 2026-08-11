/**
 * Fast crypto mean-reversion bot — local PAPER trading by default.
 *
 * Uses Bybit PUBLIC market data (works without an account) and simulates
 * fills locally via PaperBroker with fees included. No API keys needed.
 * State persists in paper-state.json; delete it to reset the paper wallet.
 *
 * Runs alongside the Alpaca stock bot; completely independent process.
 *
 * Usage: pnpm build && pnpm crypto:start
 */
import { fetchKlines } from './bybit.js';
import { PaperBroker } from './paperBroker.js';
import {
  DEFAULT_FAST_PARAMS,
  rollingStats,
  shouldEnter,
  shouldExit,
  type FastParams,
} from './fastStrategy.js';

const symbols = (process.env.FAST_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const positionUsdt = Number(process.env.FAST_POSITION_USDT ?? 200);
const maxOpen = Number(process.env.FAST_MAX_OPEN ?? 2);
const intervalMin = 5;
const pollSeconds = 60;

// Best sweep combo that stayed positive in validation (see cryptoBacktest.ts).
const params: FastParams = {
  ...DEFAULT_FAST_PARAMS,
  zEntry: Number(process.env.FAST_Z_ENTRY ?? 2.5),
  stopLossPct: Number(process.env.FAST_STOP_LOSS_PCT ?? 2.5),
  maxHoldBars: Number(process.env.FAST_MAX_HOLD_BARS ?? 72),
};

const broker = new PaperBroker(params.feePctPerSide);
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function tickSymbol(symbol: string, barIndexNow: number): Promise<string> {
  const klines = await fetchKlines(symbol, intervalMin, 1);
  const closed = klines.slice(0, -1); // drop the still-forming bar
  const closes = closed.map((k) => k.c);
  if (closes.length < params.lookback + 2) return `${symbol} warming up`;

  const price = closes[closes.length - 1]!;
  const stats = rollingStats(closes, params.lookback);
  const open = broker.position(symbol);
  const status = `${symbol} ${price} z=${stats ? stats.z.toFixed(2) : '?'}${open ? ` [holding, entry ${open.entry}]` : ''}`;

  if (open) {
    const reason = shouldExit(closes, open.entry, barIndexNow - open.enteredAtBar, params);
    if (reason) {
      const fill = broker.sell(symbol, price, reason);
      log(
        `SELL ${symbol} ${fill.qtyBase.toFixed(6)} @ ${price} | ${reason} | ` +
          `P&L ${fill.pnlUsdt!.toFixed(2)} USDT | ${broker.summary()}`,
      );
    }
    return status;
  }

  if (broker.openPositions.length >= maxOpen) return status;
  if (broker.balanceUsdt < positionUsdt) return `${status} (wallet too low for new position)`;

  if (shouldEnter(closes, params)) {
    const pos = broker.buy(symbol, positionUsdt, price, barIndexNow);
    log(
      `BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${price} (${positionUsdt} USDT), ` +
        `stop ${(price * (1 - params.stopLossPct / 100)).toFixed(2)} | ${broker.summary()}`,
    );
  }
  return status;
}

async function main(): Promise<void> {
  log('Mode: LOCAL PAPER TRADING (live Bybit prices, simulated fills, no real money)');
  log(broker.summary());
  log(`Symbols: ${symbols.join(', ')} | ${positionUsdt} USDT/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars, fee ${params.feePctPerSide}%/side`);

  log(`Entry trigger: z < -${params.zEntry} (roughly once a day per symbol — patience is the strategy)`);

  for (;;) {
    const barIndexNow = Math.floor(Date.now() / (intervalMin * 60 * 1000));
    const statuses: string[] = [];
    for (const symbol of symbols) {
      try {
        statuses.push(await tickSymbol(symbol, barIndexNow));
      } catch (err) {
        log(`ERROR ${symbol}: ${(err as Error).message}`);
      }
    }
    log(statuses.join(' | '));
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
