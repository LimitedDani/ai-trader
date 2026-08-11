/**
 * Minimal Bitvavo API client (EUR spot). Public market data needs no keys;
 * signed calls are used only in live mode.
 * Docs: https://docs.bitvavo.com
 */
import { createHmac } from 'node:crypto';
import type { Kline } from './bybit.js';

const BASE = 'https://api.bitvavo.com/v2';
const WS_URL = 'wss://ws.bitvavo.com/v2/';

async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Bitvavo GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** 5-min candles, oldest first, mapped to the shared Kline shape. */
export async function fetchCandles(market: string, intervalMin: number, limit: number): Promise<Kline[]> {
  type Row = [number, string, string, string, string, string];
  const rows = await publicGet<Row[]>(`/${market}/candles?interval=${intervalMin}m&limit=${Math.min(limit, 1440)}`);
  return rows
    .map((r) => ({ t: r[0], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .sort((a, b) => a.t - b.t);
}

/** Top-N markets by 24h quote volume for the given quote currency (EUR or USDC). */
export async function fetchTopMarkets(n: number, quote = 'EUR'): Promise<string[]> {
  const tickers = await publicGet<{ market: string; volumeQuote?: string; volume?: string; last?: string }[]>('/ticker/24h');
  return tickers
    .filter((t) => t.market.endsWith(`-${quote}`) && !t.market.startsWith('USDC-') && !t.market.startsWith('EUR'))
    .map((t) => ({ market: t.market, vol: Number(t.volumeQuote ?? 0) || Number(t.volume ?? 0) * Number(t.last ?? 0) }))
    .filter((t) => Number.isFinite(t.vol) && t.vol > 0)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, n)
    .map((t) => t.market);
}

/**
 * Stream real-time prices over Bitvavo's public websocket.
 * Subscribes to BOTH channels: `trades` (a message per executed trade —
 * sparse on a small venue) and `ticker` (a message per best-bid/ask change —
 * much denser). Trades give the traded price; between trades, the bid/ask
 * midpoint keeps the price current so stops react to quote moves too.
 */
export function streamTrades(
  markets: string[],
  onPrice: (market: string, price: number) => void,
  onStatus: (msg: string) => void = () => {},
): void {
  function connect(): void {
    const ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          channels: [
            { name: 'trades', markets },
            { name: 'ticker', markets },
          ],
        }),
      );
      onStatus(`Bitvavo websocket connected, subscribed to ${markets.length} markets (trades + ticker)`);
    });
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          event?: string;
          market?: string;
          price?: string;
          lastPrice?: string;
          bestBid?: string;
          bestAsk?: string;
        };
        if (!msg.market) return;
        if (msg.event === 'trade') {
          const price = Number(msg.price);
          if (Number.isFinite(price) && price > 0) onPrice(msg.market, price);
          return;
        }
        if (msg.event === 'ticker') {
          const bid = Number(msg.bestBid);
          const ask = Number(msg.bestAsk);
          const price =
            Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
              ? (bid + ask) / 2
              : Number(msg.lastPrice);
          if (Number.isFinite(price) && price > 0) onPrice(msg.market, price);
        }
      } catch {
        // ignore malformed frames
      }
    });
    const reconnect = () => {
      onStatus('Bitvavo websocket disconnected, reconnecting in 2s');
      setTimeout(connect, 2_000);
    };
    ws.addEventListener('close', reconnect);
    ws.addEventListener('error', () => ws.close());
  }
  connect();
}

interface OrderResponse {
  orderId: string;
  status: string;
  filledAmount: string;
  filledAmountQuote: string;
  feePaid: string;
  feeCurrency: string;
}

export class BitvavoClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    /** Quote currency of the traded markets — fees paid in it are booked. */
    private readonly quote = 'EUR',
  ) {}

  private async signed<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const timestamp = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = createHmac('sha256', this.apiSecret)
      .update(timestamp + method + `/v2${path}` + bodyStr)
      .digest('hex');
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Bitvavo-Access-Key': this.apiKey,
        'Bitvavo-Access-Signature': signature,
        'Bitvavo-Access-Timestamp': timestamp,
        'Bitvavo-Access-Window': '10000',
        'Content-Type': 'application/json',
      },
      body: bodyStr || undefined,
    });
    const json = (await res.json()) as T & { errorCode?: number; error?: string };
    if (!res.ok || json.errorCode !== undefined) {
      throw new Error(`Bitvavo ${method} ${path}: ${json.error ?? res.status}`);
    }
    return json;
  }

  async balance(symbol: string): Promise<number> {
    const rows = await this.signed<{ symbol: string; available: string }[]>('GET', `/balance?symbol=${symbol}`);
    return Number(rows[0]?.available ?? 0);
  }

  // Bitvavo (MiCA) requires an integer identifying which trader/bot placed
  // each order. Any consistent number works for a single-bot account.
  private readonly operatorId = Number(process.env.BITVAVO_OPERATOR_ID ?? 1001);

  /** Market buy spending `quoteAmount` EUR. Returns actual base qty and EUR cost. */
  async marketBuy(market: string, quoteAmount: number): Promise<{ qtyBase: number; costQuote: number; price: number; feeQuote: number }> {
    const order = await this.signed<OrderResponse>('POST', '/order', {
      market,
      side: 'buy',
      orderType: 'market',
      amountQuote: quoteAmount.toFixed(2),
      disableMarketProtection: false,
      operatorId: this.operatorId,
    });
    if (order.status !== 'filled') throw new Error(`${market} buy not filled (status ${order.status})`);
    const qtyBase = Number(order.filledAmount);
    const spent = Number(order.filledAmountQuote);
    const feeQuote = order.feeCurrency === this.quote ? Number(order.feePaid) : 0;
    if (!(qtyBase > 0) || !(spent > 0)) throw new Error(`${market} buy: unexpected fill (${order.filledAmount}/${order.filledAmountQuote})`);
    return { qtyBase, costQuote: spent + feeQuote, price: spent / qtyBase, feeQuote };
  }

  /** Market sell of `qtyBase` (floored to 8 decimals). Returns EUR proceeds after fee. */
  async marketSell(market: string, qtyBase: number): Promise<{ proceedsQuote: number; price: number; qtySold: number; feeQuote: number }> {
    const qty = Math.floor(qtyBase * 1e8) / 1e8;
    if (!(qty > 0)) throw new Error(`${market} sell: qty rounds to zero`);
    const order = await this.signed<OrderResponse>('POST', '/order', {
      market,
      side: 'sell',
      orderType: 'market',
      amount: String(qty),
      disableMarketProtection: false,
      operatorId: this.operatorId,
    });
    if (order.status !== 'filled') throw new Error(`${market} sell not filled (status ${order.status})`);
    const gross = Number(order.filledAmountQuote);
    const qtySold = Number(order.filledAmount);
    const feeQuote = order.feeCurrency === this.quote ? Number(order.feePaid) : 0;
    return { proceedsQuote: gross - feeQuote, price: gross / qtySold, qtySold, feeQuote };
  }
}
