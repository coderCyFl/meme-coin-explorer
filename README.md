# Crypto.M · AI 揀幣 · Meme Coin Explorer

**個人 AI 模擬實驗（HK）**：用 AI + X 搵幣 → 你模擬落倉 → 追蹤真實賺蝕。

預設 **「簡單」** 介面（大卡推薦 + Crypto.M 摘要）；可切換 **「完整」**。  
Tabs：🤖 揀幣 · 👀 睇幣 · 🧪 Crypto.M · 📰 新聞 · 🔎 掃描（完整）／⋯ 更多（簡單）。

> 用 AI + X 搵幣 → 模擬落倉 → 睇真實賺蝕。全部係模擬，冇真實金錢。


A static website for a **personal AI paper-trading experiment** on meme / high-beta coins listed on Binance.
**熱幣／睇幣／今日跟買** use **Binance public REST + WebSocket only** (`data-api.binance.vision` / `data-stream.binance.vision`, no key).
Dex meme hot lists are **not** the product path. Plain HTML/CSS/JS, no build step, hosts free on GitHub Pages.

> ⚠️ **Not financial advice.** Meme coins are extremely high risk. Most go to zero, and many are rugs or
> honeypots. DexScreener "boosted" tokens are paid promotions, and X buzz is easy to fake. This site is simulated cash only.

![screenshot](screenshot.png)

Main path: **今日跟買** (multi-angle Binance OHLCV setups, not 24h gainers) → **落倉** into a fake portfolio → live Binance marks.
Tabs: 揀幣 · 睇幣 (Coin Mood / Binance board) · Crypto.M · 新聞 · optional full-mode Dex 掃描 (legacy / research only).

## Features
- **今日跟買**: ≥5–6 diversified Binance setups (volume creep, compression, RS vs BTC, rotation, accumulation, higher-lows). Hard 24h pumps go to collapsed 「已在升／勿追」.
- **👀 睇幣**: Coin Mood hero + Binance USDT board with real logos, L/H, volume — public browse, not Dex boosted.
- **🧪 Crypto.M**: shared fake cash; spot + isolated leverage (tier caps 3x / 10x / 50x); All-in mode; live marks after fill.
- **📰 新聞**: static `data/news.json` snapshot (site never calls X).
- **完整紀錄 / Scorecard**: append-only batches vs SOL; old Dex Solana batches kept for honesty, new batches are Binance.
- **Full-mode 市場掃描**: optional DexScreener table (boosts/search) — not home, not hot list, not AI picks.

## Run locally
```bash
cd meme-coin-explorer
python3 -m http.server 8000
# open http://localhost:8000
```
You need a local server rather than `file://` because the page `fetch()`es `data/x_buzz.json`.

## Cost-saving design
| Piece | Where it runs | Cost |
|---|---|---|
| Hot / browse / AI setups | Browser → Binance public REST (`data-api.binance.vision`) | Free |
| Live marks (paper + board) | Binance public WS (`data-stream.binance.vision`) | Free |
| AI pick batches | Offline `scripts/make_bn_setup_picks.mjs` → `data/picks.json` | Free |
| Outcomes snapshots | `scripts/snapshot_outcomes.py` (Binance 24hr for `*USDT`; Dex only for legacy Solana batch-001) | Free |
| News / X buzz | Pre-computed `data/news.json` / `data/x_buzz.json`. Site never calls X | Only when you refresh |
| Optional Dex scan | Full-mode only → DexScreener public API | Free |
| Hosting | GitHub Pages (static) | Free |

## Live pricing honesty
Product path is **Binance spot USDT** only for 熱幣／睇幣／今日跟買.
- **Binance** REST + WS: primary marks for new picks and the browse board.
- **DexScreener**: legacy open positions / full-mode explorer only — never the hot list or AI primary list. Paused when the tab is hidden (Page Visibility API).


## How the X buzz snapshot works
```
data/tracked.json        which tokens to watch (symbol, name, chain, contract address)
data/raw/search_*.json   raw X search responses (cashtag + general meme-coin searches)
data/raw/counts.json     7-day mention counts per ticker
data/x_buzz.json         ← built from the above; the website loads this
```
**Matching between DexScreener and X** is deliberately strict:
- A post counts toward `$SYM` only if its text contains the cashtag `$SYM` (case-insensitive). A bare word like "kimchi" doesn't count.
- Every tracked entry stores the token's **contract address**. In the table, buzz only shows for the token whose
  chain + address match. Another token with the same ticker shows `≠ ticker` instead of borrowing the buzz.
- When two tracked tokens share a ticker, the entry is marked ⚠️ `ticker_collision`.
- Tickers that are everyday words (KIMCHI, GATO, BINA…) are marked ❔ `common_word`, and their counts use a
  crypto-context query (e.g. `kimchi (solana OR memecoin OR mcap OR pump OR crypto OR coin)`).

### Refreshing (cheap)
1. **Pick tokens** (free, DexScreener only): `python3 scripts/pick_tracked.py 16 40000`
   (top 16 boosted tokens by 24h volume with ≥ $40k liquidity).
2. **Get raw X data**, using either option:
   - **Ask the agent** (Grok Bot) to "refresh x_buzz". It uses its built-in X search tools and writes `data/raw/`.
     Budget is about 10–15 X calls: 1 general search, 2 combined cashtag searches (8 tickers each), and ~10 count calls.
   - **Use your own X API key** (paid per use): `X_BEARER_TOKEN=... python3 scripts/fetch_x_raw.py`
     (~19 calls for 16 tickers; add `--no-counts` to cut it to 3).
3. **Build** (offline, free): `python3 scripts/build_x_buzz.py`
4. Commit `data/` and push. GitHub Pages redeploys automatically.

For a schedule, a GitHub Actions cron (e.g. once or twice a day) can run steps 1, 2 (option B, key stored as a repo
secret) and 3, then commit. Daily is plenty: meme-coin buzz moves fast, but 7-day counts don't need minute-level freshness.

## Files
```
index.html            page layout + disclaimer
styles.css            dark, mobile-friendly UI
app.js                fetching, caching, merging, risk flags, rendering (all untrusted text via textContent)
data/x_buzz.json      X buzz snapshot the site reads
data/tracked.json     tracked tokens (symbol/name/chain/address)
data/raw/             raw X responses used to build the snapshot
scripts/pick_tracked.py   choose tokens from DexScreener (free)
scripts/build_x_buzz.py   raw → x_buzz.json (offline)
scripts/fetch_x_raw.py    optional: raw X data via official API + your key
scripts/make_picks.py     reproducible scoring + append-only pick logging
scripts/snapshot_outcomes.py  append 24h/72h/7d outcome snapshots
picks.js              AI picks scorecard + paper trading
data/picks.json       append-only AI pick log (never edited)
data/outcomes.json    append-only horizon snapshots
data/raw/batch-NNN/   raw inputs + notes behind each batch
```

## 🤖 AI Picks: can X buzz analysis beat the market?
![picks](screenshot-picks.png)

### How picks are made
1. **Fresh data.** DexScreener candidates (boosted and latest tokens with liquidity ≥ $50k) plus a small X refresh, about 13 calls:
   one news search, two cashtag searches, and about 10 hourly `counts/recent` calls (7-day window). Raw responses are saved in `data/raw/batch-NNN/`.
2. **Reproducible score.** `scripts/make_picks.py score data/raw/batch-NNN` prints a 0–100 score per token. Every part is visible in the code (`score_one`):
   | Part | Range | What it measures |
   |---|---|---|
   | buzz_growth | 0–30 | posts in the last 24h vs. the average day before (log2) |
   | buzz_level | 0–15 | log10 of posts in the last 24h |
   | buzz_momentum | −5…+5 | last 6h vs. previous 6h (is buzz still rising?) |
   | engagement | 0–15 | unique authors + likes/reposts per **$CASHTAG** post in the sample |
   | liquidity | 0–20 | $50k → 0, $1M → 20 (log) |
   | market | 0–15 | buy/sell balance, sane volume/liquidity ratio |
   | penalties | − | pair < 24h, −50% day, vol/liq > 50×, already +300% (chasing), liq ≈ mcap, paid boost |
3. **Qualitative read.** The AI reads the actual posts (e.g. copy-paste shill campaigns, bot-generated mentions, scam accusations)
   and writes `notes.json` with a plain-English rationale and an optional conviction adjustment. Picks need liquidity ≥ $50k and
   no hard red flags. "Avoid" calls are logged too.
4. **Commit.** `scripts/make_picks.py commit data/raw/batch-NNN data/raw/batch-NNN/notes.json` fetches **live entry prices** and
   SOL + BTC (WBTC) benchmark prices, then **appends** a batch to `data/picks.json`.

### Honesty rules
- `data/picks.json` is **append-only**. Past picks are never edited or deleted, even when they look bad. Each pick keeps its
  timestamp (with +08:00 offset), chain, token and pair address, entry price, market snapshot, score parts, rationale, X evidence and horizons (24h / 72h / 7d).
- The scorecard computes returns **live in the browser** from the pair's current DexScreener price, next to SOL bought at the same moment.
  A missing pair or liquidity under $1k counts as **−100% (rugged/dead)**. A liquidity drop of more than 80% is flagged.
- `scripts/snapshot_outcomes.py` (run hourly, e.g. via cron or GitHub Actions) appends horizon snapshots to `data/outcomes.json` so 24h/72h/7d returns are frozen
  once reached. `observed_at` shows if a snapshot was late.
- Aggregates: number of picks, win rate, average/median return, best/worst, SOL over the same windows, average excess vs SOL, rugs, and avoid-call accuracy.
- A handful of picks proves nothing. You need dozens of batches before the win rate means anything.

### Adding a new batch (e.g. daily)
```bash
# 1) X refresh (ask Grok Bot: "make a new picks batch", ~13 X calls). It writes data/raw/batch-NNN/{counts_hourly.json,search_*.json,news_*.json,candidates.json}
#    or use scripts/fetch_x_raw.py with your own X API key and save into the batch folder
python3 scripts/make_picks.py score  data/raw/batch-NNN              # look at the scores
$EDITOR data/raw/batch-NNN/notes.json                                # rationale per pick / avoid
python3 scripts/make_picks.py commit data/raw/batch-NNN data/raw/batch-NNN/notes.json
python3 scripts/build_x_buzz.py                                      # refresh the Explorer buzz too
python3 scripts/snapshot_outcomes.py                                 # (hourly) freeze reached horizons
git add data && git commit -m "picks batch NNN" && git push
```

## 🧪 Crypto.M：現貨 + 槓桿
- **現貨**：用現金買，最多蝕晒呢筆本金，1% fee/slippage。
- **槓桿（逐倉模擬）**：2/3/5/10/20/50x（風險檔：穩陣≤3x · 進取≤10x · 極高風險≤50x；預設進取 5x）。保證金從共用現金扣除；名義 = 保證金 × 倍數；開平倉各收名義 1% 費。
  爆倉：浮虧 ≥ 保證金約 90%（爆倉價 ≈ 入場 × (1 − 0.9/倍數)）。爆倉後保證金歸零。v1 未計 funding。
- 「跟晒今批 AI 買入」**只限現貨**。
- localStorage key `mce:paper:v2`（會自動由 v1 migrate）。

## 🧪 Paper trading
![portfolio](screenshot-portfolio.png)

- A fake **$1,000** balance stored only in your browser's `localStorage` (`mce:paper:v1`). There's no account and no server.
- **Paper buy** from any AI pick or from any Explorer row (click a row, then "🧪 Paper buy"). It fills at the live DexScreener price, fetched fresh at trade time.
- **Paper sell** 25/50/100% (or any %) of a position. Dead pairs can be written off at $0.
- Shows holdings, average cost, cost basis, value, unrealized/realized P&L, total equity, and full trade history.
- **🤖 Copy all AI picks equally** splits an amount across the latest batch's buy picks. **Reset** returns you to $1,000.
- **Fee + slippage** assumption is applied on every buy and sell (default **1%**, configurable). Real trades on thin meme pools are usually worse
  (price impact, MEV/sandwiching, failed transactions, transfer taxes). This is **simulated, no real money**.

## Limitations
- The X snapshot only covers ~16 tickers chosen at refresh time. New tokens show `–` until the next refresh.
- Mention counts are keyword counts, and bots/shill campaigns inflate them. High buzz ≠ good coin.
- Risk flags are simple heuristics. They don't detect honeypots, mint/freeze authority, holder concentration, etc.
  Check those with tools like RugCheck (Solana) or Token Sniffer before trusting a token.
- Paper trades apply 1% fee + a rough liquidity impact estimate (shown on confirm). Real pools can still be worse (MEV, failed txs).
- The scorecard's live returns use DexScreener's displayed price. If a pair migrates to a new pool, the old pair may look dead even though the token still trades elsewhere.
- Picks are only as good as a tiny, noisy X sample. Treat the scorecard as an experiment, not a signal.


## Hosting on GitHub Pages + Actions

1. **Settings → Pages → Source: GitHub Actions**
2. Push to `main`（或手動跑 **Deploy GitHub Pages** workflow）
3. URL：`https://<user>.github.io/<repo>/`

| Workflow | 做咩 |
|---|---|
| `.github/workflows/pages.yml` | push 去 main → 部署靜態站 |
| `.github/workflows/daily-outcomes.yml` | 平日 01:00 UTC 跑 `snapshot_outcomes.py`（只 DexScreener），commit outcomes |

唔使 X token。若 commit 失敗，開 Actions write permission。
