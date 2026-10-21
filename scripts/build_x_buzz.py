#!/usr/bin/env python3
"""Build data/x_buzz.json from raw X responses in data/raw/ (no network, free).

Inputs (all optional except tracked.json):
  data/tracked.json         [{symbol,name,chain,address}]  (from pick_tracked.py)
  data/raw/search_*.json    {"query": str, "response": <X v2 search response>}
  data/raw/counts.json      {"window_start","window_end","counts":{SYM:{query,total,daily,note?}}}
Output:
  data/x_buzz.json          per-coin mention counts + top posts; the website reads this.

Matching rule: a post counts for SYMBOL only if it contains the cashtag $SYMBOL
(case-insensitive, word boundary). Plain words like "kimchi" don't count, which
avoids food / Spanish "gato" noise. Same-ticker tokens are flagged as collisions.
"""
import json, glob, os, re, datetime, collections
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
D = lambda *p: os.path.join(ROOT, "data", *p)
# Tickers that are also everyday words/names: keyword counts are unreliable for these.
COMMON_WORDS = {"KIMCHI", "BINA", "GATO", "DAWG", "GLITCH", "TRUMP", "LORE", "BONNIE", "RIBBIT", "CHUD", "KOLO"}
MAX_POSTS = 5

def clean(text, n=220):
    t = re.sub(r"https?://t\.co/\S+", "", text or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= n else t[: n - 1] + "…"

tracked = json.load(open(D("tracked.json")))
coins = collections.OrderedDict()
for t in tracked:
    c = coins.setdefault(t["symbol"].upper(), {"symbol": t["symbol"].upper(), "tokens": [],
        "mentions_7d": None, "mentions_daily": None, "count_query": None, "count_note": None,
        "search_hits": 0, "top_posts": [], "flags": []})
    c["tokens"].append({"name": t["name"], "chain": t["chain"], "address": t["address"]})

posts, users, queries = {}, {}, []
for f in sorted(glob.glob(D("raw", "search_*.json")) + glob.glob(D("raw", "batch-*", "search_*.json"))):
    blob = json.load(open(f)); r = blob.get("response", {})
    queries.append(blob.get("query"))
    for u in (r.get("includes") or {}).get("users", []): users[u["id"]] = u.get("username")
    for p in r.get("data", []): posts[p["id"]] = p

def post_obj(p):
    m = p.get("public_metrics", {}); u = users.get(p.get("author_id"))
    return {"id": p["id"], "text": clean(p.get("text")), "created_at": p.get("created_at"),
            "likes": m.get("like_count", 0), "reposts": m.get("retweet_count", 0),
            "replies": m.get("reply_count", 0), "author": u,
            "url": f"https://x.com/{u}/status/{p['id']}" if u else f"https://x.com/i/status/{p['id']}"}

eng = lambda p: p["likes"] + 2 * p["reposts"] + p["replies"]
cashtag_counter = collections.Counter()
for p in posts.values():
    tags = {t.upper() for t in re.findall(r"\$([A-Za-z][A-Za-z0-9_]{0,19})\b", p.get("text", ""))}
    cashtag_counter.update(tags)
    for sym in tags & set(coins):
        coins[sym]["search_hits"] += 1
        coins[sym]["top_posts"].append(post_obj(p))
for c in coins.values():
    c["top_posts"] = sorted(c["top_posts"], key=eng, reverse=True)[:MAX_POSTS]

window = {}
cp = D("raw", "counts.json")
if os.path.exists(cp):
    cj = json.load(open(cp)); window = {"start": cj.get("window_start"), "end": cj.get("window_end")}
    for sym, v in cj.get("counts", {}).items():
        if sym in coins:
            coins[sym].update(mentions_7d=v.get("total"), mentions_daily=v.get("daily"),
                              count_query=v.get("query"), count_note=v.get("note"))
# Newer hourly counts from pick batches (data/raw/batch-*/counts_hourly.json) override older daily ones.
for hp in sorted(glob.glob(D("raw", "batch-*", "counts_hourly.json"))):
    hj = json.load(open(hp)); window = {"start": hj.get("window_start"), "end": hj.get("window_end")}
    for sym, v in hj.get("counts", {}).items():
        if sym not in coins: continue
        h = v.get("hourly") or []
        daily = [sum(h[max(0, i - 24):i]) for i in range(len(h), 0, -24)][::-1]   # 24h buckets ending now
        coins[sym].update(mentions_7d=v.get("total"), mentions_daily=daily, count_query=v.get("query"), count_note=v.get("note"))
for c in coins.values():
    if c["symbol"] in COMMON_WORDS: c["flags"].append("common_word")
    if len(c["tokens"]) > 1: c["flags"].append("ticker_collision")
    d = c["mentions_daily"]
    if d and len(d) >= 3 and d[-1] >= 50 and d[-1] > 3 * (sum(d[:-1]) / max(1, len(d) - 1)):
        c["flags"].append("spiking")

general = [post_obj(p) for p in posts.values()]
out = {
    "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "window": window,
    "source": "X public search via the agent's built-in X tools (snapshot; the website never calls X)",
    "queries": queries,
    "notes": [
        "mentions_7d = X recent post counts (non-retweets) for the keyword in count_query. The search backend drops the '$' operator, so counts are keyword counts; for ambiguous tickers a crypto-context query is used instead.",
        "top_posts only include posts that literally contain the $CASHTAG.",
        "Buzz is not quality: shills, bots and paid promos inflate mentions.",
    ],
    "coins": list(coins.values()),
    "top_cashtags_in_sample": cashtag_counter.most_common(25),
    "top_general_posts": sorted(general, key=eng, reverse=True)[:8],
}
json.dump(out, open(D("x_buzz.json"), "w"), indent=1, ensure_ascii=False)
print(f"wrote data/x_buzz.json: {len(coins)} coins, {len(posts)} unique posts")
for c in sorted(coins.values(), key=lambda c: -(c["mentions_7d"] or 0)):
    print(f"  {c['symbol']:<12} 7d={c['mentions_7d']} hits={c['search_hits']} flags={c['flags']}")
