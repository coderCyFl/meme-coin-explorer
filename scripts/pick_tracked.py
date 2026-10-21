#!/usr/bin/env python3
"""Pick which tokens to track on X, from DexScreener's free API (no key).

Writes data/tracked.json: [{symbol, name, chain, address}], top N boosted tokens
by 24h volume with at least MIN_LIQ liquidity. Cost: ~2-5 free HTTP calls.
Usage: python3 scripts/pick_tracked.py [N=16] [MIN_LIQ=40000]
"""
import json, sys, urllib.request, collections, os
N = int(sys.argv[1]) if len(sys.argv) > 1 else 16
MIN_LIQ = float(sys.argv[2]) if len(sys.argv) > 2 else 40000
UA = {"User-Agent": "meme-coin-explorer/1.0"}
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20))
boosts = get("https://api.dexscreener.com/token-boosts/top/v1")
by_chain = collections.defaultdict(list)
for t in boosts: by_chain[t["chainId"]].append(t["tokenAddress"])
best = {}
for chain, addrs in by_chain.items():
    for i in range(0, len(addrs), 30):
        for p in get(f"https://api.dexscreener.com/tokens/v1/{chain}/{','.join(addrs[i:i+30])}"):
            k = (p["chainId"], p["baseToken"]["address"])
            liq = (p.get("liquidity") or {}).get("usd") or 0
            if k not in best or liq > ((best[k].get("liquidity") or {}).get("usd") or 0): best[k] = p
rows = [p for p in best.values() if ((p.get("liquidity") or {}).get("usd") or 0) >= MIN_LIQ]
rows.sort(key=lambda p: -((p.get("volume") or {}).get("h24") or 0))
out = [{"symbol": p["baseToken"]["symbol"].upper(), "name": p["baseToken"]["name"],
        "chain": p["chainId"], "address": p["baseToken"]["address"]} for p in rows[:N]]
path = os.path.join(os.path.dirname(__file__), "..", "data", "tracked.json")
json.dump(out, open(path, "w"), indent=1)
print(f"wrote {len(out)} tokens -> data/tracked.json:", ", ".join(t["symbol"] for t in out))
