#!/usr/bin/env bash
# External seal backup for gainer-board daily scorecard.
# If data/gainer_board/daily_vs_gainers/$DAY.json is already sealed on origin/main → exit 0 (ALREADY_SEALED).
# If missing / unsealed → workflow_dispatch gainer-board scorecard (never force; never rewrite seals).
#
# Day selection (Asia/Shanghai):
#   - Optional arg: YYYY-MM-DD (the calendar day being sealed, i.e. the day whose 23:55 K-line seal we need).
#   - Default: if current hour in Asia/Shanghai is < 12 → yesterday
#              else → today
#     Rationale: evening runs (23:56) target *today*; post-midnight catch-up (00:42) targets *yesterday*
#     (the seal that just missed at 23:55). Hour < 12 → yesterday covers the 00:40 window.
#
# Usage:
#   scripts/dispatch_seal_if_missing.sh              # auto day
#   scripts/dispatch_seal_if_missing.sh 2026-10-30   # explicit day
#
# Requires: gh (authenticated), git, python3. Safe to run from any clone or bare cron host
# that can `git fetch` this repo and call `gh workflow run`.
set -euo pipefail

REPO="${REPO:-coderCyFl/meme-coin-explorer}"
REF="${REF:-main}"
SEAL_PATH_PREFIX="data/gainer_board/daily_vs_gainers"

# Resolve DAY in Asia/Shanghai
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  DAY="$1"
  if ! [[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "ERROR: day must be YYYY-MM-DD, got: $DAY" >&2
    exit 2
  fi
else
  # TZ=Asia/Shanghai: hour < 12 → yesterday (post-midnight catch-up); else today (evening seal).
  HOUR=$(TZ=Asia/Shanghai date +%H)
  if (( 10#$HOUR < 12 )); then
    DAY=$(TZ=Asia/Shanghai date -d 'yesterday' +%Y-%m-%d 2>/dev/null \
      || TZ=Asia/Shanghai date -v-1d +%Y-%m-%d 2>/dev/null \
      || python3 -c "from datetime import datetime,timedelta,timezone; z=timezone(timedelta(hours=8)); print((datetime.now(z)-timedelta(days=1)).date())")
  else
    DAY=$(TZ=Asia/Shanghai date +%Y-%m-%d)
  fi
fi

PATH_IN_REPO="${SEAL_PATH_PREFIX}/${DAY}.json"
echo "seal-backup: checking ${REPO}@${REF}:${PATH_IN_REPO} (Asia/Shanghai now=$(TZ=Asia/Shanghai date '+%F %T %z'))"

# Prefer git show origin/main (after fetch); fall back to gh api raw content.
check_sealed() {
  local content=""
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git fetch --quiet origin "$REF" 2>/dev/null || true
    if content=$(git show "origin/${REF}:${PATH_IN_REPO}" 2>/dev/null); then
      printf '%s' "$content"
      return 0
    fi
  fi
  # gh api: contents endpoint returns base64
  if content=$(gh api "repos/${REPO}/contents/${PATH_IN_REPO}?ref=${REF}" --jq .content 2>/dev/null); then
    printf '%s' "$content" | tr -d '\n' | base64 -d 2>/dev/null
    return 0
  fi
  return 1
}

if JSON=$(check_sealed); then
  SEALED=$(printf '%s' "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("true" if d.get("sealed") is True else "false")' 2>/dev/null || echo "false")
  if [[ "$SEALED" == "true" ]]; then
    echo "ALREADY_SEALED day=${DAY} path=${PATH_IN_REPO}"
    exit 0
  fi
  echo "PRESENT_BUT_UNSEALED day=${DAY} — will dispatch scorecard (write-once; will not rewrite if sealed mid-flight)"
else
  echo "MISSING day=${DAY} path=${PATH_IN_REPO} — will dispatch scorecard"
fi

# Never force. Never rewrite. Just ask Actions to run scorecard on main.
gh workflow run gainer-board.yml \
  --repo "$REPO" \
  --ref "$REF" \
  -f cmd=scorecard

echo "DISPATCHED day=${DAY} workflow=gainer-board.yml ref=${REF} cmd=scorecard"
exit 0
