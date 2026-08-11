/**
 * Fast crypto mean-reversion bot — local PAPER trading, tick-level reaction.
 *
 * Prices stream in real time over Bybit's public websocket (no account).
 * The statistical baseline (rolling mean/std) is recomputed from closed
 * 5-min bars; every tick is checked against it instantly, so entries,
 * stop-losses and reversion exits fire within milliseconds of the price
 * crossing the line — not at the next poll.
 *
 * Fills are simulated locally by PaperBroker (fees included) and persist
 * in paper-state.json. Delete that file to reset the paper wallet.
 *
 * Usage: pnpm build && pnpm crypto:start
 */
import { fetchKlines, streamPrices } from './bybit.js';
import { PaperBroker } from './paperBroker.js';
import {
  DEFAULT_FAST_PARAMS,
  rollingStats,
  shouldEnterAtPrice,
  shouldExitAtPrice,
  type FastParams,
  type Stats,
} from './fastStrategy.js';

const symbols = (process.env.FAST_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const positionUsdt = Number(process.env.FAST_POSITION_USDT ?? 200);
const maxOpen = Number(process.env.FAST_MAX_OPEN ?? 2);
const intervalMin = 5;
const heartbeatSeconds = 60;

// Best sweep combo that stayed positive in validation (see cryptoBacktest.ts).
const params: FastParams = {
  ...DEFAULT_FAST_PARAMS,
  zEntry: Number(process.env.FAST_Z_ENTRY ?? 2.5),
  stopLossPct: Number(process.env.FAST_STOP_LOSS_PCT ?? 2.5),
  maxHoldBars: Number(process.env.FAST_MAX_HOLD_BARS ?? 72),
};

const broker = new PaperBroker(params.feePctPerSide);
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

const statsBySymbol = new Map<string, Stats>();
const lastPrice = new Map<string, number>();
const busy = new Set<string>(); // guards against double-acting while a tick is processed

function barIndexNow(): number {
  return Math.floor(Date.now() / (intervalMin * 60 * 1000));
}

async function refreshStats(): Promise<void> {
  for (const symbol of symbols) {
    try {
      const klines = await fetchKlines(symbol, intervalMin, 1);
      const closes = klines.slice(0, -1).map((k) => k.c); // closed bars only
      const stats = rollingStats(closes, params.lookback);
      if (stats) statsBySymbol.set(symbol, stats);
    } catch (err) {
      log(`WARN: stats refresh failed for ${symbol}: ${(err as Error).message}`);
    }
  }
}

function onTick(symbol: string, price: number): void {
  lastPrice.set(symbol, price);
  if (busy.has(symbol)) return;
  const stats = statsBySymbol.get(symbol);
  if (!stats) return;

  busy.add(symbol);
  try {
    const open = broker.position(symbol);

    if (open) {
      const barsHeld = barIndexNow() - open.enteredAtBar;
      const reason = shouldExitAtPrice(price, stats, open.entry, barsHeld, params);
      if (reason) {
        const fill = broker.sell(symbol, price, reason);
        log(
          `SELL ${symbol} ${fill.qtyBase.toFixed(6)} @ ${price} | ${reason} | ` +
            `P&L ${fill.pnlUsdt!.toFixed(2)} USDT | ${broker.summary()}`,
        );
      }
      return;
    }

    if (broker.openPositions.length >= maxOpen) return;
    if (broker.balanceUsdt < positionUsdt) return;

    if (shouldEnterAtPrice(price, stats, params)) {
      const pos = broker.buy(symbol, positionUsdt, price, barIndexNow());
      log(
        `BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${price} (${positionUsdt} USDT), ` +
          `stop ${(price * (1 - params.stopLossPct / 100)).toFixed(2)} | ${broker.summary()}`,
      );
    }
  } finally {
    busy.delete(symbol);
  }
}

function heartbeat(): void {
  const parts = symbols.map((symbol) => {
    const price = lastPrice.get(symbol);
    const stats = statsBySymbol.get(symbol);
    if (price === undefined || !stats) return `${symbol} warming up`;
    const z = (price - stats.mean) / stats.std;
    const open = broker.position(symbol);
    return `${symbol} ${price} z=${z.toFixed(2)}${open ? ` [holding, entry ${open.entry}]` : ''}`;
  });
  log(parts.join(' | '));
}

async function main(): Promise<void> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket global missing — run via `pnpm crypto:start` (needs --experimental-websocket on Node 20)');
  }

  log('Mode: LOCAL PAPER TRADING (streaming Bybit prices, simulated fills, no real money)');
  log(broker.summary());
  log(`Symbols: ${symbols.join(', ')} | ${positionUsdt} USDT/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars, fee ${params.feePctPerSide}%/side`);
  log(`Reaction: tick-level (websocket). Entry trigger z < -${params.zEntry} — a few signals/day is normal.`);

  await refreshStats();
  streamPrices(symbols, onTick);

  // Recompute bar statistics shortly after each 5-min bar closes.
  setInterval(() => void refreshStats(), intervalMin * 60 * 1000);
  setInterval(heartbeat, heartbeatSeconds * 1000);
  heartbeat();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
