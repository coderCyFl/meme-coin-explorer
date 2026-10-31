# X-early dry-run r2 — 2026-10-25 .. 2026-10-30 (Asia/Shanghai)

Branch base `x-early-20261030` @ `e51918b` · runner `scripts/dryrun_x_early.py` (trial patch)  
Raw JSON: `/workspace/x-early-dryrun-20261030-r2.json`  
Generated 2026-10-31 ~14:20 HKT · **X alone = dry only, does NOT open paper**

## Trial rules (Strategy preview 2026-10-31)
1. **e2** — shipped early2 (prec widen 1.2/1.5/15 + start/thin); hard EARLY = **c24&lt;15** (seal gate unchanged)
2. **X alone** — `via=x_buzz`: X∈{熱,升溫}, **🚩 shill excluded**, **24h&lt;+8%** (tightened from 15), not top20, 1h vol≥1.5x
3. **union** = e2 ∪ X
4. Extra column **very_early**: caught with **c24&lt;8** (e2 subset ∪ all X trial hits)

## Aggregate (6 sealed days, n=120)

| slice | recall | caught/n | notes |
|---|---|---|---|
| **e2** | **38.3%** | 46/120 | hard c24&lt;15 |
| **X alone** | **0.8%** | 1/120 | only HYPE 10/29; dry-only |
| **e2 ∪ X** | **39.2%** | 47/120 | X lift **+0.9pp** |
| very_early e2 (c24&lt;8) | 25.0% | 30/120 | |
| very_early union | 25.8% | 31/120 | |

### Apples-to-apples vs old dry (10/25–29 only)
| slice | this run | old dry |
|---|---|---|
| e2 | 37.0% (37/100) | 37.0% |
| X alone | 1.0% (1/100) | 1.0% |
| union | **38.0% (38/100)** | **38.0%** |

### Sealed day 2026-10-30 alone
| slice | recall | syms |
|---|---|---|
| e2 | 45.0% (9/20) | BCH BEAMX FLOKI NIL PUNDIX RUNE SKY SOPH TRX |
| X alone | **0.0%** (0/20) | — |
| union | 45.0% (9/20) | same as e2 |
| very_early union | 30.0% (6/20) | BCH BEAMX FLOKI NIL SKY TRX |

## Live scorecard (same window — do not mix with dry)

| day | live recall | live prec | early hits/flagged |
|---|---|---|---|
| 10/25 | 0.0% | 0.0% | 0/4 |
| 10/26 | 0.0% | 0.0% | 0/6 |
| 10/27 | 5.0% | 20.0% | 1/5 |
| 10/28 | 0.0% | 0.0% | 0/6 |
| 10/29 | 10.0% | 20.0% | 2/10 |
| **10/30** | **35.0%** | 17.1% | 7/41 |

Live avg recall **8.3%** (was ~3% without 10/30). Live≥10% days: 10/29, 10/30.

## Prospective X incremental on sealed days — honest flag

**No real new X incremental hits on 10/30.**

- Mined X history: 109 checks / 28 熱|升溫 (branch + origin/main).
- 10/30 hot checks on sealed top-20: PARTI (all 🚩 shill → excluded), TRX 升溫 @08:16 (shill=False) but **c24=8.92 ≥ 8** so fails tightened gate (would pass old c24&lt;15). TRX already in e2 earlier @ c24=3.7 → even under old gate, **no union lift**.
- Only X-alone incremental in whole window: **HYPE 10/29** (+1 coin / +0.9pp).

Old dry union ~38% with live ~3% gap was Actions density / not-yet-shipped legs. Live on 10/30 (35%) vs dry 45% — gap narrowed; X prospective targeting still sparse and mostly post-move / shill-tagged. **Do not treat dry 39% as live-ready X edge.**

## Gates
- Dry union ≥10%: **PASS** (39.2%)
- X opens paper: **NO** (trial dry-only)
- Exit / filters: still frozen `setup_20261030e`
- Main merge: **NO** until QA APPROVE

## Artifacts
- JSON: `docs/dryruns/x-early-dryrun-20261030-r2.json` (on artifacts branch)
- MD: `docs/dryruns/x-early-dryrun-20261030-r2.md`
- Log: workspace `/workspace/x-early-dryrun-20261030-r2.log`
