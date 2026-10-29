# X-early + modest prec widen dry-run — 2026-10-25 .. 2026-10-29 (Asia/Shanghai)

Branch `x-early-20261030` · script `scripts/dryrun_x_early.py` · raw `/workspace/x-early-dryrun-20261030.json`
Generated 2026-10-30 ~03:30 HKT.

**Two tracks:** this file is **early-capture recall only**. 🚀 chase EW is on `chase-calls-20261030` (separate). Do NOT mix.

## What changed
1. **Modest prec widen:** `E2_PREC_C1` 1.5 → **1.2** (vr 1.5, c24&lt;15 unchanged). Goal ~+2–5 early flags/day, not FP explode.
2. **X 熱度早標:** when `x_buzz` flips 熱/升溫 AND 24h &lt;+15% AND not top-20 AND 1h vol ≥1.5x → emit ⚡ `via=x_buzz` (can coexist with prec). Keep 🚩 shill. X stays hourly (targets now include near-early cands, not only 🔥).
3. Every early/🔥 card carries `exit_plan` (+20 / +50 / −10).
4. Capture scorecard definition **unchanged** (early = before top20 + c24&lt;15).

## Dry-run (sealed top-20, full 15m scan; EARLY = c24&lt;15 at first fire)

| rule | recall | caught/n | notes |
|---|---|---|---|
| prior e2∪prec_e (1.5/1.5/15) | **36.0%** | 36/100 | precursor branch baseline |
| **e2 widened (1.2/1.5/15)** | **37.0%** | 37/100 | +1.0pp vs prior |
| **X alone** (mined history 熱/升溫) | **1.0%** | 1/100 | only HYPE 10-29 passed x_early_ok |
| **e2∪X** | **38.0%** | 38/100 | X incremental **+1.0pp** |

Per day (union): 2026-10-25 25.0% · 2026-10-26 40.0% · 2026-10-27 50.0% · 2026-10-28 25.0% · 2026-10-29 50.0%

### X history caveat (honest)
Mined git `x_buzz.json` history: 67 checks, 21 熱/升溫 — mostly **post-🔥** (old targets). So X-alone dry understates what prospective early-candidate X targeting can do once live. No synthetic buzz invented.

## Live scorecard (SAME days — report separately, do not mix with dry)

| day | live recall | live precision | early hits / flagged |
|---|---|---|---|
| 2026-10-25 | 0.0% | 0.0% | 0/4 |
| 2026-10-26 | 0.0% | 0.0% | 0/6 |
| 2026-10-27 | 5.0% | 20.0% | 1/5 |
| 2026-10-28 | 0.0% | 0.0% | 0/6 |
| 2026-10-29 | 10.0% | 20.0% | 2/10 |

**Live avg recall ~3.0%** — far below dry because Actions had not yet dense-scanned + new legs.

## Gates
- Dry union recall ≥10% for trial: **PASS** (38.0%).
- Live seal ≥10% = real pass: **not yet** (still ~3.0%). Hand to @QA Bot for trial; no main merge.
- 🚀 EW is a different branch/number.

## Files
- `scripts/gainer_core.py` — E2_PREC_C1=1.2, `x_early_ok`, `exit_plan_for`
- `live.js` — mirrors + `xEarlyOk`
- `scripts/gainer_board.py` — snapshot X-early + exit_plan on entries
- `scripts/x_buzz_targets.py` — hourly early-candidate X targets (pumps keep priority)
- `picks.js` — promote X-early to ⚡ list; exit hint; keep 🚩 shill
- `scripts/dryrun_x_early.py` — this report's runner
