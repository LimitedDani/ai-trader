/**
 * Live dashboard served by the crypto bot itself over node:http.
 * One HTML page (inline CSS/JS, no dependencies) polling /api/state.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** Constant-time credential check for HTTP Basic Auth. */
function checkBasicAuth(req: IncomingMessage, user: string, password: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const given = createHash('sha256').update(header.slice(6)).digest();
  const expected = createHash('sha256')
    .update(Buffer.from(`${user}:${password}`).toString('base64'))
    .digest();
  return timingSafeEqual(given, expected);
}

function demandAuth(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="ai-trader", charset="UTF-8"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required');
}

export interface DashboardState {
  mode: string;
  currency: string;
  buyingEnabled: boolean;
  gates: {
    regimeBearish: boolean;
    breadthBlocked: boolean;
    triggeredCount: number;
    entryGapActive: boolean;
    llmVeto: boolean;
    entryStyle: string;
    maxSpreadPct: number;
  };
  params: Record<string, number | string>;
  symbols: {
    symbol: string;
    price: number | null;
    z: number | null;
    holding: boolean;
    volPct: number | null;
    volOk: boolean;
    minVolPct: number;
  }[];
  wallet: {
    usdt: number;
    equityNow: number;
    realizedPnl: number;
    openCount: number;
    closedCount: number;
    wins: number;
  };
  positions: {
    symbol: string;
    entry: number;
    current: number | null;
    qtyBase: number;
    unrealizedPnl: number | null;
    holdMinutes: number;
    z: number | null;
    stopPrice: number;
    timeoutMinutes: number;
    overtime: boolean;
    breakevenPrice: number;
  }[];
  fills: unknown[];
  equitySeries: { t: string; v: number }[];
  totalTicks: number;
}

export type TradeAction = { action: 'buy' | 'sell'; symbol: string };
export type TradeResult = { ok: boolean; message: string };

export function startDashboard(
  port: number,
  getState: () => DashboardState,
  onTrade: (t: TradeAction) => TradeResult | Promise<TradeResult>,
  onSetBuying: (enabled: boolean) => void,
  log: (msg: string) => void,
): void {
  // Security model: without DASH_PASSWORD the server binds to localhost only.
  // Setting DASH_PASSWORD enables HTTP Basic Auth AND opens the bind to
  // 0.0.0.0 (needed for Railway/any cloud host, which fronts it with HTTPS).
  const password = process.env.DASH_PASSWORD;
  const user = process.env.DASH_USER ?? 'admin';
  const host = password ? '0.0.0.0' : '127.0.0.1';

  const server = createServer((req, res) => {
    if (password && !checkBasicAuth(req, user, password)) {
      demandAuth(res);
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(getState()));
      return;
    }
    if (req.url === '/api/trade' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        void (async () => {
          let result: TradeResult;
          try {
            const t = JSON.parse(body) as TradeAction;
            if ((t.action !== 'buy' && t.action !== 'sell') || typeof t.symbol !== 'string') {
              result = { ok: false, message: 'invalid request' };
            } else {
              result = await onTrade({ action: t.action, symbol: t.symbol.toUpperCase() });
            }
          } catch (err) {
            result = { ok: false, message: (err as Error).message };
          }
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })();
      });
      return;
    }
    if (req.url === '/api/buying' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const { enabled } = JSON.parse(body) as { enabled: boolean };
          if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
          onSetBuying(enabled);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: enabled ? 'Buying enabled' : 'Buying paused — open positions still exit normally' }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: (err as Error).message }));
        }
      });
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, host, () =>
    log(
      password
        ? `Dashboard: listening on ${host}:${port} (Basic Auth as "${user}")`
        : `Dashboard: http://localhost:${port} (local only — set DASH_PASSWORD to expose it)`,
    ),
  );
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-trader — crypto paper bot</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --good: #006300; --bad: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --page: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --good: #0ca30c; --bad: #d03b3b;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 20px; max-width: 1100px; margin: 0 auto;
  }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 18px; font-weight: 650; }
  .badge {
    font-size: 12px; color: var(--ink-2); border: 1px solid var(--border);
    border-radius: 999px; padding: 2px 10px; background: var(--surface);
  }
  .pulse { color: var(--muted); font-size: 12px; margin-left: auto; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .tile .k { font-size: 12px; color: var(--ink-2); margin-bottom: 4px; }
  .tile .v { font-size: 22px; font-weight: 650; }
  .tile .v small { font-size: 13px; font-weight: 400; color: var(--muted); }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
  h2 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 500; padding: 4px 10px 6px 0; border-bottom: 1px solid var(--grid); }
  td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; }
  th.num { text-align: right; }
  .up { color: var(--good); } .down { color: var(--bad); }
  .zbar { display: inline-block; width: 110px; height: 6px; border-radius: 3px; background: var(--grid); position: relative; vertical-align: middle; margin-left: 8px; }
  .zbar i { position: absolute; top: -3px; width: 2px; height: 12px; background: var(--ink-2); border-radius: 1px; }
  .zbar b { position: absolute; top: 0; left: 25%; width: 1px; height: 6px; background: var(--axis); }
  .hold { font-size: 11px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; color: var(--ink-2); }
  #chartwrap { position: relative; }
  #tooltip {
    position: absolute; pointer-events: none; display: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 12px; color: var(--ink); box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    white-space: nowrap;
  }
  .empty { color: var(--muted); padding: 12px 0; }
  button.trade {
    font: 12px system-ui, sans-serif; padding: 3px 12px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface); color: var(--ink);
    cursor: pointer;
  }
  button.trade:hover { border-color: var(--series-1); color: var(--series-1); }
  button.trade:disabled { opacity: 0.5; cursor: wait; }
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 16px; font-size: 13px; box-shadow: 0 2px 12px rgba(0,0,0,0.18);
  }
  footer { color: var(--muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>ai-trader</h1>
  <span class="badge" id="mode">…</span>
  <span class="badge" id="params">…</span>
  <button class="trade" id="buyToggle" style="display:none"></button>
  <span id="gates"></span>
  <span class="pulse" id="pulse">connecting…</span>
</header>

<div class="tiles" id="tiles"></div>

<section>
  <h2>Live signals</h2>
  <table>
    <thead><tr><th>Symbol</th><th class="num">Price</th><th class="num">z-score</th><th>Distance to entry</th><th class="num">Volatility</th><th></th></tr></thead>
    <tbody id="signals"></tbody>
  </table>
  <div class="empty" style="padding-top:8px" id="signalsNote"></div>
</section>

<section>
  <h2>Open positions</h2>
  <div id="positions"></div>
</section>

<section>
  <h2 id="eqTitle">Equity</h2>
  <div id="chartwrap">
    <svg id="chart" width="100%" height="220" role="img" aria-label="Equity over time"></svg>
    <div id="tooltip"></div>
  </div>
</section>

<section>
  <h2>Trade history</h2>
  <div id="fills"></div>
</section>

<footer>Local paper trading — live Bybit prices, simulated fills. Updates every 2s.</footer>
<div id="toast"></div>

<script>
const fmt = (n, d = 2) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function trade(action, symbol, btn) {
  const live = document.getElementById('mode').textContent.startsWith('LIVE');
  if (!confirm(action.toUpperCase() + ' ' + symbol + (live ? ' — REAL MONEY?' : ' (paper)?'))) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/trade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, symbol }),
    });
    toast((await res.json()).message);
  } catch { toast('request failed — is the bot running?'); }
  refresh();
}
// Adaptive decimals so sub-dollar coins show real movement (0.3196, not 0.32).
const px = (n) => n == null ? '—' : fmt(n, n >= 100 ? 2 : n >= 1 ? 4 : 6);
const pnlCell = (v, suffix = '') => {
  if (v == null) return '—';
  const cls = v >= 0 ? 'up' : 'down';
  const arrow = v >= 0 ? '▲' : '▼';
  return '<span class="' + cls + '">' + arrow + ' ' + fmt(Math.abs(v)) + suffix + '</span>';
};

let lastTicks = null, lastTime = null, cur = 'USDT';

async function refresh() {
  let s;
  try {
    s = await (await fetch('/api/state')).json();
    document.getElementById('pulse').textContent = 'live · ' + new Date().toLocaleTimeString();
  } catch {
    document.getElementById('pulse').textContent = 'bot unreachable — is it running?';
    return;
  }

  cur = s.currency || 'USDT';
  const modeEl = document.getElementById('mode');
  modeEl.textContent = s.mode;
  modeEl.style.color = s.mode.startsWith('LIVE') ? 'var(--bad)' : '';
  modeEl.style.borderColor = s.mode.startsWith('LIVE') ? 'var(--bad)' : '';
  document.getElementById('eqTitle').textContent = 'Equity (mark-to-market, ' + cur + ')';

  const tgl = document.getElementById('buyToggle');
  tgl.style.display = '';
  tgl.dataset.enabled = s.buyingEnabled ? '1' : '';
  tgl.textContent = s.buyingEnabled ? '⏸ Pause buying' : '▶ Resume buying';
  tgl.style.color = s.buyingEnabled ? '' : 'var(--bad)';
  tgl.style.borderColor = s.buyingEnabled ? '' : 'var(--bad)';

  const g = s.gates || {};
  const badges = [];
  if (g.regimeBearish) badges.push('<span class="badge" style="color:var(--bad);border-color:var(--bad)">⛔ regime: BTC bearish</span>');
  if (g.breadthBlocked) badges.push('<span class="badge" style="color:var(--bad);border-color:var(--bad)">⛔ market-wide dip (' + g.triggeredCount + ' triggered)</span>');
  if (g.entryGapActive) badges.push('<span class="badge">⏲ entry spacing</span>');
  badges.push('<span class="badge">entries: ' + g.entryStyle + '</span>');
  if (g.llmVeto) badges.push('<span class="badge">🧠 LLM veto on</span>');
  document.getElementById('gates').innerHTML = badges.join(' ');
  document.getElementById('params').textContent =
    'z<-' + s.params.zEntry + ' · SL ' + s.params.stopLossPct + '% · fee ' + s.params.feePctPerSide + '%/side';

  let tickRate = '—';
  const now = Date.now();
  if (lastTicks != null && now > lastTime) {
    tickRate = fmt((s.totalTicks - lastTicks) / ((now - lastTime) / 1000), 0) + '/s';
  }
  lastTicks = s.totalTicks; lastTime = now;

  const w = s.wallet;
  const winRate = w.closedCount ? Math.round(100 * w.wins / w.closedCount) + '%' : '—';
  document.getElementById('tiles').innerHTML = [
    ['Equity now', fmt(w.equityNow) + ' <small>' + cur + '</small>'],
    ['Cash', fmt(w.usdt) + ' <small>' + cur + '</small>'],
    ['Realized P&L', pnlCell(w.realizedPnl, ' ' + cur)],
    ['Closed trades', w.closedCount + ' <small>win ' + winRate + '</small>'],
    ['Open positions', w.openCount + (s.positions.filter(p => p.overtime).length
        ? ' <small>' + s.positions.filter(p => p.overtime).length + ' waiting for profit</small>' : '')],
    ['Ticks evaluated', tickRate],
  ].map(([k, v]) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

  const zEntry = Number(s.params.zEntry);
  document.getElementById('signals').innerHTML = s.symbols.map(row => {
    // Map z from [+2 .. -zEntry-1] onto the bar: marker at trigger sits at 25% from left.
    let bar = '';
    if (row.z != null) {
      const span = 2 + zEntry + 1;
      const frac = Math.min(1, Math.max(0, ( -row.z + 2 ) / span)); // z=+2 → 0, z=-zEntry-1 → 1
      const triggerFrac = (2 + zEntry) / span;
      bar = '<span class="zbar"><b style="left:' + (triggerFrac * 100) + '%"></b><i style="left:' + (frac * 100) + '%"></i></span>';
    }
    const volCell = row.volPct == null ? '—'
      : row.volOk ? fmt(row.volPct) + '%'
      : '<span style="color:var(--muted)">' + fmt(row.volPct) + '% — too calm</span>';
    return '<tr' + (row.volOk === false ? ' style="opacity:0.55"' : '') + '><td>' + row.symbol + '</td><td class="num">' + px(row.price) +
      '</td><td class="num">' + (row.z == null ? '—' : fmt(row.z)) + '</td><td>' + bar + '</td><td class="num">' + volCell + '</td><td>' +
      (row.holding
        ? '<span class="hold">holding</span>'
        : '<button class="trade" onclick="trade(\\'buy\\', \\'' + row.symbol + '\\', this)">Buy</button>') + '</td></tr>';
  }).join('');
  const minVol = s.symbols.find(r => r.minVolPct != null);
  document.getElementById('signalsNote').textContent = minVol
    ? 'A buy needs BOTH: z-score past the trigger AND volatility ≥ ' + fmt(minVol.minVolPct) + '% (so the expected snap-back clears the ' + fmt(Number(s.params.feePctPerSide) * 2) + '% round-trip fee). Dimmed rows are too calm to trade profitably.'
    : '';

  document.getElementById('positions').innerHTML = s.positions.length === 0
    ? '<div class="empty">None — waiting for a signal.</div>'
    : '<table><thead><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Now</th><th class="num">Unrealized P&L</th><th class="num">z now</th><th class="num">Stop</th><th class="num">Held</th><th></th></tr></thead><tbody>' +
      s.positions.map(p =>
        '<tr><td>' + p.symbol + '</td><td class="num">' + fmt(p.qtyBase, 6) + '</td><td class="num">' + px(p.entry) +
        '</td><td class="num">' + px(p.current) + '</td><td class="num">' + pnlCell(p.unrealizedPnl, ' ' + cur) +
        '</td><td class="num">' + (p.z == null ? '—' : fmt(p.z)) +
        '</td><td class="num">' + px(p.stopPrice) +
        '</td><td class="num">' + (p.overtime
          ? p.holdMinutes + 'm — <span style="color:var(--muted)">waiting for ≥ ' + px(p.breakevenPrice) + '</span>'
          : p.holdMinutes + 'm / ' + p.timeoutMinutes + 'm') + '</td>' +
        '<td><button class="trade" onclick="trade(\\'sell\\', \\'' + p.symbol + '\\', this)">Sell</button></td></tr>').join('') + '</tbody></table>' +
      '<div class="empty" style="padding-top:8px">' + (s.mode.startsWith('LLM')
        ? 'Exits are decided by the LLM each cycle' + (s.mode.includes('paper') ? ' — full control: no automatic stop-loss or timer.' : ' — plus the hard stop-loss as disaster brake.')
        : 'Sells when: z rises to ≥ 0 (price back at its mean) · price hits the stop · after the hold timer: only at the first net-profitable price (breakeven hunt) — the stop-loss stays the one losing exit.') + '</div>';

  const sells = s.fills.filter(f => f.side === 'Sell').slice(-50).reverse();
  document.getElementById('fills').innerHTML = sells.length === 0
    ? '<div class="empty">No closed trades yet.</div>'
    : '<table><thead><tr><th>Time</th><th>Symbol</th><th class="num">Exit price</th><th>Reason</th><th class="num">P&L</th></tr></thead><tbody>' +
      sells.map(f =>
        '<tr><td>' + new Date(f.time).toLocaleString() + '</td><td>' + f.symbol + '</td><td class="num">' + fmt(f.price) +
        '</td><td>' + (f.reason || '') + '</td><td class="num">' + pnlCell(f.pnlUsdt, ' ' + cur) + '</td></tr>').join('') +
      '</tbody></table>';

  drawChart(s.equitySeries);
}

let chartPoints = [];
function drawChart(series) {
  const svg = document.getElementById('chart');
  const W = svg.clientWidth, H = 220, padL = 56, padR = 12, padT = 12, padB = 24;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  if (!series || series.length < 2) {
    svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--muted)" font-size="13">Equity chart appears after the first closed trade.</text>';
    chartPoints = [];
    return;
  }
  const ts = series.map(p => new Date(p.t).getTime());
  const vs = series.map(p => p.v);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  let vMin = Math.min(...vs), vMax = Math.max(...vs);
  const padV = Math.max((vMax - vMin) * 0.1, 1);
  vMin -= padV; vMax += padV;
  const x = t => padL + (t - tMin) / (tMax - tMin || 1) * (W - padL - padR);
  const y = v => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);

  let g = '';
  const gridN = 4;
  // Axis decimals adapt to the visible range — a €1 span needs cents,
  // otherwise adjacent labels round to the same number.
  const span = vMax - vMin;
  const axDec = span < 2 ? 2 : span < 20 ? 1 : 0;
  for (let i = 0; i <= gridN; i++) {
    const v = vMin + (vMax - vMin) * i / gridN;
    g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--grid)" stroke-width="1"/>' +
         '<text x="' + (padL - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" fill="var(--muted)" font-size="11">' + fmt(v, axDec) + '</text>';
  }
  const path = series.map((p, i) => (i ? 'L' : 'M') + x(new Date(p.t).getTime()).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  g += '<path d="' + path + '" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>';
  const first = series[0], last = series[series.length - 1];
  g += '<text x="' + padL + '" y="' + (H - 6) + '" fill="var(--muted)" font-size="11">' + new Date(first.t).toLocaleString() + '</text>';
  g += '<text x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end" fill="var(--muted)" font-size="11">now</text>';
  g += '<circle id="hoverdot" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" style="display:none"/>';
  svg.innerHTML = g;
  chartPoints = series.map(p => ({ px: x(new Date(p.t).getTime()), py: y(p.v), t: p.t, v: p.v }));
}

const wrap = document.getElementById('chartwrap');
wrap.addEventListener('mousemove', e => {
  if (chartPoints.length === 0) return;
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  let best = chartPoints[0];
  for (const p of chartPoints) if (Math.abs(p.px - mx) < Math.abs(best.px - mx)) best = p;
  const dot = document.getElementById('hoverdot');
  if (dot) { dot.style.display = ''; dot.setAttribute('cx', best.px); dot.setAttribute('cy', best.py); }
  const tip = document.getElementById('tooltip');
  tip.style.display = 'block';
  tip.style.left = Math.min(best.px + 12, rect.width - 170) + 'px';
  tip.style.top = (best.py - 36) + 'px';
  tip.innerHTML = '<strong>' + fmt(best.v) + ' ' + cur + '</strong><br>' + new Date(best.t).toLocaleString();
});
wrap.addEventListener('mouseleave', () => {
  document.getElementById('tooltip').style.display = 'none';
  const dot = document.getElementById('hoverdot');
  if (dot) dot.style.display = 'none';
});

document.getElementById('buyToggle').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const enable = !btn.dataset.enabled;
  btn.disabled = true;
  try {
    const res = await fetch('/api/buying', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enable }),
    });
    toast((await res.json()).message);
  } catch { toast('request failed — is the bot running?'); }
  btn.disabled = false;
  refresh();
});

refresh();
setInterval(refresh, 2000);
window.addEventListener('resize', () => refresh());
</script>
</body>
</html>`;
