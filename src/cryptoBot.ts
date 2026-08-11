/**
 * Fast crypto mean-reversion bot with two modes, switched by TRADE_MODE:
 *
 *   paper (default) — Bybit public prices, simulated fills via PaperBroker,
 *                     no account or keys needed. State: paper-state.json.
 *   live            — Bitvavo EUR spot, REAL market orders via LiveBroker.
 *                     Needs BITVAVO_API_KEY / BITVAVO_API_SECRET in .env
 *                     (trade permission only — never enable withdrawals).
 *                     State: live-state.json.
 *
 * Same strategy, dashboard and manual buttons in both modes.
 * Usage: pnpm build && pnpm crypto:start
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as bybit from './bybit.js';
import * as bitvavo from './bitvavo.js';
import { BitvavoClient } from './bitvavo.js';
import { recordRows, type MlRow } from './dataLogger.js';
import { startDashboard, type DashboardState, type TradeAction, type TradeResult } from './dashboard.js';
import { llmBackend, llmVetoEnabled, newsVeto, startNewsRefresh } from './llmVeto.js';
import { LiveBroker } from './liveBroker.js';
import { PaperBroker } from './paperBroker.js';
import {
  breakevenPrice,
  DEFAULT_FAST_PARAMS,
  rollingStats,
  shouldEnterAtPrice,
  shouldExitAtPrice,
  type FastParams,
  type Stats,
} from './fastStrategy.js';

const mode = (process.env.TRADE_MODE ?? 'paper').toLowerCase();
if (mode !== 'paper' && mode !== 'live') throw new Error(`TRADE_MODE must be "paper" or "live", got "${mode}"`);
const isLive = mode === 'live';
// Live quote currency: EUR (Bitvavo category A, 0.25% taker) or USDC
// (category B, 0.05% taker — 5x cheaper; convert EUR->USDC on Bitvavo first).
const quote = (process.env.FAST_QUOTE ?? 'EUR').toUpperCase();
const currency = isLive ? quote : 'USDT';

const symbolsEnv = (
  process.env.FAST_SYMBOLS ??
  (isLive ? `BTC-${quote},ETH-${quote},SOL-${quote}` : 'BTCUSDT,ETHUSDT,SOLUSDT')
).trim().toUpperCase();
let symbols: string[] = [];

const positionQuote = Number(process.env.FAST_POSITION_USDT ?? (isLive ? 10 : 200));
const maxOpen = Number(process.env.FAST_MAX_OPEN ?? 2);
const maxDailyLoss = Number(process.env.FAST_MAX_DAILY_LOSS ?? (isLive ? 5 : 100));

// Execution & risk gates
const maxSpreadPct = Number(process.env.FAST_MAX_SPREAD_PCT ?? 0.15); // skip entries when book is wider
const entryGapMin = Number(process.env.FAST_ENTRY_GAP_MIN ?? 10); // min minutes between automatic entries
const breadthFrac = Number(process.env.FAST_BREADTH_FRAC ?? 0.3); // >=30% triggered at once = market event
const regimePct = Number(process.env.FAST_REGIME_PCT ?? 0.5); // BTC this far below its 24h mean = bearish
const entryStyle = (process.env.FAST_ENTRY_STYLE ?? 'maker') === 'taker' ? 'taker' : 'maker';
const intervalMin = 5;
const heartbeatSeconds = 60;

const params: FastParams = {
  ...DEFAULT_FAST_PARAMS,
  zEntry: Number(process.env.FAST_Z_ENTRY ?? 2.5),
  stopLossPct: Number(process.env.FAST_STOP_LOSS_PCT ?? 2.5),
  maxHoldBars: Number(process.env.FAST_MAX_HOLD_BARS ?? 72),
  // Bitvavo taker fees at the entry tier: EUR markets 0.25%, USDC markets 0.05%.
  feePctPerSide: Number(process.env.FAST_FEE_PCT ?? (isLive ? (quote === 'USDC' ? 0.05 : 0.25) : 0.1)),
  // After the hold timer: 'breakeven' holds until the first net-profitable
  // price (only the stop-loss forces a losing exit); 'sell' dumps at market.
  timeoutAction: (process.env.FAST_TIMEOUT_ACTION ?? 'breakeven') === 'sell' ? 'sell' : 'breakeven',
};

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Buying toggle: pauses the bot's automatic entries; exits (stop/revert/
// timeout) and manual dashboard actions keep working. Persisted per mode.
const CONTROL_FILE = process.env.CONTROL_FILE ?? join(process.env.STATE_DIR ?? '.', `control-${mode}.json`);
let buyingEnabled = existsSync(CONTROL_FILE)
  ? (JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) as { buyingEnabled: boolean }).buyingEnabled
  : true;

function setBuying(enabled: boolean): void {
  buyingEnabled = enabled;
  mkdirSync(dirname(CONTROL_FILE), { recursive: true });
  writeFileSync(CONTROL_FILE, JSON.stringify({ buyingEnabled }));
  log(`Buying ${enabled ? 'ENABLED' : 'PAUSED'} — exits and manual trades stay active`);
}

function makeBroker(): PaperBroker | LiveBroker {
  if (!isLive) return new PaperBroker(params.feePctPerSide);
  const apiKey = process.env.BITVAVO_API_KEY;
  const apiSecret = process.env.BITVAVO_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('TRADE_MODE=live needs BITVAVO_API_KEY / BITVAVO_API_SECRET in .env (trade-only key, no withdrawal permission)');
  }
  return new LiveBroker(new BitvavoClient(apiKey, apiSecret, quote), quote, entryStyle);
}
const broker = makeBroker();

// Mode-specific data plumbing; everything below it is shared.
const data = isLive
  ? {
      recentCloses: async (symbol: string) => {
        const klines = await bitvavo.fetchCandles(symbol, intervalMin, params.lookback + 10);
        return klines.slice(0, -1).map((k) => k.c);
      },
      recentCloses288: async (symbol: string) => {
        const klines = await bitvavo.fetchCandles(symbol, intervalMin, 290);
        return klines.map((k) => k.c);
      },
      topSymbols: (n: number) => bitvavo.fetchTopMarkets(n, quote),
      stream: bitvavo.streamTrades,
    }
  : {
      recentCloses: async (symbol: string) => {
        const klines = await bybit.fetchKlines(symbol, intervalMin, 1);
        return klines.slice(0, -1).map((k) => k.c);
      },
      recentCloses288: async (symbol: string) => {
        const klines = await bybit.fetchKlines(symbol, intervalMin, 1);
        return klines.map((k) => k.c);
      },
      topSymbols: (n: number) => bybit.fetchTopSymbols(n),
      stream: bybit.streamPrices,
    };

const statsBySymbol = new Map<string, Stats>();
const lastPrice = new Map<string, number>();
const quotes = new Map<string, { bid: number; ask: number }>();
const busy = new Set<string>();
const errorCooldownUntil = new Map<string, number>(); // per-symbol backoff after order errors
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
let lastEntryAt = 0; // global spacing between automatic entries (correlation guard)
let regimeBearish = false; // BTC below its 24h mean → mean reversion stands down

function spreadPct(symbol: string): number | null {
  const q = quotes.get(symbol);
  if (!q) return null;
  return ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100;
}

function triggeredCount(): number {
  return symbols.filter((s) => {
    const z = currentZ(s);
    return z !== null && z < -params.zEntry;
  }).length;
}

function breadthBlocked(): boolean {
  return triggeredCount() >= Math.max(3, Math.ceil(symbols.length * breadthFrac));
}

async function refreshRegime(): Promise<void> {
  try {
    const btc = isLive ? `BTC-${quote}` : 'BTCUSDT';
    const closes = await data.recentCloses288(btc);
    if (closes.length < 100) return;
    const mean = closes.reduce((s, c) => s + c, 0) / closes.length;
    const last = closes[closes.length - 1]!;
    const wasBearish = regimeBearish;
    regimeBearish = last < mean * (1 - regimePct / 100);
    if (regimeBearish !== wasBearish) {
      log(regimeBearish
        ? `REGIME: BTC ${(((last - mean) / mean) * 100).toFixed(2)}% below its 24h mean — new entries blocked`
        : 'REGIME: BTC recovered above its 24h mean — entries re-enabled');
    }
  } catch (err) {
    log(`WARN: regime check failed: ${(err as Error).message}`);
  }
}
let firstTickLogged = false;
let ticksSinceHeartbeat = 0;
let totalTicks = 0;

function barIndexNow(): number {
  return Math.floor(Date.now() / (intervalMin * 60 * 1000));
}

function currentZ(symbol: string): number | null {
  const price = lastPrice.get(symbol);
  const stats = statsBySymbol.get(symbol);
  if (price === undefined || !stats) return null;
  return (price - stats.mean) / stats.std;
}

function isOvertime(enteredAtBar: number): boolean {
  return params.timeoutAction === 'breakeven' && barIndexNow() - enteredAtBar >= params.maxHoldBars;
}

/** Positions still inside their hold window. Overtime (breakeven-hunting)
 *  positions no longer occupy a slot, so new signals keep getting taken. */
function activePositionCount(): number {
  return broker.openPositions.filter((p) => !isOvertime(p.enteredAtBar)).length;
}

function realizedToday(): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return broker.allFills
    .filter((f) => f.side === 'Sell' && new Date(f.time) >= midnight)
    .reduce((s, f) => s + (f.pnlUsdt ?? 0), 0);
}

function recordMlSnapshot(): void {
  const now = new Date().toISOString();
  const triggered = triggeredCount();
  const rows: MlRow[] = [];
  for (const symbol of symbols) {
    const price = lastPrice.get(symbol);
    if (price === undefined) continue;
    const stats = statsBySymbol.get(symbol);
    rows.push({
      t: now,
      symbol,
      price,
      z: currentZ(symbol),
      volPct: stats ? (stats.std / price) * 100 : null,
      spreadPct: spreadPct(symbol),
      regimeBearish,
      triggeredCount: triggered,
      holding: broker.position(symbol) !== undefined,
    });
  }
  recordRows(rows, log);
}

async function refreshStats(): Promise<void> {
  for (let i = 0; i < symbols.length; i += 10) {
    await Promise.all(
      symbols.slice(i, i + 10).map(async (symbol) => {
        try {
          const closes = await data.recentCloses(symbol);
          const stats = rollingStats(closes, params.lookback);
          if (stats) statsBySymbol.set(symbol, stats);
        } catch (err) {
          log(`WARN: stats refresh failed for ${symbol}: ${(err as Error).message}`);
        }
      }),
    );
  }
}

function onTick(symbol: string, price: number): void {
  if (!firstTickLogged) {
    firstTickLogged = true;
    log(`first tick received (${symbol} @ ${price}) — stream is live`);
  }
  ticksSinceHeartbeat++;
  totalTicks++;
  lastPrice.set(symbol, price);
  if (busy.has(symbol)) return;
  if ((errorCooldownUntil.get(symbol) ?? 0) > Date.now()) return;
  const stats = statsBySymbol.get(symbol);
  if (!stats) return;

  busy.add(symbol);
  void (async () => {
    try {
      const open = broker.position(symbol);

      if (open) {
        const barsHeld = barIndexNow() - open.enteredAtBar;
        const reason = shouldExitAtPrice(price, stats, open.entry, barsHeld, params);
        if (reason) {
          const fill = await broker.sell(symbol, price, reason);
          log(
            `SELL ${symbol} ${fill.qtyBase.toFixed(6)} @ ${fill.price} | ${reason} | ` +
              `P&L ${fill.pnlUsdt!.toFixed(2)} ${currency} | ${broker.summary()}`,
          );
        }
        return;
      }

      if (!buyingEnabled) return; // user paused new entries; exits above still ran
      if (activePositionCount() >= maxOpen) return; // overtime positions don't hold a slot
      if (broker.balanceUsdt < positionQuote) return;
      if (realizedToday() <= -maxDailyLoss) return; // kill switch: no new entries today

      if (!shouldEnterAtPrice(price, stats, params)) return;

      // Gate chain — each protects against a different way of losing:
      if (regimeBearish) return; // 3. falling market: reversion stands down
      if (Date.now() - lastEntryAt < entryGapMin * 60 * 1000) return; // 2. entry spacing
      if (breadthBlocked()) return; // 2. half the board triggering = one market event, not N signals
      const spread = spreadPct(symbol);
      if (spread !== null && spread > maxSpreadPct) return; // 1. wide book = invisible fee
      const coin = symbol.replace(/[-]?(EUR|USDC|USDT)$/, '');
      if (await newsVeto(coin, log)) return; // 5. LLM: breaking bad news on this coin

      // Maker entries rest at the best bid; taker/paper entries use the live price.
      const entryPrice = quotes.get(symbol)?.bid ?? price;
      lastEntryAt = Date.now();
      const pos = await broker.buy(symbol, positionQuote, entryPrice, barIndexNow());
      log(
        `BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${pos.entry} (${positionQuote} ${currency}), ` +
          `stop ${(pos.entry * (1 - params.stopLossPct / 100)).toFixed(4)} | ${broker.summary()}`,
      );
    } catch (err) {
      errorCooldownUntil.set(symbol, Date.now() + ERROR_COOLDOWN_MS);
      log(`ERROR ${symbol}: ${(err as Error).message} — cooling down ${symbol} for ${ERROR_COOLDOWN_MS / 60000}min`);
    } finally {
      busy.delete(symbol);
    }
  })();
}

function heartbeat(): void {
  const scored = symbols
    .map((symbol) => ({ symbol, z: currentZ(symbol) }))
    .filter((s): s is { symbol: string; z: number } => s.z !== null)
    .sort((a, b) => a.z - b.z);

  const shown = scored.slice(0, 5);
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
    mode: isLive ? 'LIVE — real money (Bitvavo)' : 'paper trading (live prices)',
    currency,
    buyingEnabled,
    gates: {
      regimeBearish,
      breadthBlocked: breadthBlocked(),
      triggeredCount: triggeredCount(),
      entryGapActive: Date.now() - lastEntryAt < entryGapMin * 60 * 1000,
      llmVeto: llmVetoEnabled,
      entryStyle: isLive ? entryStyle : 'market (paper)',
      maxSpreadPct,
    },
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
        overtime: isOvertime(p.enteredAtBar),
        breakevenPrice: breakevenPrice(p.entry, params),
      };
    }),
    fills: broker.allFills.slice(-200),
    equitySeries,
    totalTicks,
  };
}

async function handleManualTrade({ action, symbol }: TradeAction): Promise<TradeResult> {
  if (!symbols.includes(symbol)) return { ok: false, message: `${symbol} is not tracked by this bot` };
  const price = lastPrice.get(symbol);
  if (price === undefined) return { ok: false, message: `${symbol}: no live price yet` };

  try {
    if (action === 'buy') {
      if (broker.position(symbol)) return { ok: false, message: `${symbol}: already holding` };
      if (broker.balanceUsdt < positionQuote) {
        return { ok: false, message: `insufficient ${currency} (${broker.balanceUsdt.toFixed(2)})` };
      }
      const pos = await broker.buy(symbol, positionQuote, price, barIndexNow(), 'manual');
      log(`MANUAL BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${pos.entry} | ${broker.summary()}`);
      return { ok: true, message: `Bought ${symbol} @ ${pos.entry} — bot manages the exit (stop/revert/timeout)` };
    }
    const open = broker.position(symbol);
    if (!open) return { ok: false, message: `${symbol}: no open position` };
    const fill = await broker.sell(symbol, price, 'manual');
    log(`MANUAL SELL ${symbol} @ ${fill.price} | P&L ${fill.pnlUsdt!.toFixed(2)} ${currency} | ${broker.summary()}`);
    return { ok: true, message: `Sold ${symbol} @ ${fill.price} — P&L ${fill.pnlUsdt!.toFixed(2)} ${currency}` };
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
    const n = Math.min(Number(topMatch[1]), 50);
    symbols = await data.topSymbols(n);
    log(`Auto-selected top ${symbols.length} ${currency} pairs by 24h volume`);
  } else {
    symbols = symbolsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (isLive) {
    log('Mode: *** LIVE — REAL MONEY on Bitvavo ***');
    log(`Safety rails: ${positionQuote} EUR/trade, max ${maxOpen} open, kill switch at -${maxDailyLoss} EUR/day`);
    log('Starting in 30 seconds — Ctrl+C now to abort.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await (broker as LiveBroker).refreshBalance();
    setInterval(() => void (broker as LiveBroker).refreshBalance().catch((e: Error) => log(`WARN balance: ${e.message}`)), 60_000);

    // Adopt coins already sitting in the account (bought manually, or left
    // behind by another bot instance) so their exits are managed too.
    try {
      await (broker as LiveBroker).adoptExisting(
        5,
        async (market) => {
          try {
            const klines = await bitvavo.fetchCandles(market, intervalMin, 2);
            return klines[klines.length - 1]?.c ?? null;
          } catch {
            return null;
          }
        },
        barIndexNow(),
        log,
      );
    } catch (err) {
      log(`WARN: asset adoption failed: ${(err as Error).message}`);
    }
  }

  // Positions restored from state (or just adopted) may reference markets
  // outside today's TOP-N list — track them anyway so their exits work.
  for (const p of broker.openPositions) {
    if (!symbols.includes(p.symbol)) {
      symbols.push(p.symbol);
      log(`Tracking ${p.symbol} (open position outside the selected list)`);
    }
  }

  if (!isLive) {
    log('Mode: LOCAL PAPER TRADING (streaming prices, simulated fills, no real money)');
  }

  log(broker.summary());
  log(`Symbols (${symbols.length}): ${symbols.join(', ')} | ${positionQuote} ${currency}/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars, fee ${params.feePctPerSide}%/side`);
  log(`Reaction: tick-level (websocket). Entry trigger z < -${params.zEntry}.`);

  if (!buyingEnabled) log('Note: buying is PAUSED (persisted from last session) — toggle it on the dashboard');
  // PORT is what cloud hosts (Railway etc.) inject; DASH_PORT is the local override.
  startDashboard(
    Number(process.env.PORT ?? process.env.DASH_PORT ?? 8787),
    buildDashboardState,
    handleManualTrade,
    setBuying,
    log,
  );

  log(
    `Gates: entry style ${isLive ? entryStyle : 'paper/market'}, max spread ${maxSpreadPct}%, ` +
      `entry gap ${entryGapMin}min, breadth ${Math.round(breadthFrac * 100)}%, ` +
      `regime BTC -${regimePct}%, LLM veto ${llmVetoEnabled ? `ON — ${llmBackend}` : 'off'}`,
  );
  startNewsRefresh(log);

  await refreshStats();
  await refreshRegime();
  data.stream(symbols, onTick, log, (symbol: string, bid: number, ask: number) =>
    quotes.set(symbol, { bid, ask }),
  );

  setInterval(() => {
    void refreshStats().then(() => recordMlSnapshot());
    void refreshRegime();
  }, intervalMin * 60 * 1000);
  setInterval(heartbeat, heartbeatSeconds * 1000);
  setTimeout(heartbeat, 5_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
