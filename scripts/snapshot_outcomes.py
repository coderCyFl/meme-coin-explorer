#!/usr/bin/env python3
"""Record horizon outcomes for picks (append-only). Run on a schedule, e.g. hourly.

For each entry in data/picks.json and each horizon (24h/72h/168h) that has passed and
has no recorded outcome yet, fetch the pair's current price from DexScreener and append
{pick_id, horizon_h, observed_at, price_usd, liquidity_usd, status, return_pct, sol_return_pct}
to data/outcomes.json. If you run it late, observed_at tells you how late. Existing
records are never changed. A missing pair or liquidity under $1k is recorded as
status "dead" with return -100%.
"""
import json, os, datetime, urllib.request, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PICKS, OUT = os.path.join(ROOT, "data", "picks.json"), os.path.join(ROOT, "data", "outcomes.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
UA = {"User-Agent": "meme-coin-explorer/1.0"}
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20))

def pair_prices(chain, pairs):
    res = {}
    for i in range(0, len(pairs), 30):
        d = get(f"https://api.dexscreener.com/latest/dex/pairs/{chain}/{','.join(pairs[i:i+30])}")
        for p in d.get("pairs") or []: res[p["pairAddress"]] = p
    return res

log = json.load(open(PICKS))
out = json.load(open(OUT)) if os.path.exists(OUT) else {"description": "Append-only horizon snapshots. Never edit.", "records": []}
done = {(r["pick_id"], r["horizon_h"]) for r in out["records"]}
now = datetime.datetime.now(TZ).replace(microsecond=0)
todo = []
for b in log["batches"]:
    for e in b["entries"]:
        t0 = datetime.datetime.fromisoformat(e["created_at"])
        for h in e.get("horizons_h", [24, 72, 168]):
            if now >= t0 + datetime.timedelta(hours=h) and (e["id"], h) not in done: todo.append((b, e, h))
if not todo: print("nothing due"); raise SystemExit(0)
need = collections.defaultdict(set)
for b, e, h in todo:
    need[e["chain"]].add(e["pair_address"])
    s = b["benchmarks"].get("SOL"); need[s["chain"]].add(s["pair_address"])
live = {}
for ch, ps in need.items(): live.update(pair_prices(ch, sorted(ps)))
for b, e, h in todo:
    p = live.get(e["pair_address"]); sol = b["benchmarks"]["SOL"]; sp = live.get(sol["pair_address"])
    liq = ((p or {}).get("liquidity") or {}).get("usd") or 0
    dead = not p or liq < 1000
    price = 0.0 if dead else float(p["priceUsd"])
    out["records"].append({"pick_id": e["id"], "horizon_h": h, "observed_at": now.isoformat(), "price_usd": price,
        "liquidity_usd": liq, "status": "dead" if dead else "live",
        "return_pct": -100.0 if dead else round((price / e["entry_price_usd"] - 1) * 100, 2),
        "sol_return_pct": round((float(sp["priceUsd"]) / sol["price_usd"] - 1) * 100, 2) if sp else None})
    print("recorded", e["id"], f"{h}h", out["records"][-1]["return_pct"])
tmp = OUT + ".tmp"; json.dump(out, open(tmp, "w"), indent=1); os.replace(tmp, OUT)
