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
const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
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

export function startNewsRefresh(log: (msg: string) => void): void {
  if (!llmVetoEnabled) return;
  void refreshNews(log);
  setInterval(() => void refreshNews(log), NEWS_REFRESH_MS);
  log(`LLM news veto ENABLED (${OLLAMA_URL}, model ${MODEL}) — veto-only, fail-open`);
}

/** Ask the local LLM whether breaking negative news should block buying `coin`. */
export async function newsVeto(coin: string, log: (msg: string) => void): Promise<boolean> {
  if (!llmVetoEnabled || headlines.length === 0) return false;

  const cached = verdicts.get(coin);
  if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.veto;

  try {
    const prompt =
      `Recent crypto news headlines:\n${headlines.map((h) => `- ${h}`).join('\n')}\n\n` +
      `Question: do any of these headlines report BREAKING NEGATIVE news specifically about ` +
      `${coin} (hack, exploit, lawsuit, delisting, insolvency, depeg)? ` +
      `General market moves do not count. Answer with exactly YES or NO, then one short sentence.`;
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const answer = ((await res.json()) as { response?: string }).response ?? '';
    const veto = /^\s*YES/i.test(answer);
    verdicts.set(coin, { veto, at: Date.now(), note: answer.slice(0, 120) });
    if (veto) log(`LLM veto: blocking ${coin} buys — ${answer.slice(0, 120)}`);
    return veto;
  } catch {
    return false; // fail-open by design
  }
}
