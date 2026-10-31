# X afternoon quota reserve (2026-10-31)

## Problem

`DAILY_TOTAL_CAP = 60` (Asia/Shanghai day, counted in `data/gainer_board/x_buzz_log.jsonl`)
was burning out by ~09:12 on cold 🔥 rechecks. Afternoon 🔥 / early-candidate runs then got
`targets=[]` with no remaining calls — blocking Cyrus’s “catch before it explodes” goal.

Example burn (2026-10-31): 60/60 by 09:12; verdicts that morning ≈ 28×冷 / 2×升溫; zero
calls after 09:00.

## Policy (scheduler only — seal / exit / paper unchanged)

Configured in `scripts/x_buzz_targets.py`:

| knobs | default | meaning |
| --- | --- | --- |
| `DAILY_TOTAL_CAP` | 60 | hard Shanghai-day X call ceiling |
| `AFTERNOON_START_HOUR` | 12 | unlock reserved calls from this hour (inclusive) |
| `AFTERNOON_RESERVE_CALLS` | 24 | ~12 targets × `CALLS_PER_TARGET` held for afternoon |
| `VERY_EARLY_C24_MAX` | 8.0 | prefer early-candidate pool with 24h move &lt; +8% |

Behaviour:

1. **Morning soft ceiling** — before `AFTERNOON_START_HOUR`, spendable =
   `DAILY_TOTAL_CAP - AFTERNOON_RESERVE_CALLS - used`. Hard `cap_reached` (site
   「今日 X 額度用完」) still means the full day budget is gone, not that the reserve is holding.
2. **Defer cold rechecks in morning** — if a coin’s last verdict is `冷`, skip scheduling
   another check until afternoon so the reserve is not eaten by dead boards.
3. **Early-candidate preference** — `current_early_candidates` still admits up to
   `gainer_core.X_EARLY_C24_MAX` (15, seal-aligned), but sorts **very-early (c24 &lt; 8%)**
   first. Target priority: first-check 🔥 → first-check very-early → other first-check → recheck.
4. **No seal / exit / paper rule changes** on this branch. X-alone still is not a live edge
   until a later dry shows prospective lift.

## Verify

```bash
# Unit (no Binance / X):
python3 -m unittest tests.test_x_afternoon_quota -v

# Offline plan with a frozen 🔥 list + --now to simulate morning vs afternoon:
python3 scripts/x_buzz_targets.py --no-write --pumps-json /tmp/pumps.json --now 2026-10-31T09:00:00+08:00
python3 scripts/x_buzz_targets.py --no-write --pumps-json /tmp/pumps.json --now 2026-10-31T13:00:00+08:00
# Expect morning: spendable_now reflects reserve; deferred_cold_rechecks may be >0;
# afternoon: spendable_now == calls_remaining.
```

## Out of scope

- Raising the absolute 60-call day cap
- Changing seal hard-gate (`c24&lt;15` / recall definition) or exit `setup_20261030e`
- Merging without QA APPROVE
