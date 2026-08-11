import { alpaca } from './alpaca.js';
import { config, isLive } from './config.js';
import { evaluate } from './strategy.js';

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function tick(): Promise<void> {
  const clock = await alpaca.clock();
  if (!clock.is_open) {
    log(`Market closed. Next open: ${clock.next_open}`);
    return;
  }

  const [account, positions, openOrders] = await Promise.all([
    alpaca.account(),
    alpaca.positions(),
    alpaca.openOrders(),
  ]);

  // Kill switch: stop trading for the day past the daily loss limit.
  const dailyPnl = Number(account.equity) - Number(account.last_equity);
  if (dailyPnl <= -config.maxDailyLossUsd) {
    log(`Daily loss limit hit (${dailyPnl.toFixed(2)} USD). No new entries today.`);
    return;
  }

  log(
    `Equity ${Number(account.equity).toFixed(2)} | day P&L ${dailyPnl.toFixed(2)} | ` +
      `positions ${positions.length}/${config.maxOpenPositions}`,
  );

  if (positions.length >= config.maxOpenPositions) return;

  const held = new Set(positions.map((p) => p.symbol));
  const pending = new Set(openOrders.map((o) => o.symbol));

  for (const symbol of config.symbols) {
    if (held.has(symbol) || pending.has(symbol)) continue;

    let bars;
    try {
      bars = await alpaca.bars(symbol, '5Min', config.slowSma + 5);
    } catch (err) {
      log(`WARN: failed to fetch bars for ${symbol}: ${(err as Error).message}`);
      continue;
    }

    const signal = evaluate(bars, config.fastSma, config.slowSma);
    if (signal !== 'buy') continue;

    const lastBar = bars[bars.length - 1];
    if (!lastBar) continue;
    const price = lastBar.c;
    const qty = Math.floor(config.maxPositionUsd / price);
    if (qty < 1) {
      log(`${symbol}: price ${price} exceeds MAX_POSITION_USD, skipping`);
      continue;
    }

    const takeProfit = price * (1 + config.takeProfitPct / 100);
    const stopLoss = price * (1 - config.stopLossPct / 100);

    try {
      const order = await alpaca.buyBracket(symbol, qty, takeProfit, stopLoss);
      log(
        `BUY ${qty} ${symbol} @ ~${price.toFixed(2)} ` +
          `(TP ${takeProfit.toFixed(2)} / SL ${stopLoss.toFixed(2)}) order ${order.id}`,
      );
    } catch (err) {
      log(`ERROR: order for ${symbol} failed: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const account = await alpaca.account();
  if (account.status !== 'ACTIVE') {
    throw new Error(`Account status is ${account.status}, expected ACTIVE`);
  }

  log(`Connected to ${config.tradingUrl}`);
  log(`Mode: ${isLive ? '*** LIVE — REAL MONEY ***' : 'paper trading'}`);
  log(`Symbols: ${config.symbols.join(', ')} | poll every ${config.pollSeconds}s`);

  if (isLive) {
    log('LIVE mode detected. Starting in 30 seconds — Ctrl+C now to abort.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`ERROR in tick: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
