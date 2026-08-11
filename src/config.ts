function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Env var ${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export const config = {
  keyId: required('ALPACA_KEY_ID'),
  secretKey: required('ALPACA_SECRET_KEY'),
  tradingUrl: process.env.ALPACA_TRADING_URL ?? 'https://paper-api.alpaca.markets',
  dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
  symbols: (process.env.SYMBOLS ?? 'SPY')
    .split(',')
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean),
  // Crypto pairs like BTC/USD — backtest/sweep only for now; the live loop trades stocks.
  cryptoSymbols: (process.env.CRYPTO_SYMBOLS ?? 'BTC/USD,ETH/USD')
    .split(',')
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean),
  fastSma: num('FAST_SMA', 9),
  slowSma: num('SLOW_SMA', 21),
  takeProfitPct: num('TAKE_PROFIT_PCT', 1.5),
  stopLossPct: num('STOP_LOSS_PCT', 1.0),
  maxPositionUsd: num('MAX_POSITION_USD', 1000),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
  maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 100),
  pollSeconds: num('POLL_SECONDS', 60),
} as const;

export const isLive = !config.tradingUrl.includes('paper');

if (config.fastSma >= config.slowSma) {
  throw new Error('FAST_SMA must be smaller than SLOW_SMA');
}
