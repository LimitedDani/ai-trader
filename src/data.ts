import { config } from './config.js';
import type { Bar } from './alpaca.js';

export const CRYPTO_FEE_PCT = 0.25; // Alpaca crypto taker fee per side (volume tier 0)

export function isCrypto(symbol: string): boolean {
  return symbol.includes('/');
}

/** Crypto bars live on a different endpoint (v1beta3) and trade 24/7. */
export async function fetchDailyCryptoBars(symbol: string, years: number): Promise<Bar[]> {
  const start = new Date(Date.now() - years * 365 * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    symbols: symbol,
    timeframe: '1Day',
    start: start.toISOString(),
    limit: '10000',
  });
  const res = await fetch(`${config.dataUrl}/v1beta3/crypto/us/bars?${params}`, {
    headers: {
      'APCA-API-KEY-ID': config.keyId,
      'APCA-API-SECRET-KEY': config.secretKey,
    },
  });
  if (!res.ok) throw new Error(`crypto bars ${symbol}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { bars: Record<string, Bar[]> | null };
  return data.bars?.[symbol] ?? [];
}

export function fetchBars(symbol: string, years: number): Promise<Bar[]> {
  return isCrypto(symbol) ? fetchDailyCryptoBars(symbol, years) : fetchDailyBars(symbol, years);
}

export async function fetchDailyBars(symbol: string, years: number): Promise<Bar[]> {
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
