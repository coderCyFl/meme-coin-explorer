#!/usr/bin/env bash
# External outcomes backup for daily-outcomes (paper exit seals).
# If any pick horizon is due on origin/main but missing from data/outcomes.json
# → workflow_dispatch daily-outcomes.yml (never force; never rewrite seals;
#    snapshot_outcomes.py is append-only / write-once per (pick_id, horizon_h)).
#
# Mirrors scripts/dispatch_seal_if_missing.sh for the gainer-board seal path.
# Exit rules stay frozen (setup_20261030e) — this only re-runs the existing
# snapshot job when GH schedule misses a slot.
#
# Usage:
#   scripts/dispatch_outcomes_if_missing.sh
#
# Requires: gh (authenticated), python3. Safe from any host that can call
# `gh api` / `gh workflow run` against this repo.
set -euo pipefail

REPO="${REPO:-coderCyFl/meme-coin-explorer}"
REF="${REF:-main}"
WORKFLOW="${WORKFLOW:-daily-outcomes.yml}"

echo "outcomes-backup: checking due seals on ${REPO}@${REF} (Asia/Shanghai now=$(TZ=Asia/Shanghai date '+%F %T %z'))"

TMPDIR_OUT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_OUT"' EXIT
PICKS_FILE="${TMPDIR_OUT}/picks.json"
OUT_FILE="${TMPDIR_OUT}/outcomes.json"
MISS_FILE="${TMPDIR_OUT}/missing.txt"

fetch_json() {
  local path="$1"
  local dest="$2"
  local b64
  if ! b64=$(gh api "repos/${REPO}/contents/${path}?ref=${REF}" --jq .content 2>/dev/null); then
    echo "ERROR: cannot read ${path} from ${REPO}@${REF}" >&2
    return 1
  fi
  printf '%s' "$b64" | tr -d '\n' | base64 -d > "$dest"
}

fetch_json "data/picks.json" "$PICKS_FILE"
fetch_json "data/outcomes.json" "$OUT_FILE"

COUNT=$(python3 - "$PICKS_FILE" "$OUT_FILE" "$MISS_FILE" <<'PY'
import json, sys, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
DEFAULT_HORIZONS = [24, 72, 168]
SETUP_12H_RULE = "setup_20261030e"

picks = json.load(open(sys.argv[1]))
out = json.load(open(sys.argv[2]))
miss_path = sys.argv[3]
done = {(r["pick_id"], int(r["horizon_h"])) for r in out.get("records") or []}
now = datetime.datetime.now(TZ).replace(microsecond=0)

def seal_horizons(e):
    hz = list(e.get("horizons_h") or DEFAULT_HORIZONS)
    if (
        e.get("exit_rule") == SETUP_12H_RULE
        and e.get("tier") != "chase"
        and e.get("type", "buy") == "buy"
        and e.get("sell_by")
    ):
        try:
            t0 = datetime.datetime.fromisoformat(e["created_at"])
            sb = datetime.datetime.fromisoformat(e["sell_by"])
            if sb.tzinfo is None:
                sb = sb.replace(tzinfo=TZ)
            if t0.tzinfo is None:
                t0 = t0.replace(tzinfo=TZ)
            sbh = round((sb - t0).total_seconds() / 3600)
            if 0 < sbh < min(hz) and sbh not in hz:
                hz = [sbh] + hz
        except (TypeError, ValueError, KeyError):
            pass
    return sorted(set(int(h) for h in hz))

missing = []
for b in picks.get("batches") or []:
    for e in b.get("entries") or []:
        try:
            t0 = datetime.datetime.fromisoformat(e["created_at"])
            if t0.tzinfo is None:
                t0 = t0.replace(tzinfo=TZ)
        except (TypeError, ValueError, KeyError):
            continue
        for h in seal_horizons(e):
            if now >= t0 + datetime.timedelta(hours=h, minutes=1) and (e["id"], h) not in done:
                missing.append(f"{e['id']}@{h}h")

with open(miss_path, "w") as f:
    if missing:
        f.write("\n".join(missing) + "\n")
print(len(missing))
PY
)

if [[ "${COUNT}" -eq 0 ]]; then
  echo "NOTHING_DUE — all due horizons already sealed on ${REF}"
  exit 0
fi

echo "MISSING_DUE count=${COUNT}:"
head -40 "$MISS_FILE"
if [[ "$COUNT" -gt 40 ]]; then
  echo "... ($((COUNT - 40)) more)"
fi

gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF"
echo "DISPATCHED workflow=${WORKFLOW} ref=${REF} missing=${COUNT}"
exit 0