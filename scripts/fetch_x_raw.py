#!/usr/bin/env python3
"""OPTIONAL: refresh data/raw/ straight from the official X API v2 (needs your own key).

Only use this if you want to run refreshes yourself without the agent. X API
access is paid, so the script keeps calls small:
  * 1 general meme-coin search
  * ceil(N/8) combined cashtag searches (8 tickers per query, 100 posts each)
  * 1 recent-counts call per ticker (skip with --no-counts)
For 16 tickers that's about 19 calls per refresh. Then run build_x_buzz.py.

HARD GATE: at most once per 24h (stamp file data/raw/.x_fetch_stamp).
Pass --force to override (still burns tokens — only for emergencies).

Usage: X_BEARER_TOKEN=... python3 scripts/fetch_x_raw.py [--no-counts] [--force]
"""
import json, os, sys, time, urllib.parse, urllib.request, datetime
TOKEN = os.environ.get("X_BEARER_TOKEN") or sys.exit("Set X_BEARER_TOKEN")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw"); os.makedirs(RAW, exist_ok=True)
STAMP = os.path.join(RAW, ".x_fetch_stamp")
MIN_INTERVAL_S = 24 * 3600
FORCE = "--force" in sys.argv
FIELDS = {"tweet.fields": "created_at,public_metrics,author_id,lang", "expansions": "author_id", "user.fields": "username"}
# Tickers that are everyday words get a crypto-context keyword query for counts.
CONTEXT = "(solana OR bsc OR bnb OR memecoin OR mcap OR pump OR crypto)"
COMMON = {"KIMCHI", "BINA", "GATO", "DAWG", "GLITCH", "TRUMP", "LORE", "BONNIE", "RIBBIT", "CHUD", "KOLO"}

def gate_or_exit():
    """Refuse to call X if last successful fetch was <24h ago (unless --force)."""
    if FORCE:
        print("WARNING: --force bypasses once/24h X gate (token burn risk)")
        return
    if not os.path.exists(STAMP):
        return
    try:
        age = time.time() - os.path.getmtime(STAMP)
    except OSError:
        return
    if age < MIN_INTERVAL_S:
        left_h = (MIN_INTERVAL_S - age) / 3600
        print(f"SKIP: X fetch gated ≤1/day (last {age/3600:.1f}h ago; wait ~{left_h:.1f}h or pass --force)")
        print("Site only reads static data/x_buzz.json — no client X calls.")
        sys.exit(0)

def get(path, params):
    url = "https://api.x.com/2/" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN})
    time.sleep(2.1)  # stay well under rate limits
    return json.load(urllib.request.urlopen(req, timeout=30))

gate_or_exit()

now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
start = (now - datetime.timedelta(days=6, hours=23)).strftime("%Y-%m-%dT%H:%M:%SZ")
tracked = json.load(open(os.path.join(ROOT, "data", "tracked.json")))
syms = list(dict.fromkeys(t["symbol"].upper() for t in tracked if t["symbol"][:1].isalpha()))

for f in os.listdir(RAW):
    if f.startswith("search_"): os.remove(os.path.join(RAW, f))
q = '(memecoin OR "meme coin") lang:en -is:retweet'
json.dump({"query": q, "response": get("tweets/search/recent", {"query": q, "max_results": 50, "start_time": start, "sort_order": "relevancy", **FIELDS})},
          open(os.path.join(RAW, "search_general.json"), "w"))
for i in range(0, len(syms), 8):
    q = "(" + " OR ".join("$" + s for s in syms[i:i + 8]) + ") -is:retweet"
    json.dump({"query": q, "response": get("tweets/search/recent", {"query": q, "max_results": 100, "start_time": start, "sort_order": "relevancy", **FIELDS})},
              open(os.path.join(RAW, f"search_cashtags_{i // 8 + 1}.json"), "w"))
if "--no-counts" not in sys.argv:
    counts = {}
    for s in syms:
        q = (f"{s.lower()} {CONTEXT}" if s in COMMON else f"${s}") + " -is:retweet"
        r = get("tweets/counts/recent", {"query": q, "start_time": start, "granularity": "day"})
        counts[s] = {"query": q, "total": r.get("meta", {}).get("total_tweet_count"), "daily": [d["tweet_count"] for d in r.get("data", [])]}
    json.dump({"window_start": start, "window_end": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "counts": counts},
              open(os.path.join(RAW, "counts.json"), "w"), indent=1)

# Stamp only after a successful run so a failed mid-run can retry.
with open(STAMP, "w") as f:
    f.write(now.isoformat() + "Z\n")
print("raw X data refreshed; stamp written; now run: python3 scripts/build_x_buzz.py")
