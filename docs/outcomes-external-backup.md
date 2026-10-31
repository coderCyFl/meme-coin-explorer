# Outcomes external backup (second line)

GitHub Actions `schedule` for `daily-outcomes.yml` can skip slots. Cron is every 4h UTC
(`0 1,5,9,13,17,21 * * *` → 09/13/17/21/01/05 Asia/Shanghai). On **2026-10-31** the
**05:00 UTC (=13:00 HKT)** slot never fired; only the ~01:00 UTC schedule ran
(~08:36 HKT). Past-`sell_by` seals for batch-013 (ANIME/DOT/APT/JUP @12h) and
chase BEAMX/SOPH (@24h) stayed missing until a manual
`gh workflow run "Daily outcomes snapshot"` (same pattern as weekend fill
`46aa0f5` / this fill `ddfcb8b`).

## Lines of defence

1. **First line (in-repo GH cron)** — keep as-is in `.github/workflows/daily-outcomes.yml`
   (every 4h UTC, `workflow_dispatch` enabled, append-only commit to `data/outcomes.json`).
2. **Second line (this doc)** — do **not** rely on GH schedule alone:
   - Script: `scripts/dispatch_outcomes_if_missing.sh`
   - Callable from any external cron / host with `gh` access
   - Suggested Development BB routine: **~10 min after each HKT slot**
     (09:10 / 13:10 / 17:10 / 21:10 / 01:10 / 05:10 Asia/Shanghai), or hourly.

Seals stay write-once per `(pick_id, horizon_h)` inside `snapshot_outcomes.py`.
This backup never force-pushes and never rewrites an existing seal. **Exit rules
stay frozen** (`setup_20261030e`) — the script only re-dispatches the existing job.

## Script behaviour

```bash
scripts/dispatch_outcomes_if_missing.sh
```

- Reads `data/picks.json` + `data/outcomes.json` on `origin/main` via `gh api`.
- Recomputes due horizons the same way as `seal_horizons()` in
  `scripts/snapshot_outcomes.py` (incl. 12h for `exit_rule=setup_20261030e`
  non-chase buys).
- If every due `(pick_id, horizon_h)` is already present → `NOTHING_DUE`, exit 0.
- If any missing → `gh workflow run daily-outcomes.yml --ref main` and print `DISPATCHED`.

## Exact external times (Asia/Shanghai)

| When (HKT) | Purpose |
|---|---|
| **09:10 / 13:10 / 17:10 / 21:10 / 01:10 / 05:10** | ~10 min after each in-repo cron slot — catch a skipped schedule |

Development BB owns the Grok Bot routine that fires at those times and runs
`scripts/dispatch_outcomes_if_missing.sh` (or the equivalent check + `gh workflow run`).

## What this is not

- Not a replacement for the in-repo 4h GH cron (that stays first line).
- Not an exit-rule / filter change — exit remains frozen at `setup_20261030e`.
- Not a force / rewrite path — outcomes are append-only.