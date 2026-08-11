# ai-trader

Autonomous trading bot for Alpaca (US stocks/ETFs, $0 commission). **Paper trading by default.**

Strategy: SMA crossover entry (fast crosses above slow) → market buy placed as a
**bracket order**, so a take-profit and a stop-loss are attached server-side at
Alpaca. Exits execute even when the bot is offline.

> ⚠️ This is a proof-of-concept for learning, not a production trading system.
> No strategy guarantees profit. The stop-loss exists because "only sell at a
> profit" just converts realized losses into frozen capital.

## Setup

```bash
pnpm install --ignore-scripts
cp .env.example .env
# Fill in your Alpaca PAPER keys in .env (https://app.alpaca.markets)
```

## Run

```bash
pnpm build
pnpm backtest   # sanity-check the strategy on 3 years of daily bars first
pnpm start      # run the bot against your paper account
```

## Risk controls

| Env var | What it does |
| --- | --- |
| `MAX_POSITION_USD` | Max dollars per entry |
| `MAX_OPEN_POSITIONS` | Max simultaneous positions |
| `MAX_DAILY_LOSS_USD` | Kill switch: no new entries after this much daily loss |
| `TAKE_PROFIT_PCT` / `STOP_LOSS_PCT` | Bracket exit levels per trade |

## Going live (don't, until paper results convince you)

1. Run on paper for at least a few weeks across different market conditions.
2. Generate **live** API keys and put them in `.env` yourself.
3. Set `ALPACA_TRADING_URL=https://api.alpaca.markets`.
4. The bot logs a loud warning and waits 30s before its first live tick.

Never commit `.env`. If a key ever leaks (pasted in chat, committed, logged),
rotate it immediately in the Alpaca dashboard.

## Crypto bot on Railway

The crypto bot (`dist/cryptoBot.js`) is deployable to Railway as-is
([railway.json](railway.json) holds the build/start commands).

1. Push this repo to GitHub and create a Railway project from it.
2. Add a **volume** mounted at `/data` (state files must survive redeploys).
3. Set environment variables in the Railway service:

   | Variable | Value |
   | --- | --- |
   | `STATE_DIR` | `/data` |
   | `DASH_PASSWORD` | a long random password — **required**; without it the dashboard only binds to localhost and won't be reachable |
   | `DASH_USER` | optional login name (default `admin`) |
   | `TRADE_MODE` | `paper` or `live` |
   | `BITVAVO_API_KEY` / `BITVAVO_API_SECRET` | only for live mode (trade-only key, no withdrawal permission) |
   | `FAST_*` | strategy overrides as desired |

4. Open the generated `https://<service>.up.railway.app` — the browser shows a
   login popup (HTTP Basic Auth over Railway's TLS).

Security notes: the dashboard has real-money buy/sell buttons in live mode —
treat `DASH_PASSWORD` like a bank password. Basic Auth is only acceptable
because Railway terminates HTTPS. Live keys on a cloud host is a trust
decision; the no-withdrawal permission on the Bitvavo key is the backstop.
