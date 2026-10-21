#!/usr/bin/env python3
"""Reproducible scoring + append-only pick logging.

  python3 scripts/make_picks.py score  BATCH_DIR            # print the score table (no writes)
  python3 scripts/make_picks.py commit BATCH_DIR NOTES.json # fetch live entry prices, append picks

Inputs in BATCH_DIR (written by the X refresh step):
  counts_hourly.json   {"window_start","window_end","counts":{SYM:{query,total,hourly:[...]}}}
  candidates.json      [{symbol, chain, address}] tokens to score (optional; else data/tracked.json)
  search samples: data/raw/search_*.json and BATCH_DIR/search_*.json (cashtag posts for engagement)
NOTES.json (the human/AI qualitative read, recorded verbatim):
  {"picks":{SYM:{"rationale": "...", "conviction_adj": int}}, "avoid":{SYM:{"rationale":"..."}}}

data/picks.json is APPEND-ONLY: existing entries are never modified or removed.
Scores use only data that exists at pick time. Outcomes are computed later (browser /
scripts/snapshot_outcomes.py) from the stored entry price.
"""
import json, os, sys, math, glob, re, datetime, urllib.request, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PICKS = os.path.join(ROOT, "data", "picks.json")
UA = {"User-Agent": "meme-coin-explorer/1.0"}
TZ = datetime.timezone(datetime.timedelta(hours=8))   # Asia/Shanghai, recorded with offset
MIN_LIQ = 50_000
BENCH = {"SOL": ("solana", "So11111111111111111111111111111111111111112"),
         "BTC": ("ethereum", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599")}  # WBTC

def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20))

def best_pairs(chain, addrs):
    best = {}
    for i in range(0, len(addrs), 30):
        for p in get(f"https://api.dexscreener.com/tokens/v1/{chain}/{','.join(addrs[i:i+30])}"):
            a = p["baseToken"]["address"]
            if a.lower() not in {x.lower() for x in addrs}: continue  # skip pairs where token is the quote
            l = (p.get("liquidity") or {}).get("usd") or 0
            if a not in best or l > ((best[a].get("liquidity") or {}).get("usd") or 0): best[a] = p
    return best

def engagement(symbols):
    """Per-cashtag stats from saved X search samples (posts must contain $SYM)."""
    posts, users = {}, {}
    for f in glob.glob(os.path.join(ROOT, "data", "raw", "**", "search_*.json"), recursive=True):
        r = json.load(open(f)).get("response", {})
        for u in (r.get("includes") or {}).get("users", []): users[u["id"]] = u.get("username")
        for p in r.get("data", []): posts[p["id"]] = p
    st = {s: {"posts": 0, "authors": set(), "likes": 0, "reposts": 0, "top": []} for s in symbols}
    for p in posts.values():
        tags = {t.upper() for t in re.findall(r"\$([A-Za-z][A-Za-z0-9_]*)", p.get("text", ""))}
        for s in tags & set(symbols):
            m = p.get("public_metrics", {}); x = st[s]
            x["posts"] += 1; x["authors"].add(p.get("author_id")); x["likes"] += m.get("like_count", 0); x["reposts"] += m.get("retweet_count", 0)
            u = users.get(p.get("author_id"))
            x["top"].append({"url": f"https://x.com/{u or 'i'}/status/{p['id']}", "likes": m.get("like_count", 0),
                             "reposts": m.get("retweet_count", 0), "author": u, "created_at": p.get("created_at"),
                             "tags_in_post": len(tags)})
    for x in st.values():
        x["authors"] = len(x["authors"])
        x["top"] = sorted(x["top"], key=lambda t: -(t["likes"] + 2 * t["reposts"]))[:3]
    return st

def score_one(p, cnt, eng, now_ms):
    """Transparent 0-100 score. Returns (score, parts, flags, hard_red_flags)."""
    liq = (p.get("liquidity") or {}).get("usd") or 0
    vol = (p.get("volume") or {}).get("h24") or 0
    ch24 = (p.get("priceChange") or {}).get("h24") or 0
    age_h = (now_ms - (p.get("pairCreatedAt") or now_ms)) / 3.6e6
    tx = (p.get("txns") or {}).get("h24") or {}
    buys, sells = tx.get("buys", 0), tx.get("sells", 0)
    parts, flags, hard = {}, [], []
    h = (cnt or {}).get("hourly") or []
    last24, prev24 = sum(h[-24:]), sum(h[-48:-24])
    base_days = max(1, (len(h) - 24) / 24)
    base = sum(h[:-24]) / base_days if len(h) > 24 else 0          # avg posts/day before the last 24h
    last6, prev6 = sum(h[-6:]), sum(h[-12:-6])
    # 1) buzz growth (0-30): last 24h vs prior daily average, log2 scale, capped
    growth = (last24 + 5) / (base + 5)
    parts["buzz_growth"] = round(max(0, min(30, 10 + 10 * math.log2(growth))), 1) if h else 0
    # 2) buzz level (0-15): log10 of posts in last 24h (1000/day = 15)
    parts["buzz_level"] = round(min(15, 5 * math.log10(1 + last24)), 1) if h else 0
    # 3) momentum (−5..+5): is buzz still rising in the last 6h vs the 6h before?
    parts["buzz_momentum"] = round(max(-5, min(5, 5 * math.log2((last6 + 3) / (prev6 + 3)) / 2)), 1) if h else 0
    # 4) engagement quality (0-15): unique authors + likes per cashtag post in the sample
    if eng and eng["posts"]:
        lpp = (eng["likes"] + 2 * eng["reposts"]) / eng["posts"]
        parts["engagement"] = round(min(15, 2 * eng["authors"] + 3 * math.log10(1 + lpp)), 1)
    else:
        parts["engagement"] = 0
    # 5) liquidity (0-20): $50k=0 → $1M=20 (log scale)
    parts["liquidity"] = round(max(0, min(20, 20 * math.log10(max(liq, 1) / 5e4) / math.log10(20))), 1)
    # 6) market structure (0-15): buy/sell balance + sane volume/liquidity
    bs = buys / max(1, buys + sells)
    vl = vol / max(1, liq)
    parts["market"] = round(max(0, min(15, 7.5 * min(1, bs / 0.5) + (7.5 if 0.5 <= vl <= 20 else 3 if vl <= 50 else 0))), 1)
    # penalties + flags
    pen = 0
    if liq < MIN_LIQ: hard.append("liquidity < $50k")
    if age_h < 24: hard.append(f"pair only {age_h:.0f}h old"); pen += 10
    if ch24 <= -50: hard.append(f"down {ch24:.0f}% in 24h"); pen += 10
    if vl > 50: hard.append(f"volume {vl:.0f}x liquidity"); pen += 10
    if ch24 >= 300: flags.append(f"already +{ch24:.0f}% in 24h (chasing risk)"); pen += 10
    if p.get("marketCap") and liq > 0.6 * p["marketCap"]: flags.append("liquidity ≈ market cap (unusual pool setup)"); pen += 5
    if p.get("boosts", {}).get("active"): flags.append("paid DexScreener boost"); pen += 3
    if last6 < 0.5 * prev6 and prev6 >= 20: flags.append("buzz fading in last 6h")
    parts["penalties"] = -pen
    score = max(0, min(100, round(sum(parts.values()))))
    metrics = {"x_last24h": last24, "x_prev24h": prev24, "x_prior_daily_avg": round(base, 1), "x_last6h": last6, "x_prev6h": prev6,
               "x_7d_total": (cnt or {}).get("total"), "liq_usd": liq, "vol24h_usd": vol, "chg24h_pct": ch24, "age_h": round(age_h, 1),
               "buys24h": buys, "sells24h": sells, "vol_liq": round(vl, 2)}
    return score, parts, flags, hard, metrics

def load_inputs(batch):
    counts = json.load(open(os.path.join(batch, "counts_hourly.json")))
    cf = os.path.join(batch, "candidates.json")
    cands = json.load(open(cf)) if os.path.exists(cf) else json.load(open(os.path.join(ROOT, "data", "tracked.json")))
    return counts, cands

def run_scores(batch):
    counts, cands = load_inputs(batch)
    cands = [c for c in cands if c["symbol"].upper() in counts["counts"]]
    by_chain = collections.defaultdict(list)
    for c in cands: by_chain[c["chain"]].append(c["address"])
    pairs = {}
    for ch, a in by_chain.items(): pairs.update(best_pairs(ch, a))
    eng = engagement([c["symbol"].upper() for c in cands])
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    rows = []
    for c in cands:
        p = pairs.get(c["address"]); s = c["symbol"].upper()
        if not p: continue
        sc, parts, flags, hard, met = score_one(p, counts["counts"][s], eng.get(s), now_ms)
        rows.append({"symbol": s, "pair": p, "score": sc, "parts": parts, "flags": flags, "hard": hard, "metrics": met, "eng": eng.get(s), "count": counts["counts"][s]})
    rows.sort(key=lambda r: -r["score"])
    return rows, counts

def print_table(rows):
    print(f"{'SYM':10} {'score':>5} {'growth':>6} {'level':>5} {'mom':>5} {'eng':>4} {'liq':>4} {'mkt':>4} {'pen':>4}  liq$      x24h  hard/flags")
    for r in rows:
        p = r["parts"]; m = r["metrics"]
        print(f"{r['symbol']:10} {r['score']:>5} {p['buzz_growth']:>6} {p['buzz_level']:>5} {p['buzz_momentum']:>5} {p['engagement']:>4} {p['liquidity']:>4} {p['market']:>4} {p['penalties']:>4}  {m['liq_usd']:>8.0f} {m['x_last24h']:>5}  {r['hard']} {r['flags']}")

def commit(batch, notes_path):
    notes = json.load(open(notes_path))
    rows, counts = run_scores(batch)
    log = json.load(open(PICKS)) if os.path.exists(PICKS) else {"schema": 1, "description": "Append-only AI pick log. Never edit or delete past entries.", "batches": []}
    now = datetime.datetime.now(TZ).replace(microsecond=0)
    bid = f"batch-{len(log['batches']) + 1:03d}"
    bench = {}
    for name, (ch, addr) in BENCH.items():
        bp = best_pairs(ch, [addr]).get(addr)
        if bp: bench[name] = {"chain": ch, "address": addr, "pair_address": bp["pairAddress"], "price_usd": float(bp["priceUsd"])}
    entries = []
    for kind in ("picks", "avoid"):
        for sym, n in notes.get(kind, {}).items():
            r = next((x for x in rows if x["symbol"] == sym), None)
            if not r: print("skip (no data):", sym); continue
            p = r["pair"]
            conv = max(0, min(100, r["score"] + int(n.get("conviction_adj", 0)))) if kind == "picks" else None
            entries.append({
                "id": f"{now:%Y%m%d}-{bid[-3:]}-{sym}", "batch": bid, "type": "buy" if kind == "picks" else "avoid",
                "created_at": now.isoformat(), "chain": p["chainId"], "token_address": p["baseToken"]["address"],
                "pair_address": p["pairAddress"], "dex": p.get("dexId"), "symbol": sym, "name": p["baseToken"]["name"],
                "url": p.get("url"), "entry_price_usd": float(p["priceUsd"]),
                "entry_snapshot": {"liquidity_usd": r["metrics"]["liq_usd"], "volume24h_usd": r["metrics"]["vol24h_usd"],
                                   "market_cap_usd": p.get("marketCap"), "fdv_usd": p.get("fdv"), "pair_age_h": r["metrics"]["age_h"],
                                   "chg24h_pct": r["metrics"]["chg24h_pct"], "buys24h": r["metrics"]["buys24h"], "sells24h": r["metrics"]["sells24h"]},
                "model_score": r["score"], "score_parts": r["parts"], "conviction": conv,
                "rationale": n["rationale"], "flags": r["flags"] + r["hard"],
                "evidence": {"x_count_query": r["count"]["query"], "x_7d_total": r["metrics"]["x_7d_total"],
                             "x_last24h": r["metrics"]["x_last24h"], "x_prior_daily_avg": r["metrics"]["x_prior_daily_avg"],
                             "x_last6h": r["metrics"]["x_last6h"], "x_prev6h": r["metrics"]["x_prev6h"],
                             "cashtag_sample": {"posts": (r["eng"] or {}).get("posts", 0), "unique_authors": (r["eng"] or {}).get("authors", 0),
                                                "likes": (r["eng"] or {}).get("likes", 0)},
                             "posts": [t["url"] for t in (r["eng"] or {}).get("top", [])]},
                "horizons_h": [24, 72, 168],
            })
    log["batches"].append({"id": bid, "created_at": now.isoformat(), "x_window": [counts.get("window_start"), counts.get("window_end")],
                           "method": "scripts/make_picks.py score_one() v1; qualitative read in rationale",
                           "benchmarks": bench, "entries": entries})
    tmp = PICKS + ".tmp"; json.dump(log, open(tmp, "w"), indent=1, ensure_ascii=False); os.replace(tmp, PICKS)
    print(f"appended {bid} with {len(entries)} entries; benchmarks: {', '.join(f'{k}=${v['price_usd']:.2f}' for k, v in bench.items())}")
    for e in entries: print(f"  {e['type']:5} {e['symbol']:10} {e['chain']:8} ${e['entry_price_usd']:.8g} score={e['model_score']} conv={e['conviction']}")

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "score": print_table(run_scores(sys.argv[2])[0])
    elif len(sys.argv) >= 4 and sys.argv[1] == "commit": commit(sys.argv[2], sys.argv[3])
    else: print(__doc__)
