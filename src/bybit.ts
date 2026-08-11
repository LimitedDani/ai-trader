/**
 * Minimal Bybit v5 API client. Public market data needs no keys;
 * trading calls are HMAC-signed and target the TESTNET by default.
 */
import { createHmac } from 'node:crypto';

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

/** Signed trading client — pass testnet keys; base URL defaults to testnet. */
export class BybitTrading {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl = 'https://api-testnet.bybit.com',
  ) {}

  get isTestnet(): boolean {
    return this.baseUrl.includes('testnet');
  }

  private async signed<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown>): Promise<T> {
    const timestamp = String(Date.now());
    const recvWindow = '5000';
    const payload =
      method === 'GET'
        ? new URLSearchParams(params as Record<string, string>).toString()
        : JSON.stringify(params);
    const sign = createHmac('sha256', this.apiSecret)
      .update(timestamp + this.apiKey + recvWindow + payload)
      .digest('hex');

    const url = method === 'GET' ? `${this.baseUrl}${path}?${payload}` : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': sign,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? payload : undefined,
    });
    if (!res.ok) throw new Error(`Bybit ${method} ${path}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as BybitResponse<T>;
    if (body.retCode !== 0) throw new Error(`Bybit ${path}: ${body.retMsg} (${body.retCode})`);
    return body.result;
  }

  balance(): Promise<{ list: { totalEquity: string }[] }> {
    return this.signed('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  }

  marketOrder(symbol: string, side: 'Buy' | 'Sell', qty: string): Promise<{ orderId: string }> {
    return this.signed('POST', '/v5/order/create', {
      category: 'spot',
      symbol,
      side,
      orderType: 'Market',
      qty,
      // For spot market buys Bybit expects qty in quote currency (USDT) by default;
      // marketUnit makes the unit explicit.
      marketUnit: side === 'Buy' ? 'quoteCoin' : 'baseCoin',
    });
  }
}
