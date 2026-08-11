/**
 * Bybit v5 PUBLIC market data client — no account or keys required.
 * (Order execution is simulated locally by PaperBroker; Bybit's testnet
 * and self-generated live keys are not available to NL/EU accounts.)
 */
const PUBLIC_URL = 'https://api.bybit.com';

export interface Kline {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

async function publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${PUBLIC_URL}${path}?${qs}`);
  if (!res.ok) throw new Error(`Bybit GET ${path}: ${res.status}`);
  const body = (await res.json()) as BybitResponse<T>;
  if (body.retCode !== 0) throw new Error(`Bybit ${path}: ${body.retMsg}`);
  return body.result;
}

/** Fetch 5-minute klines going back `days`, paging through the 1000-bar limit. */
export async function fetchKlines(symbol: string, intervalMin: number, days: number): Promise<Kline[]> {
  const all: Kline[] = [];
  let end = Date.now();
  const startLimit = Date.now() - days * 24 * 3600 * 1000;

  while (end > startLimit) {
    const result = await publicGet<{ list: string[][] }>('/v5/market/kline', {
      category: 'spot',
      symbol,
      interval: String(intervalMin),
      limit: '1000',
      end: String(end),
    });
    const page = result.list; // newest first
    if (page.length === 0) break;
    for (const row of page) {
      all.push({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
      });
    }
    const oldest = page[page.length - 1];
    if (!oldest) break;
    end = Number(oldest[0]) - 1;
  }

  return all
    .filter((k) => k.t >= startLimit)
    .sort((a, b) => a.t - b.t);
}

