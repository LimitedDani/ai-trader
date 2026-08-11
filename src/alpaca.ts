import { config } from './config.js';

const headers = {
  'APCA-API-KEY-ID': config.keyId,
  'APCA-API-SECRET-KEY': config.secretKey,
  'Content-Type': 'application/json',
};

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export interface Account {
  status: string;
  equity: string;
  cash: string;
  last_equity: string;
}

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  unrealized_pl: string;
  market_value: string;
}

export interface Bar {
  t: string; // timestamp
  c: number; // close
  h: number;
  l: number;
  o: number;
  v: number;
}

export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface Order {
  id: string;
  symbol: string;
  status: string;
  filled_avg_price: string | null;
}

export const alpaca = {
  account: () => request<Account>(config.tradingUrl, '/v2/account'),

  clock: () => request<Clock>(config.tradingUrl, '/v2/clock'),

  positions: () => request<Position[]>(config.tradingUrl, '/v2/positions'),

  openOrders: () => request<Order[]>(config.tradingUrl, '/v2/orders?status=open'),

  bars: async (symbol: string, timeframe: string, limit: number): Promise<Bar[]> => {
    const params = new URLSearchParams({
      timeframe,
      limit: String(limit),
      feed: 'iex', // free data feed
      adjustment: 'raw',
    });
    const data = await request<{ bars: Bar[] | null }>(
      config.dataUrl,
      `/v2/stocks/${symbol}/bars?${params}`,
    );
    return data.bars ?? [];
  },

  /**
   * Buy with a bracket order: take-profit and stop-loss are attached
   * server-side, so exits execute even if this process is down.
   */
  buyBracket: (symbol: string, qty: number, takeProfit: number, stopLoss: number) =>
    request<Order>(config.tradingUrl, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        order_class: 'bracket',
        take_profit: { limit_price: takeProfit.toFixed(2) },
        stop_loss: { stop_price: stopLoss.toFixed(2) },
      }),
    }),
};
