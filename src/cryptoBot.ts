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
import { startDashboard, type DashboardState, type TradeAction, type TradeResult } from './dashboard.js';
import { askLlm, currentHeadlines, llmBackend, llmConfigured, llmVetoEnabled, newsVeto, startNewsRefresh } from './llmVeto.js';
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

// LLM_TRADER=1: an LLM makes the buy/sell decisions instead of the z-score
// strategy. PAPER ONLY by design — an unproven, non-deterministic strategy
// must earn its way to real money on the same terms every strategy did.
// The tick-level stop-loss remains active underneath as a disaster brake.
const llmTrader = process.env.LLM_TRADER === '1';
// LLM + real money requires a deliberate, explicit opt-in. The LLM is a
// non-deterministic, unbacktestable strategy: expect losses, size small,
// and know that the stop-loss + daily kill switch are the only hard floors.
if (llmTrader && isLive && process.env.LLM_LIVE_OK !== '1') {
  throw new Error(
    'LLM_TRADER with TRADE_MODE=live needs LLM_LIVE_OK=1 — an explicit acknowledgment ' +
      'that an unproven AI strategy will trade real money within the configured risk limits.',
  );
}

// LLM_FULL_CONTROL=1 sets the INITIAL default for the stop-loss toggle (off).
// The live toggle (control.stopLossEnabled) is the runtime source of truth and
// can be flipped from the dashboard; it persists across restarts.
// Live quote currency: EUR (Bitvavo category A, 0.25% taker) or USDC
// (category B, 0.05% taker — 5x cheaper; convert EUR->USDC on Bitvavo first).
const quote = (process.env.FAST_QUOTE ?? 'EUR').toUpperCase();
// LLM trader trades a paper wallet against Bitvavo data: same venue, coins
// and fees as the live statistical bot, so their results compare directly.
// (Also practical: Bybit 403s from some cloud egress IPs; Bitvavo doesn't.)
const useBitvavoData = isLive || llmTrader;
const currency = useBitvavoData ? quote : 'USDT';

const symbolsEnv = (
  process.env.FAST_SYMBOLS ??
  (useBitvavoData ? `BTC-${quote},ETH-${quote},SOL-${quote}` : 'BTCUSDT,ETHUSDT,SOLUSDT')
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
// The LLM trader uses market (taker) entries: they spend a fixed EUR amount,
// so they always fill and never trip Bitvavo's amount-decimal / price-tick
// rules. The statistical bot defaults to maker limit orders for the cheaper fee.
const entryStyle: 'maker' | 'taker' = llmTrader
  ? 'taker'
  : (process.env.FAST_ENTRY_STYLE ?? 'maker') === 'taker'
    ? 'taker'
    : 'maker';
const intervalMin = 5;
const heartbeatSeconds = 60;

const params: FastParams = {
  ...DEFAULT_FAST_PARAMS,
  zEntry: Number(process.env.FAST_Z_ENTRY ?? 2.5),
  stopLossPct: Number(process.env.FAST_STOP_LOSS_PCT ?? 2.5),
  maxHoldBars: Number(process.env.FAST_MAX_HOLD_BARS ?? 72),
  // Bitvavo taker fees at the entry tier: EUR markets 0.25%, USDC markets 0.05%.
  feePctPerSide: Number(process.env.FAST_FEE_PCT ?? (useBitvavoData ? (quote === 'USDC' ? 0.05 : 0.25) : 0.1)),
  // After the hold timer: 'breakeven' holds until the first net-profitable
  // price (only the stop-loss forces a losing exit); 'sell' dumps at market.
  timeoutAction: (process.env.FAST_TIMEOUT_ACTION ?? 'breakeven') === 'sell' ? 'sell' : 'breakeven',
};

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Buying toggle: pauses the bot's automatic entries; exits (stop/revert/
// timeout) and manual dashboard actions keep working. Persisted per mode.
const CONTROL_FILE = process.env.CONTROL_FILE ?? join(process.env.STATE_DIR ?? '.', `control-${mode}.json`);
interface Control {
  buyingEnabled: boolean;
  stopLossEnabled: boolean;
}
const control: Control = (() => {
  // Default stop-loss OFF only in the paper full-control experiment; ON everywhere else.
  const defaults: Control = {
    buyingEnabled: true,
    stopLossEnabled: !(llmTrader && process.env.LLM_FULL_CONTROL === '1' && !isLive),
  };
  try {
    if (existsSync(CONTROL_FILE)) return { ...defaults, ...JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) };
  } catch {
    /* fall through to defaults */
  }
  return defaults;
})();

function saveControl(): void {
  mkdirSync(dirname(CONTROL_FILE), { recursive: true });
  writeFileSync(CONTROL_FILE, JSON.stringify(control));
}

function setBuying(enabled: boolean): void {
  control.buyingEnabled = enabled;
  saveControl();
  log(`Buying ${enabled ? 'ENABLED' : 'PAUSED'} — exits and manual trades stay active`);
}

function setStopLoss(enabled: boolean): void {
  control.stopLossEnabled = enabled;
  saveControl();
  log(
    enabled
      ? `Automatic stop-loss ENABLED (${params.stopLossPct}% per position)`
      : `Automatic stop-loss DISABLED — ${isLive ? '*** the LLM alone protects real money ***' : 'the LLM alone decides every exit'}`,
  );
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
const data = useBitvavoData
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
    const btc = useBitvavoData ? `BTC-${quote}` : 'BTCUSDT';
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
        // LLM-trader mode: the LLM owns sells; the automatic stop-loss fires
        // only while the dashboard toggle (control.stopLossEnabled) is on.
        const reason = llmTrader
          ? control.stopLossEnabled && price <= open.entry * (1 - params.stopLossPct / 100)
            ? ('stop' as const)
            : null
          : shouldExitAtPrice(price, stats, open.entry, barsHeld, params);
        if (reason) {
          const fill = await broker.sell(symbol, price, reason);
          log(
            `SELL ${symbol} ${fill.qtyBase.toFixed(6)} @ ${fill.price} | ${reason} | ` +
              `P&L ${fill.pnlUsdt!.toFixed(2)} ${currency} | ${broker.summary()}`,
          );
        }
        return;
      }

      if (llmTrader) return; // entries are the LLM's job (llmTradeCycle), not the tick loop's
      if (!control.buyingEnabled) return; // user paused new entries; exits above still ran
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
    mode: llmTrader
      ? `LLM TRADER — ${isLive ? 'LIVE, real money (Bitvavo)' : 'paper'}${lastLlmComment ? ` · "${lastLlmComment}"` : ''}`
      : isLive ? 'LIVE — real money (Bitvavo)' : 'paper trading (live prices)',
    currency,
    buyingEnabled: control.buyingEnabled,
    stopLossEnabled: control.stopLossEnabled,
    stopLossToggleable: llmTrader,
    isLive,
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
    llmLog: llmTrader ? llmLog.slice(-40).reverse() : [],
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

let lastLlmComment = '';

// Persistent journal of every LLM decision cycle — shown on the dashboard.
export interface LlmLogEntry {
  t: string;
  comment?: string;
  error?: string;
  actions: { type: string; symbol: string; reason: string; result: string }[];
}
const LLM_LOG_FILE = join(process.env.STATE_DIR ?? '.', 'llm-log.json');
let llmLog: LlmLogEntry[] = (() => {
  try {
    return existsSync(LLM_LOG_FILE) ? (JSON.parse(readFileSync(LLM_LOG_FILE, 'utf8')) as LlmLogEntry[]) : [];
  } catch {
    return [];
  }
})();

function pushLlmLog(entry: LlmLogEntry): void {
  llmLog.push(entry);
  if (llmLog.length > 300) llmLog = llmLog.slice(-300);
  try {
    mkdirSync(dirname(LLM_LOG_FILE), { recursive: true });
    writeFileSync(LLM_LOG_FILE, JSON.stringify(llmLog));
  } catch (err) {
    log(`WARN: llm-log write failed: ${(err as Error).message}`);
  }
}

/** LLM-trader mode: give the model the full picture, let it decide, execute. */
async function llmTradeCycle(): Promise<void> {
  if (!llmConfigured) return; // no brain connected yet — do nothing, loudly at startup only
  if (!control.buyingEnabled) return;
  if (realizedToday() <= -maxDailyLoss) {
    log(`LLM trader: daily kill switch engaged (-${maxDailyLoss} ${currency} realized) — no decisions until tomorrow`);
    return;
  }

  // Statistical pre-filter does the screening for free; the LLM only judges
  // what is actually actionable. Fewer inputs = far less reasoning spend.
  const minVolPct = params.minVolMultiple * ((params.feePctPerSide * 2) / 100) * 100;
  const canBuy = broker.openPositions.length < maxOpen && broker.balanceUsdt >= positionQuote;
  const candidates = !canBuy
    ? []
    : symbols
        .map((s) => ({ s, z: currentZ(s), p: lastPrice.get(s), stats: statsBySymbol.get(s) }))
        .filter(
          (r) =>
            r.p !== undefined &&
            r.z !== null &&
            r.z <= -1.0 && // a real dip
            r.stats !== undefined &&
            (r.stats.std / r.p) * 100 >= minVolPct && // volatile enough to out-earn the fee
            !broker.position(r.s),
        )
        .sort((a, b) => a.z! - b.z!)
        .slice(0, 8);
  const marketLines = candidates.map(
    (r) => `${r.s}: price ${r.p}, z=${r.z!.toFixed(2)}, vol ${((r.stats!.std / r.p!) * 100).toFixed(2)}%, spread ${spreadPct(r.s)?.toFixed(3) ?? '?'}%`,
  );

  const posLines = broker.openPositions.map((p) => {
    const now = lastPrice.get(p.symbol) ?? p.entry;
    const pnlPct = ((now - p.entry) / p.entry) * 100 - params.feePctPerSide * 2;
    const z = currentZ(p.symbol);
    return `${p.symbol}: entry ${p.entry}, now ${now}, net P&L ${pnlPct.toFixed(2)}%, z now ${z === null ? '?' : z.toFixed(2)}, held ${(barIndexNow() - p.enteredAtBar) * intervalMin}min`;
  });

  // Nothing to decide? Skip the brain call entirely — it costs nothing to hold.
  if (posLines.length === 0 && candidates.length === 0) {
    pushLlmLog({
      t: new Date().toISOString(),
      comment: 'skipped — nothing to decide (no positions, no qualifying dips), no tokens spent',
      actions: [],
    });
    return;
  }

  const prompt =
    `You are an autonomous crypto trader managing a ${isLive ? 'REAL-MONEY' : 'PAPER'} portfolio (quote currency ${currency}).\n` +
    `Cash: ${broker.balanceUsdt.toFixed(2)} ${currency}. Max ${maxOpen} open positions, ${positionQuote} ${currency} per buy. ` +
    `Round-trip trading fee ${(params.feePctPerSide * 2).toFixed(2)}% — a trade must beat that to profit.\n\n` +
    `Open positions:\n${posLines.length ? posLines.join('\n') : '(none)'}\n\n` +
    `Buy candidates (pre-filtered: real dips with enough volatility to out-earn the fee; all other markets are untradeable this cycle):\n${marketLines.length ? marketLines.join('\n') : '(none this cycle — selling/holding are your only options)'}\n\n` +
    `Recent headlines:\n${currentHeadlines().slice(0, 8).map((h) => `- ${h}`).join('\n') || '(none)'}\n\n` +
    (control.stopLossEnabled
      ? `A hard stop-loss at -${params.stopLossPct}% per position fires automatically; everything else is your call.\n`
      : `There is NO automatic stop-loss: you alone are responsible for cutting losses and taking profits. Unmanaged losing positions will keep losing.\n`) +
    `Decide your actions for the next 5 minutes. You may buy, sell, or do nothing. ` +
    `Think briefly — a few sentences of reasoning is enough; do not exhaustively analyze every market. ` +
    `Respond with ONLY a JSON object, no other text:\n` +
    `{"actions":[{"type":"buy","symbol":"XXX-${quote}","reason":"..."} or {"type":"sell","symbol":"...","reason":"..."}],"comment":"one line on your thinking"}`;

  const logEntry: LlmLogEntry = { t: new Date().toISOString(), actions: [] };

  let answer: string;
  try {
    // Reasoning models can legitimately take minutes; the cycle is 5 min,
    // so allow up to 3 before declaring the brain unreachable.
    answer = await askLlm(prompt, Number(process.env.LLM_DECIDE_TIMEOUT_MS ?? 180_000));
  } catch (err) {
    log(`LLM trader: brain unreachable (${(err as Error).message}) — holding`);
    logEntry.error = `brain unreachable: ${(err as Error).message}`;
    pushLlmLog(logEntry);
    return;
  }

  let decision: { actions?: { type?: string; symbol?: string; reason?: string }[]; comment?: string };
  try {
    // Reasoning models (deepseek-r1 etc.) prepend <think>...</think> — strip it first.
    const cleaned = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    decision = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
  } catch {
    log(`LLM trader: unparseable answer, holding — "${answer.slice(0, 160)}"`);
    logEntry.error = `unparseable answer: "${answer.slice(0, 160)}"`;
    pushLlmLog(logEntry);
    return;
  }

  lastLlmComment = (decision.comment ?? '').slice(0, 200);
  logEntry.comment = lastLlmComment || '(no comment)';
  if (lastLlmComment) log(`LLM trader thinks: ${lastLlmComment}`);

  for (const action of (decision.actions ?? []).slice(0, 5)) {
    const symbol = (action.symbol ?? '').toUpperCase();
    const shortReason = (action.reason ?? 'no reason given').slice(0, 160);
    const reason = `llm: ${shortReason.slice(0, 120)}`;
    const record = (result: string) =>
      logEntry.actions.push({ type: action.type ?? '?', symbol, reason: shortReason, result });
    try {
      if (action.type === 'sell') {
        const pos = broker.position(symbol);
        const price = lastPrice.get(symbol);
        if (!pos || price === undefined) {
          record('skipped — no such position');
          continue;
        }
        const fill = await broker.sell(symbol, price, reason);
        log(`LLM SELL ${symbol} @ ${fill.price} | P&L ${fill.pnlUsdt!.toFixed(2)} ${currency} | ${reason}`);
        record(`sold @ ${fill.price} — P&L ${fill.pnlUsdt!.toFixed(2)} ${currency}`);
      } else if (action.type === 'buy') {
        if (!symbols.includes(symbol) || broker.position(symbol)) {
          record('skipped — unknown symbol or already holding');
          continue;
        }
        if (broker.openPositions.length >= maxOpen || broker.balanceUsdt < positionQuote) {
          record('skipped — position/cash limit');
          continue;
        }
        const price = lastPrice.get(symbol);
        if (price === undefined) {
          record('skipped — no live price');
          continue;
        }
        const pos = await broker.buy(symbol, positionQuote, price, barIndexNow(), reason);
        log(`LLM BUY ${symbol} ${pos.qtyBase.toFixed(6)} @ ${pos.entry} | ${reason}`);
        record(`bought ${pos.qtyBase.toFixed(6)} @ ${pos.entry}`);
      }
    } catch (err) {
      log(`LLM trader: ${action.type} ${symbol} failed: ${(err as Error).message}`);
      record(`failed: ${(err as Error).message}`);
    }
  }
  pushLlmLog(logEntry);
}

async function main(): Promise<void> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket global missing — run via `pnpm crypto:start` (needs --experimental-websocket on Node 20)');
  }

  const topMatch = /^TOP(\d+)$/.exec(symbolsEnv);
  if (symbolsEnv === 'ALL') {
    symbols = await data.topSymbols(100000); // every market, still volume-sorted
    log(`Tracking ALL ${symbols.length} ${useBitvavoData ? quote : 'USDT'} markets — spread/volatility filters keep the tradeable set small`);
  } else if (topMatch) {
    const n = Math.min(Number(topMatch[1]), 50);
    symbols = await data.topSymbols(n);
    log(`Auto-selected top ${symbols.length} ${useBitvavoData ? quote : 'USDT'} pairs by 24h volume`);
  } else {
    symbols = symbolsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (isLive) {
    log('Mode: *** LIVE — REAL MONEY on Bitvavo ***');
    log(`Safety rails: ${positionQuote} EUR/trade, max ${maxOpen} open, kill switch at -${maxDailyLoss} EUR/day`);
    log('Starting in 30 seconds — Ctrl+C now to abort.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await (broker as LiveBroker).loadSpecs(); // per-market amount decimals + price tick
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

  if (llmTrader) {
    log(
      `Mode: LLM TRADER (${isLive ? '*** LIVE — REAL MONEY ***' : 'paper'}) — ` +
        (llmConfigured
          ? `decisions by ${llmBackend} every ${intervalMin} minutes` +
            (control.stopLossEnabled
              ? ` (auto stop-loss ${params.stopLossPct}% on)`
              : ' — FULL CONTROL: no automatic stop-loss, the LLM owns every exit')
          : 'NO BRAIN CONNECTED: set DEEPSEEK_API_KEY (or OLLAMA_URL) to start trading'),
    );
    if (isLive && !control.stopLossEnabled) {
      log('WARNING: automatic stop-loss is OFF while trading REAL MONEY — the LLM is the only thing cutting losses.');
    }
  } else if (!isLive) {
    log('Mode: LOCAL PAPER TRADING (streaming prices, simulated fills, no real money)');
  }

  log(broker.summary());
  log(`Symbols (${symbols.length}): ${symbols.join(', ')} | ${positionQuote} ${currency}/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars, fee ${params.feePctPerSide}%/side`);
  log(`Reaction: tick-level (websocket). Entry trigger z < -${params.zEntry}.`);

  if (!control.buyingEnabled) log('Note: buying is PAUSED (persisted from last session) — toggle it on the dashboard');
  // PORT is what cloud hosts (Railway etc.) inject; DASH_PORT is the local override.
  startDashboard(
    Number(process.env.PORT ?? process.env.DASH_PORT ?? 8787),
    buildDashboardState,
    handleManualTrade,
    setBuying,
    setStopLoss,
    log,
  );

  log(
    `Gates: entry style ${isLive ? entryStyle : 'paper/market'}, max spread ${maxSpreadPct}%, ` +
      `entry gap ${entryGapMin}min, breadth ${Math.round(breadthFrac * 100)}%, ` +
      `regime BTC -${regimePct}%, LLM veto ${llmVetoEnabled ? 'ON' : 'off'}`,
  );
  startNewsRefresh(log);

  await refreshStats();
  await refreshRegime();
  const stream = data.stream(symbols, onTick, log, (symbol: string, bid: number, ask: number) =>
    quotes.set(symbol, { bid, ask }),
  );

  setInterval(() => {
    void refreshStats().then(() => {
      if (llmTrader) void llmTradeCycle();
    });
    void refreshRegime();
  }, intervalMin * 60 * 1000);
  setInterval(heartbeat, heartbeatSeconds * 1000);
  setTimeout(heartbeat, 5_000);

  // Universe sync: for TOP<n>/ALL modes, periodically re-fetch the market list
  // so newly listed coins are picked up without a restart. Every 6h — new
  // listings are rare, and this keeps API load and price-stream churn low.
  const autoUniverse = symbolsEnv === 'ALL' || /^TOP\d+$/.test(symbolsEnv);
  if (autoUniverse) {
    const n = symbolsEnv === 'ALL' ? 100000 : Math.min(Number(/^TOP(\d+)$/.exec(symbolsEnv)![1]), 50);
    setInterval(() => {
      void (async () => {
        try {
          const latest = await data.topSymbols(n);
          const added = latest.filter((s) => !symbols.includes(s));
          if (added.length === 0) return;
          symbols.push(...added);
          stream.subscribe(added); // start receiving their prices now
          await refreshStats(); // compute their z-scores for the next cycle
          log(`Universe sync: added ${added.length} new market(s) — ${added.join(', ')}`);
        } catch (err) {
          log(`WARN: universe sync failed: ${(err as Error).message}`);
        }
      })();
    }, 6 * 60 * 60 * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
