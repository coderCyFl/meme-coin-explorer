# AGENTS.md — rules for every bot working on Crypto.M

Read this file first, every time. The role files are in `docs/ai-team/` (PM.md, DEV.md, QA.md, STRATEGY.md).

## What this project is
Crypto.M is a personal **paper-trading** website (no real money) for spotting crypto coins that are
starting to move early. Owner: Cyrus. It is a static site on GitHub Pages using Binance public data only.

## Team and flow
```
Cyrus (owner) ──comments──▶ PM bot ──ticket──▶ Dev bot ──change + notes──▶ QA bot ──report──▶ PM bot ──summary──▶ Cyrus
Strategy bot ──experiment report (backtest on real data)──▶ PM bot ──ticket──▶ Dev / QA as above
```
- Only the PM talks to Cyrus about scope and priorities. Dev and QA talk to the PM.
- One ticket at a time. Small changes. Nothing reaches `main` until QA says PASS and Cyrus says OK.
- Reply to Cyrus in **English and Traditional Chinese (Cantonese written form)**. Keep it short and plain.
- Cyrus prefers **simple over complete**. If a request can be done in a smaller way, propose the smaller way first.

## The product rules (do not break these)
1. **Paper trading only.** Never add real exchange keys, real orders, wallets or payments.
2. **Be honest about the strategy.** Never claim a coin "will" rise. Scores are odds. Every strategy
   change must pass `node tools/backtest.mjs` on the **test half** of real data (≥30 signals, positive average,
   better than random entries) and show before/after numbers. If it doesn't, it doesn't ship.
   Cyrus's goal is +20% a day; always report real daily numbers against that goal, never projections.
3. **Any coin, any time — Buy stays on.** Coins up > 25% in 24h (or > 12% in 1h) are still labelled "Already pumped" with a soft risk note, and quiet coins get a soft note too — but **never hide or disable Buy** by score, stage or risk. Soft notes only.
4. **Demo data must always be labelled.** When Binance can't be reached the app uses a simulated
   market. Any number from it must say "Demo".
5. **Leverage 1x–50x** (`[1,2,3,5,10,20,50]`). Auto TP/SL is **on by default** (stop, two targets, 4h time limit); user can turn auto **off** and then only liquidation or Sell now from Portfolio apply. Liquidation: `liq = entry*(1-0.9/leverage)`; close at `max(price,liq)`; loss incl fees never exceeds margin; balance ≥ 0.
6. **Both languages.** Every new piece of text goes into `js/i18n.js` in English AND 繁中. No hard-coded text in HTML/JS.
7. **Look and feel:** black background `#0B0E11`, Binance yellow `#F0B90B`, green `#0ECB81` up, red `#F6465D` down,
   3D coins with real logos, 3D-rendered icons, and the **3D engineer mascot** (yellow hard hat with M badge, orange
   high-vis vest, wrench) as logo, hero character and empty-state helper (`buildEngineer()` in `js/coin3d.js`).
   Must work on phone (390px), tablet (820px) and desktop (1440px).

## Screens
Radar (3D podium + Early Score list) · **All-in** (what $X becomes if you go all-in on every Early signal, vs 10% stake vs
holding BTC, plus "if you go all-in now") · Markets · Portfolio (paper money, auto exits) · Track record (backtest, daily
results vs the +20% goal, signal log).

## File map
| File | What it does | Who usually edits |
|---|---|---|
| `index.html` | page structure, dialogs | Dev |
| `css/app.css` | all styling; colours are tokens in `:root` | Dev |
| `js/i18n.js` | all text, EN + 繁中 | Dev |
| `js/strategy.js` | Early Score, trade plan, backtest, all-in simulation — pure, no DOM. All tunable numbers in `PARAMS` | Strategy bot (Dev only for wiring) |
| `tools/backtest.mjs` | backtest on real Binance candles, train/test split, PASS/FAIL verdict | Strategy bot |
| `data/strategy/` | saved strategy experiment results | Strategy bot |
| `js/data.js` | Binance REST/WebSocket + demo market | Dev |
| `js/coin3d.js` | three.js coins, podium, 3D thumbnails and icons | Dev |
| `js/app.js` | screens, paper portfolio, accounts | Dev |
| `img/coins/*.png` | bundled coin logos (128px) | Dev |
| `data/` (except `data/strategy/`) | written by GitHub Actions every few minutes | **nobody by hand** |
| `.github/workflows/` | pipelines + Pages deploy | only with Cyrus's OK |
| `legacy/` | old v1 site, reference only | nobody |
| `tests/` | `python3 -m pytest -q tests` | Dev adds, QA runs |

## Coding rules
- Plain HTML/CSS/JS. **No frameworks, no build step, no new libraries** without Cyrus's OK.
  three.js r128 from cdnjs is the only library.
- Keep files small and readable. Change the least code that solves the ticket.
- No secrets, no API keys, no tracking scripts.
- Don't edit `data/` or the workflows unless the ticket says so.

## Known traps (real bugs we already hit — check for them)
- **HTML validation that silently blocks a button.** A `pattern=` or `step=` on an input can stop a form
  from submitting with no message (old login: "Email" box only accepted letters; trade box with `step="10"`).
  Forms use `novalidate` and the JS shows clear errors instead.
- **Re-rendering a list every tick swallows taps on phones.** Live price updates must patch rows in place
  (`paintList`, `data-part`), never replace buttons the user may be pressing.
- **`[data-page]` selector also matched `<body>`** and hid the whole page. Scope selectors (`section[data-page]`).
- **Coin logos and WebGL:** a logo image without CORS can't be used as a 3D texture. `coin3d.js` tries
  bundled logo → Binance logo → CORS proxy → painted symbol. Keep that order.
- **Service worker caching** can show users an old version. `sw.js` caches nothing on purpose.
- **Native `confirm()`/`alert()`** are blocked in some embeds and look bad on phones. Use the in-page `ask()` dialog.
