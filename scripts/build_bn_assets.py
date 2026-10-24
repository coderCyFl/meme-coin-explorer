#!/usr/bin/env python3
"""Build data/bn_assets.json: {BASE: {"n": name, "l": logoUrl}} for every TRADING Binance spot USDT base.

Binance public data only: exchangeInfo (data-api.binance.vision) + Binance's public asset list
(www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset). Used by the site's coin search
(name search + logo). Safe to re-run any time; the site falls back to symbol-only if the file is missing.
"""
import json, os, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bn_assets.json")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    ei = get("https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT")
    bases = sorted({s["baseAsset"] for s in ei["symbols"]
                    if s.get("quoteAsset") == "USDT" and s.get("status") == "TRADING" and s.get("isSpotTradingAllowed")})
    meta = {}
    try:
        for a in get("https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset").get("data") or []:
            code = a.get("assetCode")
            if code:
                meta[code] = {"n": (a.get("assetName") or "").strip(), "l": a.get("logoUrl") or ""}
    except Exception as e:  # names/logos are optional
        print("asset list failed:", e)
    out = {b: meta.get(b, {"n": "", "l": ""}) for b in bases}
    with open(OUT, "w") as f:
        json.dump({"updated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "assets": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(len(out), "bases ->", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
