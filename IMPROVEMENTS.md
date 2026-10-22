## 2026-10-23 — three.js coin (not CSS orb)
- Replaced CSS `.coin-orb` with `coin3d.js`: procedural `CylinderGeometry` coin, logo textures both faces, gentle Y spin.
- Mounted on Coin Mood hero + trade sheet; CDN ESM (`three@0.160.1` jsDelivr → unpkg fallback); 2D logo fallback if WebGL/CDN fails.
- `prefers-reduced-motion` / offscreen / hidden tab → pause spin; dispose WebGL on trade dialog close.
- Old CSS spin removed so we never double-render.

# Improvements (2026-10-22)


## 2026-10-22 ~23:00 HKT — SOL bias + 3D orb
- Root cause: UI hard-labeled performance vs **SOL** (scorecard / portfolio / howto) from Solana-era batches; mood hero previously sticky **BNBUSDT** (not market-ranked).
- Fix: prefer **BTC** benchmark for Binance batches; mood hero hour-rotates among liquid non-major movers (session remembers user tap).
- UI: CSS 3D coin orb on Coin Mood hero + trade sheet; `prefers-reduced-motion` stops spin.
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

## QA UX (user-angle) + batch-004
- **Glance PnL**: `#pfGlance` + home `simplePfMini` show 總資產 / 總盈虧$+％ / 現金 / 持倉 at a glance; live green/red; flash on equity tick.
- **Spot vs lev**: buy modal big 「現貨」「槓桿」mode cards + risk note; holdings sections/badges color-coded; lev shows Nx + 爆倉價.
- **Light feedback**: fill toast (ok/lev), portfolio highlight + row pulse after 落倉, subtle card fill-pulse; tick flash kept; not noisy.
- **batch-004**: regenerated via `make_bn_setup_picks.mjs` with 1-per-angle first / max 2 soft (4 unique angles on this run).

## P0 nav + batch labels (QA)
- Bottom/top tabs always route via `goView` (capture click) + sync `show`; close leftover dialogs; toast `pointer-events:none` and sits above nav (nav z-index 80).
- `afterFillUX` no longer yanks user back if they left during fill awaits (`navGen`); highlight cancels if they leave portfolio.
- Full history never shows raw `batch-00x` — uses 「今批」 / date-time labels.

## Daily self-upgrade 2026-10-22 ~09:10 Asia/Shanghai
Priority order for next runs:
1. **Outcomes honesty** — `snapshot_outcomes.py` must price Binance `*USDT` via public REST (`data-api.binance.vision` 24hr ticker); keep DexScreener only for legacy solana batch-001.
2. **Scorecard** — wait for ≥24h on batch-002..004 before any win-rate claims; append-only `outcomes.json`.
3. **News** — refresh with ≤5 X `search_news` when `news.json` >48h; keep `why_it_matters`.
4. **Picks** — `make_bn_setup_picks.mjs` auto-increments `batch-NNN` (no more hardcoded 004 overwrite). Only mint a new batch when setups differ meaningfully.
5. **UX** — no CEX overhaul redo; tiny friction only.

Done this run:
- Fixed `scripts/snapshot_outcomes.py` dual path (Binance + Dex).
- Checklist + `daily-outcomes.yml` comment: Dex meme → Binance public.
- Light `news.json` refresh (X search_news ×3) → `data/raw/news-002/`.
- Batch writer auto-increment; **skipped batch-005** (same morning as 004; would likely clone).

## Hourly update 2026-10-22 ~19:00 Asia/Shanghai
Review: live Pages OK; Binance REST SOL mark live; batch-004 still 6 buy / 3 avoid Binance setups; news snapshot ~10h old (OK); outcomes empty pending ≥24h; no Dex hot list on home/browse; JS `node --check` clean.

Self-growth (docs only — no CEX redo):
- Rewrote README intro / Features / Cost / Live pricing to **Binance-first**; Dex scan documented as full-mode optional only.

## Hourly update 2026-10-22 ~20:00 Asia/Shanghai
Review: live Pages OK; Binance SOL mark live (~$104.6); batch-004 still primary (6 setup / chase); news ~11h (within 48h); outcomes still empty (<24h since batch); no Dex hot list on home/browse; JS clean.

Self-growth (UX copy, no CEX redo):
- 「短線炒家」lens → `#browse` (Binance) instead of Dex `#explore`.
- Howto + disclaimer + explore labels clarify Binance main path vs optional full-mode Dex scan.
- `app.js` header comment aligned with Binance-first.

## Hourly update 2026-10-22 ~21:05 Asia/Shanghai
Review: live Pages 200 (HTML/JS match local `732b405`); Binance SOL mark live (~$104.3); batch-004 still 6 buy / 3 avoid (Binance angles diversified); news ~12h (<48h); outcomes still empty (batch-004 age ~16.2h, <24h); `node --check` clean on app/picks/live; Dex only on full-mode explore + legacy scripts — not home/browse/AI hot path.

Self-growth: **docs only** (last hourly already shipped scalp→browse). No code churn.

**Next priority (do not skip):** after **2026-10-23 ~04:54 Asia/Shanghai** (≥24h on batch-004), run `scripts/snapshot_outcomes.py` via Binance public REST and append to `data/outcomes.json`. Then weekday scorecard can start. Until then: no new batch; news refresh only if >48h.

## Hourly update 2026-10-22 ~22:10 Asia/Shanghai
Review: live Pages 200; HTML/JS md5 match local `8cbbb4f`; Binance SOL mark live (~$105.1); batch-004 still 6 buy / 3 avoid (angles: rotation / compression / higher_lows / mean_reversion + already_up chase); news ~13h (<48h); outcomes still empty (batch-004 age ~17.3h, <24h); `node --check` clean on app/picks/live; Dex only on full-mode explore + legacy scripts — not home/browse/AI hot path.

Self-growth: **docs only** (stable; no bug). No code churn; no new batch.

**Next priority (unchanged):** after **2026-10-23 ~04:54 Asia/Shanghai** (≥24h on batch-004), run `scripts/snapshot_outcomes.py` via Binance public REST and append to `data/outcomes.json`. Until then: no new batch; news refresh only if >48h.

## Hourly update 2026-10-22 ~23:10 Asia/Shanghai
Review: live Pages 200; `live.js` md5 match local `ac3be3d` after Pages deploy; Binance SOL mark live (~$104.4); batch-004 still 6 buy / 3 avoid (TRUMP rotation, TIA/PYTH compression, PEPE/ARB higher_lows, UNI mean_reversion + PEOPLE/W/ENA already_up chase); news ~14h (<48h); outcomes still empty (batch-004 age ~18.2h, <24h); `node --check` clean; `qa_diversify.mjs` PASS; Dex only on full-mode explore + legacy scripts — not home/browse/AI hot path.

Self-growth:
- Confirmed earlier Pass-3 **MEGA soft-skip** (`ac3be3d`) deployed — BTC/ETH/SOL/BNB no longer re-enter 今日跟買 via relaxed Pass 3.
- Checklist: add `node scripts/qa_diversify.mjs` gate for MEGA leak.
- Docs note only otherwise — no CEX redo; no new batch.

**Next priority (unchanged):** after **2026-10-23 ~04:54 Asia/Shanghai** (≥24h on batch-004), run `scripts/snapshot_outcomes.py` via Binance public REST and append to `data/outcomes.json`. Until then: no new batch; news refresh only if >48h.

## 2026-10-23 ~02:10 Asia/Shanghai — 24h 數字報告 + 爆升對照
- Home 最上加 **若跟晒今批買 · 24h** 大字卡：等權假本 $1000、總 %、賺蝕 USDT、勝率、逐幣 +/-；未滿 24h 標 **暫計**，滿 24h 優先用 `outcomes.json` 快照。
- `snapshot_outcomes.py` 仍未到期（batch-004 ~04:54）；已加 BTC 基準欄，到期即跑。
- **爆升對照／前兆** 常顯（唔再摺埋）：24h／7日急升 + 「已急升·勿追」／「前兆有影」／「今批避過」徽章；AI 跟買仍係多角度 setup，唔變升幅榜。
- UI：報告卡 + 卡片即時回報%、CEX 數字層級；three.js 金幣路徑不變。
