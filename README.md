# Crypto.M · v2

Spot coins that are **starting** to move (before the pump), and practise with paper money.
Plain HTML/CSS/JS, no build step, free on GitHub Pages. Binance public data only (no API key).

> Paper trading only. Signals are odds, not promises. Not financial advice.

## What's in the app
| Tab | What it does |
|---|---|
| **Radar** | 3D podium of the top 3 early-signal coins + a list ranked by **Early Score** (0–100) with the reasons ("Volume 3.4×", "Broke 24h high", "Buyers 64%"). |
| **All-in** | What a starting amount becomes if you go all-in on every Early signal (one coin at a time, compounding), compared with 10% per signal and just holding BTC. Max drawdown, every trade, and "if you go all-in now". |
| **Markets** | Every scanned coin, searchable, sort by score / 24h change / volume. |
| **Portfolio** | Paper money per account. Each trade has an automatic plan: sell half at target 1 (stop moves to entry), rest at target 2, stop loss, 4h time limit. Leverage capped at 3x. |
| **Track record** | Backtest of the same rule on the last ~3 days of real candles (vs random entries), plus a log of every signal this device saw, checked 1h and 4h later. |

## The Early Score (js/strategy.js)
15-minute candles, six signals, 100 points:

| Signal | Points | Meaning |
|---|---|---|
| Volume surge | 25 | last 1h volume vs average hour of the prior 24h (full at 3.5×) |
| Early momentum | 20 | 1h change in the early zone (+1% … +5%); fades above +5% |
| Breakout | 15 | price above the prior 24h high |
| Squeeze before | 10 | the 12h before was tight (quiet before the move) |
| Buyers in control | 15 | share of volume from market buys (taker buy ≥ 62%) |
| Beating BTC | 15 | 4h return minus BTC's 4h return (≥ +3%) |

- **≥ 70 → Early signal** (buy allowed) · **50–69 → Building** (buy allowed, your risk) · below 50 → Quiet.
- **Already pumped** (24h > +25% or 1h > +12%) → watch only, no Buy button. The old version's own data showed chasing pumps lost money on average (🔥 tier: −1.3% avg after 4h in its backtest, −5.1% after 24h live).
- Exits come from volatility (ATR): stop ≈ 2 ATR (2.5–6%), target 1 ≈ 3 ATR (4–10%), target 2 ≈ 6 ATR (8–20%), max hold 4h. Fees 0.1% per side.
- Every scan re-runs `Strategy.backtest()` so the app shows whether the rule actually beat random entries recently. If it didn't, the Track record tab says so.

## Improving the strategy
All tunable numbers are in `PARAMS` at the top of `js/strategy.js`. Test changes on real Binance data:
```bash
node tools/backtest.mjs --days 14 --coins 100 --set '{"earlyMin":75}'
```
It prints train / test / all and a PASS/FAIL verdict. See `docs/ai-team/STRATEGY.md`.

## Run locally
```bash
python3 -m http.server 8000     # open http://localhost:8000
# add ?demo=1 to force the simulated market
```
If Binance can't be reached (blocked network, sandboxed preview) the app switches to a clearly labelled **demo market**.

## Files
```
index.html        page structure
css/app.css       light "radar" theme, responsive (phone → tablet → desktop with side panels)
js/i18n.js        English / 繁中 text
js/strategy.js    Early Score, trade plan, backtest (pure functions, also runs in Node)
js/data.js        Binance REST + WebSocket, demo market fallback
js/coin3d.js      three.js coins (lathe-turned body, reeded edge, painted face — no remote logos)
js/app.js         screens, paper trading with auto-exits, local accounts
tools/backtest.mjs   real-data backtest with train/test split (Node 18+)
tools/build_demo.py  bundles everything into one HTML file for sharing a preview
AGENTS.md            rules for the AI bots · docs/ai-team/ role prompts · docs/DEPLOY.md
legacy/           the old v1 front-end, kept for reference (not linked)
```
The GitHub Actions pipelines (gainer board, picks, outcomes) and `data/` are unchanged; v2 doesn't depend on them.

## Accounts
Local to the browser (localStorage). Email or username, case-insensitive, password ≥ 6 chars, salted SHA-256.
Each account has its own paper money. Not real security — don't reuse a real password.
