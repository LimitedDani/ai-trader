/**
 * Single entry point for cloud deployments: the BOT env var picks which
 * bot this service runs, so every Railway service deploys the same repo.
 *
 *   BOT=crypto (default) — crypto bot (TRADE_MODE picks paper/live)
 *   BOT=stock            — Alpaca stock bot
 */
const bot = (process.env.BOT ?? 'crypto').toLowerCase();

if (bot === 'stock') {
  await import('./index.js');
} else if (bot === 'crypto') {
  await import('./cryptoBot.js');
} else {
  throw new Error(`Unknown BOT "${bot}" — use "crypto" or "stock"`);
}
