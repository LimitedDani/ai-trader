/**
 * Optional LLM news veto. When OLLAMA_URL is set (e.g. http://localhost:11434
 * with Ollama running), recent crypto headlines are cached and, before each
 * automatic entry, a local LLM is asked one narrow question: is there breaking
 * NEGATIVE news about this specific coin?
 *
 * Design rules:
 *  - VETO-ONLY: the LLM can block a buy, never create one.
 *  - FAIL-OPEN: any error/timeout means "no veto" — a dead LLM must not
 *    silently stop the strategy.
 *  - Never in the tick loop's hot path: verdicts are cached per coin.
 */
const OLLAMA_URL = process.env.OLLAMA_URL;
const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 20_000);
// "user:password" for tunnels that require Basic Auth (e.g. ngrok --basic-auth).
// REQUIRED when tunneling: Ollama itself has no auth — never expose it bare.
const OLLAMA_AUTH = process.env.OLLAMA_AUTH;

function ollamaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (OLLAMA_AUTH) headers.Authorization = `Basic ${Buffer.from(OLLAMA_AUTH).toString('base64')}`;
  return fetch(`${OLLAMA_URL}${path}`, { ...init, headers });
}
const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
];
const VERDICT_TTL_MS = 10 * 60 * 1000;
const NEWS_REFRESH_MS = 5 * 60 * 1000;

export const llmVetoEnabled = Boolean(OLLAMA_URL);

let headlines: string[] = [];
const verdicts = new Map<string, { veto: boolean; at: number; note: string }>();

async function refreshNews(log: (msg: string) => void): Promise<void> {
  const collected: string[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)]
        .map((m) => m[1]!.trim())
        .filter((t) => t.length > 15); // drop channel names
      collected.push(...titles.slice(0, 20));
    } catch (err) {
      log(`LLM veto: news feed failed (${(err as Error).message}) — continuing with what we have`);
    }
  }
  if (collected.length > 0) headlines = collected.slice(0, 40);
}

/** Pull the model if the Ollama server doesn't have it yet, then warm it up. */
async function ensureModel(log: (msg: string) => void): Promise<void> {
  try {
    const tags = await ollamaFetch('/api/tags', { signal: AbortSignal.timeout(10_000) });
    const models = ((await tags.json()) as { models?: { name: string }[] }).models ?? [];
    if (!models.some((m) => m.name === MODEL || m.name.startsWith(`${MODEL}:`))) {
      log(`LLM veto: pulling model ${MODEL} — first start can take several minutes`);
      const pull = await ollamaFetch('/api/pull', {
        method: 'POST',
        body: JSON.stringify({ name: MODEL, stream: false }),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      if (!pull.ok) throw new Error(`pull failed: ${pull.status}`);
      log(`LLM veto: model ${MODEL} pulled`);
    }
    // Warm up and keep the model resident so verdicts don't pay load time.
    const t0 = Date.now();
    await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, prompt: 'Reply OK.', stream: false, keep_alive: '24h' }),
      signal: AbortSignal.timeout(120_000),
    });
    log(`LLM veto: model warm (${((Date.now() - t0) / 1000).toFixed(1)}s) — ready`);
  } catch (err) {
    log(`LLM veto: setup problem (${(err as Error).message}) — veto stays fail-open until it recovers`);
  }
}

export function startNewsRefresh(log: (msg: string) => void): void {
  if (!llmVetoEnabled) return;
  void ensureModel(log);
  void refreshNews(log);
  setInterval(() => void refreshNews(log), NEWS_REFRESH_MS);
  log(`LLM news veto ENABLED (${OLLAMA_URL}, model ${MODEL}) — veto-only, fail-open`);
}

/** Ask the local LLM whether breaking negative news should block buying `coin`. */
export async function newsVeto(coin: string, log: (msg: string) => void): Promise<boolean> {
  if (!llmVetoEnabled || headlines.length === 0) return false;

  const cached = verdicts.get(coin);
  if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.veto;

  const t0 = Date.now();
  try {
    const prompt =
      `Recent crypto news headlines:\n${headlines.map((h) => `- ${h}`).join('\n')}\n\n` +
      `Question: do any of these headlines report BREAKING NEGATIVE news specifically about ` +
      `${coin} (hack, exploit, lawsuit, delisting, insolvency, depeg)? ` +
      `General market moves do not count. Answer with exactly YES or NO, then one short sentence.`;
    const res = await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, prompt, stream: false, keep_alive: '24h' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const answer = ((await res.json()) as { response?: string }).response ?? '';
    const veto = /^\s*YES/i.test(answer);
    verdicts.set(coin, { veto, at: Date.now(), note: answer.slice(0, 120) });
    const ms = Date.now() - t0;
    log(`LLM veto: ${coin} → ${veto ? 'BLOCK' : 'clear'} in ${(ms / 1000).toFixed(1)}s${veto ? ` — ${answer.slice(0, 120)}` : ''}`);
    return veto;
  } catch (err) {
    log(`LLM veto: ${coin} check failed after ${((Date.now() - t0) / 1000).toFixed(1)}s (${(err as Error).message}) — fail-open, not blocking`);
    return false; // fail-open by design
  }
}
