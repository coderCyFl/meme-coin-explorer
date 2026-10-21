# Improvements (2026-10-22)

## AI layer (why not raw ticker)
- **今日跟買** uses multi-angle Binance OHLCV (1d + 1h): volume creep, volatility compression, relative strength vs BTC, rotation/lag, calm accumulation, higher-lows structure.
- Primary list **excludes hard 24h pumps**; those go to collapsed **已在升／勿追**.
- Diversified angles (not six green clones). Short one-line tip; score walls collapsed behind 詳情.
- Offline batch: `scripts/make_bn_setup_picks.mjs` → `data/picks.json` batch-003+. Runtime: `computeSetupPicks()` on ↻ 重算.

## UI
- Simple home: 今日跟買 + portfolio strip + collapsed chase list.
- Real coin logos (Binance CDN, jsDelivr / CoinCap fallback, letter avatar). No WhatsApp emoji mascots.
- Coin Mood uses real logos.

## QA gate
Local `node --check`, http.server, headless Chrome asserts ≥6 setup picks ≠ top gainers, logos, buy→portfolio live mark — before push.

## QA batch-003 fixes
- `diversifySetups` / `diversifyPicks`: hard 1-per-angle first pass; soft max 2; removed catch-all `take(() => true, 3)` that refilled same angles.
- Leverage copy unified to code max **50x** (risk tiers still 3 / 10 / 50).
- Confidence column + default `score_parts` wall removed; geek scores only behind obscure expand.
