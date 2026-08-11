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

const STABLE_PAIRS = new Set([
  'USDCUSDT', 'DAIUSDT', 'TUSDUSDT', 'USDEUSDT', 'FDUSDUSDT', 'EURUSDT', 'USD1USDT', 'PYUSDUSDT',
]);

/** Top-N USDT spot pairs by 24h turnover (stablecoin pairs excluded). */
export async function fetchTopSymbols(n: number): Promise<string[]> {
  const result = await publicGet<{ list: { symbol: string; turnover24h: string }[] }>(
    '/v5/market/tickers',
    { category: 'spot' },
  );
  return result.list
    .filter((t) => t.symbol.endsWith('USDT') && !STABLE_PAIRS.has(t.symbol))
    .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
    .slice(0, n)
    .map((t) => t.symbol);
}

/**
 * Stream real-time last-trade prices over Bybit's public websocket.
 * Requires Node's WebSocket global (run with --experimental-websocket on Node 20).
 * Reconnects automatically; sends the protocol ping every 20s.
 */
export function streamPrices(
  symbols: string[],
  onPrice: (symbol: string, price: number) => void,
  onStatus: (msg: string) => void = () => {},
): void {
  const WS_URL = 'wss://stream.bybit.com/v5/public/spot';

  function connect(): void {
    const ws = new WebSocket(WS_URL);
    let ping: ReturnType<typeof setInterval> | undefined;

    ws.addEventListener('open', () => {
      // Bybit caps subscribe requests at 10 topics each — batch them.
      const topics = symbols.map((s) => `tickers.${s}`);
      for (let i = 0; i < topics.length; i += 10) {
        ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }));
      }
      ping = setInterval(() => ws.send(JSON.stringify({ op: 'ping' })), 20_000);
      onStatus(`websocket connected, subscribed to ${symbols.length} tickers`);
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          topic?: string;
          data?: { symbol?: string; lastPrice?: string };
        };
        const symbol = msg.data?.symbol;
        const price = Number(msg.data?.lastPrice);
        if (msg.topic?.startsWith('tickers.') && symbol && Number.isFinite(price) && price > 0) {
          onPrice(symbol, price);
        }
      } catch {
        // ignore malformed frames
      }
    });

    const reconnect = () => {
      if (ping) clearInterval(ping);
      onStatus('websocket disconnected, reconnecting in 2s');
      setTimeout(connect, 2_000);
    };
    ws.addEventListener('close', reconnect);
    ws.addEventListener('error', () => ws.close());
  }

  connect();
}

