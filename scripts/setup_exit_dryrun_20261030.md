# Setup-pick exit + ¼ sizing dry-run (2026-10-30, Asia/Shanghai)

Repo `coderCyFl/meme-coin-explorer` · base main `675177f` (stamp 20261030d) · script `scripts/dryrun_setup_exit.py` · raw `setup-exit-dryrun-20261030.json`.

## Method
- Trades: the **same 50 sealed 24h `type:buy` picks** in `data/outcomes.json` (batch-001…010, 10/22–10/28; no 🚀 chase rows exist in seals yet). S0 = as booked: EW −4.34%, 7W/43L.
- Replay: Binance **5m** klines from `created_at` (bars opening ≥ entry), first touch, **same bar both → stop first**, entry = `entry_price_usd`. Time exit: 24h rules use the sealed 1m due-close (`return_pct_eod`); 8h/12h rules use the 5m close of the last bar before the deadline.
- R1 = current rule applied uniformly to all 50 (+8/−5/24h; weak/half batches +5/−4) — the fair apples-to-apples baseline, since 23 early rows (batch-001…004) were booked without any exit fields.
- **Missing klines: 3** (`20261022-001-LARPCHECK`, `-GATO`, `-GLITCH` — Solana Dex, batch-001, no Binance pair). They keep their sealed value in every rule (column no-path*). 47/50 replayed; 47-only numbers in JSON (`bn`). Nothing invented.
- Fees: −0.2% per round trip shown separately (EW −fee / $ −fee).

## 1. Same 50 trades, side by side (gate table)
| rule | n | TP | SL | time | no-path* | W/L | EW/trade | $ on $100×n | EW −fee | $ −fee |
|---|---|---|---|---|---|---|---|---|---|---|
| S0 sealed (as booked) | 50 | 2 | 10 | 38 | 0 | 7/43 | **-4.34%** | -217.20 | -4.54% | -227.20 |
| R1 +8/−5/24h (weak +5/−4) uniform | 50 | 2 | 30 | 15 | 3 | 7/43 | **-3.15%** | -157.27 | -3.35% | -167.27 |
| R2 +10/−4/12h (proposal) | 50 | 0 | 22 | 25 | 3 | 11/39 | **-2.03%** | -101.50 | -2.23% | -111.50 |
| R3 +10/−4/8h [in-sample] | 50 | 0 | 18 | 29 | 3 | 11/39 | **-1.96%** | -98.21 | -2.16% | -108.21 |
| R4 +6/−3/12h [in-sample] | 50 | 0 | 27 | 20 | 3 | 11/39 | **-1.63%** | -81.50 | -1.83% | -91.50 |
| R5 +10/−4/24h [in-sample] | 50 | 0 | 32 | 15 | 3 | 6/44 | **-2.88%** | -144.24 | -3.08% | -154.24 |
| R6 +8/−5/12h [in-sample] | 50 | 0 | 20 | 27 | 3 | 11/39 | **-2.43%** | -121.53 | -2.63% | -131.53 |

R3–R6 are **in-sample** (picked after seeing this data; same 50 trades) — shape only, not a validated rule.

**Paired check R2 vs R1 (same trade):** R2 better on 39/50, worse on 6, same 5; mean +1.12pp/trade, bootstrap 95% CI **+0.73 … +1.53pp**. R2 vs S0 (booked): 39 better / 6 worse, CI +1.68 … +2.96pp.

Shape: almost all of the gain is the **12h time exit** (R5 = +10/−4 but 24h → −2.88%; R6 = +8/−5 at 12h → −2.43%). TP +10 never hit in 12h (0/50); the setups don't run, they bleed — cutting the hold is what helps.

## 2. Last-7d slice (entries ≥ 10/23 04:05, n=27 — batch-005…010, all already had exits)
| rule | n | TP | SL | time | no-path* | W/L | EW/trade | $ on $100×n | EW −fee | $ −fee |
|---|---|---|---|---|---|---|---|---|---|---|
| S0 sealed (as booked) | 27 | 2 | 10 | 15 | 0 | 6/21 | **-1.83%** | -49.38 | -2.03% | -54.78 |
| R1 +8/−5/24h (weak +5/−4) uniform | 27 | 2 | 10 | 15 | 0 | 6/21 | **-1.83%** | -49.38 | -2.03% | -54.78 |
| R2 +10/−4/12h (proposal) | 27 | 0 | 3 | 24 | 0 | 10/17 | **-0.54%** | -14.53 | -0.74% | -19.93 |
| R3 +10/−4/8h [in-sample] | 27 | 0 | 2 | 25 | 0 | 10/17 | **-0.60%** | -16.07 | -0.80% | -21.47 |
| R4 +6/−3/12h [in-sample] | 27 | 0 | 7 | 20 | 0 | 10/17 | **-0.50%** | -13.61 | -0.70% | -19.01 |
| R5 +10/−4/24h [in-sample] | 27 | 0 | 12 | 15 | 0 | 5/22 | **-2.09%** | -56.35 | -2.29% | -61.75 |
| R6 +8/−5/12h [in-sample] | 27 | 0 | 3 | 24 | 0 | 10/17 | **-0.65%** | -17.53 | -0.85% | -22.93 |

R1 last-7d == S0 last-7d exactly (−1.83%, 6W/21L) → the replay reproduces the sealed exit-aware path; good audit.

## 3. Per setup (EW/trade, W/L)

| setup | n | S0 | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|---|---|
| accumulation | 5 | -2.22% (1/4) | -2.22% (1/4) | -0.90% (2/3) | -1.26% (0/5) | -0.70% (2/3) | -1.82% (1/4) | -1.10% (2/3) |
| compression | 13 | -4.31% (3/10) | -2.52% (3/10) | -1.61% (4/9) | -1.81% (4/9) | -1.23% (4/9) | -2.44% (3/10) | -1.99% (4/9) |
| higher_lows | 6 | -5.56% (0/6) | -3.90% (0/6) | -2.43% (1/5) | -2.48% (1/5) | -1.76% (1/5) | -3.23% (0/6) | -3.10% (1/5) |
| legacy(no angle) | 11 | -6.01% (1/10) | -4.35% (1/10) | -3.54% (1/10) | -3.19% (1/10) | -2.90% (1/10) | -3.63% (1/10) | -4.00% (1/10) |
| mean_reversion | 7 | -2.18% (2/5) | -1.75% (2/5) | -1.14% (2/5) | -0.63% (3/4) | -0.71% (2/5) | -2.47% (1/6) | -1.57% (2/5) |
| relative | 1 | -2.21% (0/1) | -2.21% (0/1) | +0.23% (1/0) | +1.13% (1/0) | +0.23% (1/0) | -2.21% (0/1) | +0.23% (1/0) |
| rotation | 7 | -4.75% (0/7) | -3.95% (0/7) | -2.11% (0/7) | -2.15% (1/6) | -2.12% (0/7) | -3.53% (0/7) | -2.40% (0/7) |

Every setup still negative under R2 except `relative` (n=1). rotation 0W/7L under every rule.

## 4. ¼ sizing — separate $ table (NOT a gate pass; sizing does not change EW)
Gate: at each entry, average sealed return of trades already exited in the prior 7d; >0 → full ($100), else ¼ ($25). With these trades the rolling 7d EW was **never** positive, so all 50 trades are ¼ under every rule.

| rule | full $100/trade | full −fee | ¼ gate | ¼ −fee | trades at full | capital deployed full / ¼ |
|---|---|---|---|---|---|---|
| S0 sealed (as booked) | -217.20 | -227.20 | -54.30 | -56.80 | 0/50 | $5000 / $1250 |
| R1 +8/−5/24h (weak +5/−4) uniform | -157.27 | -167.27 | -39.32 | -41.82 | 0/50 | $5000 / $1250 |
| R2 +10/−4/12h (proposal) | -101.50 | -111.50 | -25.37 | -27.87 | 0/50 | $5000 / $1250 |
| R3 +10/−4/8h [in-sample] | -98.21 | -108.21 | -24.55 | -27.05 | 0/50 | $5000 / $1250 |
| R4 +6/−3/12h [in-sample] | -81.50 | -91.50 | -20.37 | -22.87 | 0/50 | $5000 / $1250 |
| R5 +10/−4/24h [in-sample] | -144.24 | -154.24 | -36.06 | -38.56 | 0/50 | $5000 / $1250 |
| R6 +8/−5/12h [in-sample] | -121.53 | -131.53 | -30.38 | -32.88 | 0/50 | $5000 / $1250 |

¼ just scales the loss by 0.25 (−$101.50 → −$25.37 on R2). Live check today: `setupSizeGate` on current outcomes → rolling 7d EW **−1.83% (n=27) → ¼**.
🚀 chase: untouched — own exit +20 half / +50 clear / −10 / 24h, full size (and 細盤 1.5×).

## Gate verdict
- QA gate: new exit EW ≥ 0 **or clearly better than −4.34%**. R2 = **−2.03%** (−2.23% after fees): **not ≥0**, but clearly better — +2.31pp vs booked, +1.12pp vs the same rule-set replayed (R1 −3.15%), paired CI excludes 0, 39/50 trades better, last-7d −1.83 → −0.54%.
- → Meets the "clearly better" leg only. Book is still losing money; ¼ sizing stays on (gate auto-closes ¼ until 7d EW > 0).
- Recommendation: ship **R2 +10/−4/12h as proposed** (trial). Do **not** pick R4 (+6/−3/12h, −1.63%) — it is in-sample and only 0.4pp better; revisit after ≥20 live seals on R2. Since TP never hits in 12h, Strategy may want to look at entry quality (setups) next; exits can't make these picks positive.

## Branch `setup-exit-20261030` (stamp 20261030e, NOT merged)
- `scripts/make_bn_setup_picks.mjs`: `SETUP_EXIT={tp:10,sl:4,reviewH:6,sellH:12}` for normal+weak setup picks (weak keeps half), `exit_rule:"setup_20261030e"`, `setupSizeGate()` → batch `setup_size_gate` + entry `size:"quarter"`/flag `size:quarter` + exit_plan suffix「¼注（近 7d 跟買未轉正）」; fail-safe ¼ if outcomes unreadable. Chase entries unchanged.
- `scripts/snapshot_outcomes.py`: for entries with `exit_rule=setup_20261030e` only, when 5m path had no touch and `sell_by` < horizon, seal at the **sell_by 1m close** (`exit_method: sell_by_1m`). Older seals / chase untouched. Spot-checked SUI/AAVE batch-010 with 12h sell_by: −1.50/−2.22 vs dry-run −1.51/−2.11.
- `picks.js`: `SETUP_EXIT` defaults for live 今日跟買 cards / hot list / fresh buy lock (localStorage meta key → v2 so today's cards pick it up), `setupQuarterNow()` (batch gate, else same rule client-side from outcomes), ¼ line on cards, ¼ in 每日新留意 meta, buy dialog default amount ×0.25 via `sizeMult`. 🚀/🔥 CHASE_EXIT / GAINER_EXIT untouched. No helmet copy; buttons unchanged (#F0B90B, black text).
- `styles.css` `.size-pill.quarter`; `index.html`/`site.webmanifest` ?v=20261030e.
- Smoke (headless Chrome, CDP): no page exceptions; 4/4 cards show「注碼 ¼」; ENA card target/stop = +10%/−4%, 揸到 = now+6h; meta「batch-011 … ¼注（近 7d 跟買未轉正）」. Existing batch-011 (weak +5/−4, locked) still shows its own locked exits — new rule applies from the next batch.
- Paper stays open (no open-block).
