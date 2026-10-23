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

## Hourly update 2026-10-23 ~08:10 Asia/Shanghai
Review: live Pages 200, cache-bust `20261023k1` matches local `5f5c14a`; Binance (data-api.binance.vision) SOL live ~$103.5; `node --check` clean on app/picks/live/coin3d; Dex only in full-mode explore copy — not home/browse/AI hot path. batch-002/003/004 24h all sealed (`kline_1m_due`).

Scorecard (batch-004, 24h, equal-weight): 6 buys avg **≈ -8.1%** vs BTC **-4.15%**; 3 avoids avg ≈ -10.7% (avoid list did fall harder, so the avoid call was right, but buys lagged BTC in a risk-off day). batch-002/003 buys also all negative (~-4% to -11%).

Self-growth: **docs only** — no bug, no code churn.

**Next priority (for 9am daily upgrade, not hourly):** add a market-regime gate — when BTC 24h < -2% and breadth weak, 今日跟買 should show 「市況弱·細注／觀望」 and rank by relative strength vs BTC, instead of 6 full-size longs. Generate batch-005 then.

## Daily self-upgrade 2026-10-23 ~09:05 Asia/Shanghai
Review: outcomes — nothing new due (batch-002/003/004 24h sealed earlier; 72h for batch-004 due ~10-25 04:54). News 24h old (<48h) → **0 X calls**. `qa_diversify.mjs` PASS; headless render OK, no app console errors.

Done:
- **Market-regime gate** (batch writer + home): weak if BTC 24h < -2% or <30% of scanned coins green. Writer: weak ⇒ max 4 buys, no relaxed fill (setup ≥ 28 only), ranked by RS vs BTC, `regime` + `size:half` stored on batch. Home: red 「市況弱 · 細注／觀望」 banner under 今日跟買.
- **Bug fix**: volume-creep used the partial UTC-day candle (≈1h of volume at 09:00) → tips said 「成交較 7 日均高 -98%」 and accumulation scores were wrong. Now uses rolling 24h quoteVolume (writer + live.js); tip wording handles 高/低.
- **batch-005** (weak regime, BTC -3.2%, 0/54 green): WLD, ATOM, AAVE, RENDER, half size. No avoid list (nothing pumping).

Next:
1. 72h seals for batch-002..004 when due; still <20 samples → no win-rate claims.
2. Live `computeSetupPicks` should also cap to 4 in weak regime (currently banner only).
3. News refresh tomorrow (will be >48h).

## Hourly review 2026-10-23 ~09:10 Asia/Shanghai
Review: live 200, cache-bust matched main, `node --check` all JS OK, Binance price moving (DOGE 0.0791). Dex only in full-mode explore (not hot/AI lists).
Done: live `computeSetupPicks` now applies the same weak-regime gate as the batch writer (BTC 24h < -2% or <30% green ⇒ max 4, setup ≥ 28, half size, ranked by RS vs BTC) — previously only the banner showed. Cache-bust 20261023n1.
Next: 72h seals when due (~10-25); news refresh tomorrow.

## Hourly review 2026-10-23 ~10:05 Asia/Shanghai
Review: live 200, cache-bust `20261023n1` matches main (in sync with origin); `node --check` all JS OK; Binance live moving (BTC ~$81.3k, 24h -2.57%; DOGE 0.0790). Regime still weak ⇒ gate (max 4, half size) correctly applies. Dex only in full-mode explore code, not hot/browse/AI paths.
Done: docs only — no bug found, no code churn.
Next: 72h seals for batch-002..004 (~10-25); news refresh tomorrow (>48h); watch whether regime flips back to normal (BTC > -2% and ≥30% green) and that live picks expand back to 6.

## Hourly review 2026-10-23 ~11:10 Asia/Shanghai
Review: live 200, cache-bust `20261023n1` matches main; `node --check` all JS OK; Binance live moving (BTC ~$81.9k, 24h -1.18%). BTC no longer < -2%, but breadth only 4/29 liquid USDT pairs green (~14%), so the weak-regime gate is still correctly on (banner already shows both BTC % and breadth %, so the reason is clear). No Dex on the hot/browse/AI paths.
Done: docs only, no bug, no code churn.
Next: watch for breadth ≥30% so picks expand back to 6; 72h seals (~10-25); news refresh tomorrow.

## Hourly review 2026-10-23 ~12:05 Asia/Shanghai
Review: live 200, cache-bust `20261023n1` matches main (no drift vs origin); `node --check` all JS OK; Binance live moving (BTC ~$81.8k, 24h -1.34%; DOGE 0.0796). picks.json has 5 batches. Dex still only in full-mode explore, not hot/browse/AI paths.
Done: docs only, no bug, no code churn (avoid overlap with 9am daily upgrade).
Next: breadth still weak so gate stays on; 72h seals (~10-25); news refresh tomorrow.

## Hourly review 2026-10-23 ~13:05 Asia/Shanghai
Review: live 200, cache-bust `20261023n1` matches main; `node --check` all JS OK; Binance moving via `data-api.binance.vision` (BTC ~$81.7k, 24h -1.39%; DOGE 0.0795). Note: `api.binance.com` returns a restricted-location error from the build box, so server-side scripts should keep using `data-api.binance.vision` as the primary host. No Dex on hot/browse/AI paths.
Done: docs only, no bug, no code churn.
Next: 72h seals (~10-25); news refresh tomorrow; confirm browser fallback host order still prefers a reachable Binance endpoint.

## Hourly review 2026-10-23 ~14:05 Asia/Shanghai
Review: live 200, assets match local (cache-bust `20261023n1`); `node --check` all JS OK; Binance via `data-api.binance.vision` moving (BTC ~$81.8k, 24h **-1.17%**; DOGE ~0.0798). Breadth on a 30-coin liquid sample **10/30 = 33%** green ⇒ weak-regime gate **off** (BTC not < -2% and breadth ≥30%) — live `computeSetupPicks` can expand back to 6 on refresh. batch-005 (weak, 4 half-size) unchanged. News ~29h (<48h). Dex only in full-mode explore. `api.binance.com` still 451 from this box; vision 200.

Self-growth (tiny script fix, not CEX redo):
- `scripts/snapshot_outcomes.py`: put `data-api.binance.vision` **first** in `BN_KLINE_BASES` (was api.binance.com first, contradicting the “prefer vision” comment and failing with 451 here / some CI). Docstring aligned.

Next: 72h seals (~10-25); news refresh when >48h; no new batch from hourly.
