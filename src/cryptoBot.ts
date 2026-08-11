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
import { fetchKlines, fetchTopSymbols, streamPrices } from './bybit.js';
import { startDashboard, type DashboardState, type TradeAction, type TradeResult } from './dashboard.js';
import { PaperBroker } from './paperBroker.js';
import {
  DEFAULT_FAST_PARAMS,
  rollingStats,
  shouldEnterAtPrice,
  shouldExitAtPrice,
  type FastParams,
  type Stats,
} from './fastStrategy.js';

// FAST_SYMBOLS is either a comma list, or TOP<n> (e.g. TOP30) to auto-select
// the n highest-volume USDT pairs on Bybit at startup.
const symbolsEnv = (process.env.FAST_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT').trim().toUpperCase();
let symbols: string[] = [];
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
  for (let i = 0; i < symbols.length; i += 10) {
    await Promise.all(
      symbols.slice(i, i + 10).map(async (symbol) => {
        try {
          const klines = await fetchKlines(symbol, intervalMin, 1);
          const closes = klines.slice(0, -1).map((k) => k.c); // closed bars only
          const stats = rollingStats(closes, params.lookback);
          if (stats) statsBySymbol.set(symbol, stats);
        } catch (err) {
          log(`WARN: stats refresh failed for ${symbol}: ${(err as Error).message}`);
        }
      }),
    );
  }
}

let firstTickLogged = false;
let ticksSinceHeartbeat = 0;
let totalTicks = 0;

function onTick(symbol: string, price: number): void {
  if (!firstTickLogged) {
    firstTickLogged = true;
    log(`first tick received (${symbol} @ ${price}) — stream is live`);
  }
  ticksSinceHeartbeat++;
  totalTicks++;
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

function currentZ(symbol: string): number | null {
  const price = lastPrice.get(symbol);
  const stats = statsBySymbol.get(symbol);
  if (price === undefined || !stats) return null;
  return (price - stats.mean) / stats.std;
}

function heartbeat(): void {
  const scored = symbols
    .map((symbol) => ({ symbol, z: currentZ(symbol) }))
    .filter((s): s is { symbol: string; z: number } => s.z !== null)
    .sort((a, b) => a.z - b.z);

  const shown = scored.slice(0, 5); // the ones closest to a buy signal
  const parts = shown.map(({ symbol, z }) => {
    const open = broker.position(symbol);
    return `${symbol} z=${z.toFixed(2)}${open ? ' [holding]' : ''}`;
  });
  const holding = broker.openPositions.map((p) => p.symbol).join(',');
  log(
    `closest to entry: ${parts.join(' | ') || 'warming up'} ` +
      `|| ${scored.length}/${symbols.length} tracked, holding [${holding}], ` +
      `${ticksSinceHeartbeat} ticks/${heartbeatSeconds}s — full view on the dashboard`,
  );
  ticksSinceHeartbeat = 0;
}

function buildDashboardState(): DashboardState {
  const sells = broker.allFills.filter(
    (f): f is typeof f & { pnlUsdt: number } => f.side === 'Sell' && f.pnlUsdt !== undefined,
  );
  const realizedPnl = sells.reduce((s, f) => s + f.pnlUsdt, 0);
  const marketValue = broker.openPositions.reduce(
    (s, p) => s + p.qtyBase * (lastPrice.get(p.symbol) ?? p.entry),
    0,
  );

  // Equity curve: realized equity after each closed trade, plus a live point.
  let running = broker.startUsdt;
  const equitySeries: { t: string; v: number }[] = [
    ...(sells.length > 0 ? [{ t: sells[0]!.time, v: broker.startUsdt }] : []),
    ...sells.map((f) => {
      running += f.pnlUsdt;
      return { t: f.time, v: running };
    }),
  ];
  equitySeries.push({ t: new Date().toISOString(), v: broker.balanceUsdt + marketValue });

  return {
    mode: 'paper trading (live prices)',
    params: {
      zEntry: params.zEntry,
      stopLossPct: params.stopLossPct,
      maxHoldBars: params.maxHoldBars,
      feePctPerSide: params.feePctPerSide,
    },
    symbols: symbols
      .map((symbol) => {
        const price = lastPrice.get(symbol) ?? null;
        const stats = statsBySymbol.get(symbol);
        const volPct = price !== null && stats ? (stats.std / price) * 100 : null;
        const minVolPct = params.minVolMultiple * ((params.feePctPerSide * 2) / 100) * 100;
        return {
          symbol,
          price,
          z: currentZ(symbol),
          holding: broker.position(symbol) !== undefined,
          volPct,
          volOk: volPct !== null && volPct >= minVolPct,
          minVolPct,
        };
      })
      .sort((a, b) => (a.z ?? Infinity) - (b.z ?? Infinity)),
    wallet: {
      usdt: broker.balanceUsdt,
      equityNow: broker.balanceUsdt + marketValue,
      realizedPnl,
      openCount: broker.openPositions.length,
      closedCount: sells.length,
      wins: sells.filter((f) => f.pnlUsdt > 0).length,
    },
    positions: broker.openPositions.map((p) => {
      const current = lastPrice.get(p.symbol) ?? null;
      return {
        symbol: p.symbol,
        entry: p.entry,
        current,
        qtyBase: p.qtyBase,
        unrealizedPnl:
          current === null ? null : p.qtyBase * current * (1 - params.feePctPerSide / 100) - p.costUsdt,
        holdMinutes: (barIndexNow() - p.enteredAtBar) * intervalMin,
        z: currentZ(p.symbol),
        stopPrice: p.entry * (1 - params.stopLossPct / 100),
        timeoutMinutes: params.maxHoldBars * intervalMin,
      };
    }),
    fills: broker.allFills.slice(-200),
    equitySeries,
    totalTicks,
  };
}

function handleManualTrade({ action, symbol }: TradeAction): TradeResult {
  if (!symbols.includes(symbol)) return { ok: false, message: `${symbol} is not tracked by this bot` };
  const price = lastPrice.get(symbol);
  if (price === undefined) return { ok: false, message: `${symbol}: no live price yet` };

  try {
    if (action === 'buy') {
      if (broker.position(symbol)) return { ok: false, message: `${symbol}: already holding` };
      if (broker.balanceUsdt < positionUsdt) {
        return { ok: false, message: `insufficient paper USDT (${broker.balanceUsdt.toFixed(2)})` };
      }
      const pos = broker.buy(symbol, positionUsdt, price, barIndexNow(), 'manual');
      log(`MANUAL BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${price} | ${broker.summary()}`);
      return { ok: true, message: `Bought ${symbol} @ ${price} — bot manages the exit (stop/revert/timeout)` };
    }
    const open = broker.position(symbol);
    if (!open) return { ok: false, message: `${symbol}: no open position` };
    const fill = broker.sell(symbol, price, 'manual');
    log(`MANUAL SELL ${symbol} @ ${price} | P&L ${fill.pnlUsdt!.toFixed(2)} USDT | ${broker.summary()}`);
    return { ok: true, message: `Sold ${symbol} @ ${price} — P&L ${fill.pnlUsdt!.toFixed(2)} USDT` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function main(): Promise<void> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket global missing — run via `pnpm crypto:start` (needs --experimental-websocket on Node 20)');
  }

  const topMatch = /^TOP(\d+)$/.exec(symbolsEnv);
  if (topMatch) {
    const n = Math.min(Number(topMatch[1]), 50); // websocket/refresh sanity cap
    symbols = await fetchTopSymbols(n);
    log(`Auto-selected top ${symbols.length} USDT pairs by 24h volume`);
  } else {
    symbols = symbolsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  }

  log('Mode: LOCAL PAPER TRADING (streaming Bybit prices, simulated fills, no real money)');
  log(broker.summary());
  log(`Symbols (${symbols.length}): ${symbols.join(', ')} | ${positionUsdt} USDT/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars, fee ${params.feePctPerSide}%/side`);
  log(`Reaction: tick-level (websocket). Entry trigger z < -${params.zEntry} — a few signals/day is normal.`);

  startDashboard(Number(process.env.DASH_PORT ?? 8787), buildDashboardState, handleManualTrade, log);

  await refreshStats();
  streamPrices(symbols, onTick, log);

  // Recompute bar statistics shortly after each 5-min bar closes.
  setInterval(() => void refreshStats(), intervalMin * 60 * 1000);
  setInterval(heartbeat, heartbeatSeconds * 1000);
  setTimeout(heartbeat, 5_000); // first heartbeat after the stream has had a moment
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
