# Seal external backup (second line)

GitHub Actions `schedule` can stall for hours (or skip slots entirely). On 2026-10-30 the
in-repo seal crons at **23:55 / 23:58 / 00:40 Asia/Shanghai** all missed; the 10/30 seal
only landed after a manual `gh workflow run gainer-board.yml -f cmd=scorecard`.

## Lines of defence

1. **First line (in-repo GH crons)** — keep as-is in `.github/workflows/gainer-board.yml`:
   - `55 15 * * *` → 23:55 Asia/Shanghai primary seal
   - `58 15 * * *` → 23:58 near backup
   - `40 16 * * *` → 00:40 catch-up
   - plus the 15-min snapshot slots (each also runs `seal_due()`)
2. **Second line (this doc)** — do **not** rely on GH schedule:
   - Script: `scripts/dispatch_seal_if_missing.sh`
   - Callable from any external cron / host that has `gh` + git access to this repo
   - Development BB Grok Bot routine at **23:56** and **00:42 Asia/Shanghai** (exact)
     runs the same check → dispatch

Sealed files stay write-once (`check_seals.py` + `sealed: true`). This backup never
force-pushes and never rewrites an existing seal.

## Script behaviour

```bash
# Auto day (Asia/Shanghai):
#   hour < 12  → yesterday   (covers 00:42 post-midnight catch-up)
#   hour ≥ 12  → today       (covers 23:56 evening seal)
scripts/dispatch_seal_if_missing.sh

# Explicit day
scripts/dispatch_seal_if_missing.sh 2026-10-30
```

- Reads `origin/main:data/gainer_board/daily_vs_gainers/$DAY.json` (git show, else gh api).
- If `sealed: true` → prints `ALREADY_SEALED` and exits 0.
- If missing / unsealed → `gh workflow run gainer-board.yml --repo coderCyFl/meme-coin-explorer --ref main -f cmd=scorecard` and prints `DISPATCHED`.

## Exact external times (Asia/Shanghai)

| When (HKT) | Purpose |
|---|---|
| **23:56** | ~1 min after primary 23:55 GH cron — catch a missed evening seal for *today* |
| **00:42** | ~2 min after 00:40 GH catch-up — catch a still-missing seal for *yesterday* |

Development BB owns the Grok Bot routine that fires at those two times and runs
`scripts/dispatch_seal_if_missing.sh` (or the equivalent check + `gh workflow run`).
Any other operator cron may call the same script.

## What this is not

- Not a replacement for the in-repo GH backup crons (those stay first line).
- Not a force / rewrite path — scorecard itself is deterministic `kline_asof_2355_v1`
  and refuses to clobber a sealed day.
