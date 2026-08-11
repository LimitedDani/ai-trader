/**
 * Fast crypto mean-reversion bot for Bybit spot — TESTNET by default.
 *
 * Runs alongside the Alpaca stock bot; completely independent process.
 * Exits are self-managed (Bybit spot has no bracket orders): the loop
 * checks stop-loss / reversion / timeout every poll and sells at market.
 *
 * Usage: pnpm build && node --env-file=.env dist/cryptoBot.js
 * Requires in .env: BYBIT_API_KEY, BYBIT_API_SECRET (testnet keys from testnet.bybit.com)
 */
import { BybitTrading, fetchKlines } from './bybit.js';
import { DEFAULT_FAST_PARAMS, shouldEnter, shouldExit, type FastParams } from './fastStrategy.js';

const apiKey = process.env.BYBIT_API_KEY;
const apiSecret = process.env.BYBIT_API_SECRET;
if (!apiKey || !apiSecret) {
  throw new Error('Missing BYBIT_API_KEY / BYBIT_API_SECRET in .env (create keys at testnet.bybit.com)');
}

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

const client = new BybitTrading(
  apiKey,
  apiSecret,
  process.env.BYBIT_URL ?? 'https://api-testnet.bybit.com',
);

interface OpenPosition {
  entry: number;
  qtyBase: number;
  enteredAtBar: number; // kline open time of entry bar
}

const positions = new Map<string, OpenPosition>();
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function tickSymbol(symbol: string, barIndexNow: number): Promise<void> {
  // lookback + a few bars, drop the still-forming last bar
  const klines = await fetchKlines(symbol, intervalMin, 1);
  const closed = klines.slice(0, -1);
  const closes = closed.map((k) => k.c);
  if (closes.length < params.lookback + 2) return;

  const price = closes[closes.length - 1]!;
  const open = positions.get(symbol);

  if (open) {
    const barsHeld = barIndexNow - open.enteredAtBar;
    const reason = shouldExit(closes, open.entry, barsHeld, params);
    if (reason) {
      const qty = open.qtyBase.toFixed(6);
      await client.marketOrder(symbol, 'Sell', qty);
      const pnlPct = ((price - open.entry) / open.entry) * 100 - params.feePctPerSide * 2;
      log(`SELL ${symbol} ${qty} @ ~${price} | ${reason} | est P&L ${pnlPct.toFixed(2)}%`);
      positions.delete(symbol);
    }
    return;
  }

  if (positions.size >= maxOpen) return;

  if (shouldEnter(closes, params)) {
    await client.marketOrder(symbol, 'Buy', positionUsdt.toFixed(2));
    const qtyBase = (positionUsdt / price) * (1 - params.feePctPerSide / 100);
    positions.set(symbol, { entry: price, qtyBase, enteredAtBar: barIndexNow });
    log(`BUY ${symbol} ~${qtyBase.toFixed(6)} @ ~${price} (${positionUsdt} USDT), stop ${(price * (1 - params.stopLossPct / 100)).toFixed(2)}`);
  }
}

async function main(): Promise<void> {
  log(`Bybit ${client.isTestnet ? 'TESTNET (fake money)' : '*** LIVE — REAL MONEY ***'}`);
  const balance = await client.balance();
  log(`Wallet equity: ${balance.list[0]?.totalEquity ?? '?'} USDT`);
  log(`Symbols: ${symbols.join(', ')} | ${positionUsdt} USDT/trade, max ${maxOpen} open`);
  log(`Params: z>${params.zEntry}, SL ${params.stopLossPct}%, max hold ${params.maxHoldBars} bars`);

  if (!client.isTestnet) {
    log('LIVE mode detected. Starting in 30 seconds — Ctrl+C now to abort.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  for (;;) {
    const barIndexNow = Math.floor(Date.now() / (intervalMin * 60 * 1000));
    for (const symbol of symbols) {
      try {
        await tickSymbol(symbol, barIndexNow);
      } catch (err) {
        log(`ERROR ${symbol}: ${(err as Error).message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
