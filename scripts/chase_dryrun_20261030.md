# 🚀 續升買 (chase) dry-run — 2026-10-25 .. 2026-10-29 (Asia/Shanghai)

Branch `chase-calls-20261030` · script `scripts/dryrun_chase.py` · cache `/workspace/chase_cache`
Generated 2026-10-30 ~03:27 HKT.

## Rule evolution (2 attempts max; stop when EW≥0)

### v0 baseline (Strategy BOT original = failed QA gate)
- 24h +10%..+30% · **within 5% of 24h high** · 1h vol ≥ 2x · 1h candle up · qv24 ≥ $1.5M
- Exit: TP +20% (half) / +50% / SL −10% / sell_by 24h

| | n | TP +20% first | SL −10% first | 24h close | W / L | EW per trade | per $100 |
|---|---|---|---|---|---|---|---|
| A seal | 35 | 3 (8.6%) | 11 (31%) | 21 | 9 / 25 (1 flat) | **-2.32%** | **$-2.32** |
| B ladder | 35 | — | — | — | 9 / 25 | -2.55% | $-2.55 |

- Hit rate +20% before −10%: 3/14 resolved (8.6% overall).
- By leg: main n=15 **-4.21%**; 細盤 n=20 **-0.91%**.
- **Verdict v0: FAILS QA gate EW≥0 (EW -2.32%).**

### v1 tighten #1 — fh_min −5% → **−2%** (within ≤2% of 24h high) ✅ passes
Constants: `CHASE_FH_MIN = -2.0` in `gainer_core.py` / `GB_CH_FH = -2` in `live.js` / `fhMin: -2` in setup picks.
Raw: `/workspace/chase-dryrun-20261030-v2.json`

| | n | TP +20% first | SL −10% first | 24h close | W / L | EW per trade | per $100 |
|---|---|---|---|---|---|---|---|
| A seal | 17 | 1 (5.9%) | 1 (5.9%) | 15 | 7 / 9 (1 flat) | **+0.47%** | **$+0.47** |
| B ladder | 17 | — | — | — | 7 / 9 | +0.43% | $+0.43 |
| incl. 2 open (MTM) | 19 | | | | | +0.48% | |

- Hit rate +20% before −10%: 1/2 resolved TP/SL; 1/17 overall (5.9%).
- By leg: main n=8 **-0.71%** (TP=0 SL=1); 細盤 n=9 **+1.51%** (TP=1 SL=0).
- Per day: 10-26 6 · 10-27 6 · 10-28 5.
- Optional slice (NOT adopted — already green without it): c24≥15 n=6 EW +3.49%; c24&lt;15 n=11 EW -1.18%. Keeping c24 +10..+30 so n stays usable.

**Verdict v1: PASSES QA gate EW≥0 (EW +0.47% / trade).** No second tighten needed. Do NOT merge main until @QA Bot APPROVE.

## Method (unchanged)
- Universe: 395 Binance USDT spot; failed=[].
- Signals on CLOSED 1h bars; one entry per symbol per 24h.
- Exits on 5m; stop checked first. A = seal model (single TP+20 / SL−10 / 24h). B = ladder.
- No fees (add ≈ −0.2% round trip).

## Two tracks reminder
🚀 EW is **separate** from early-capture recall. Capture scorecard still only counts flags before top-20 + c24&lt;15.
