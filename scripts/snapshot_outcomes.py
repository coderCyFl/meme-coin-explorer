#!/usr/bin/env python3
"""Record horizon outcomes for picks (append-only). Run on a schedule, e.g. hourly.

For each entry in data/picks.json and each horizon (24h/72h/168h) that has passed and
has no recorded outcome yet, fetch the current price and append
{pick_id, horizon_h, observed_at, price_usd, liquidity_usd, status, return_pct, sol_return_pct}
to data/outcomes.json.

Pricing:
- chain "binance" (pair_address like TRUMPUSDT): Binance public REST via
  data-api.binance.vision (geo-friendly mirror of api.binance.com). Uses 24hr ticker
  lastPrice + quoteVolume. Missing symbol or quoteVolume < $1k → status "dead".
- other chains (legacy Dex / Solana batch-001): DexScreener pairs API. Missing pair
  or liquidity < $1k → status "dead".

If you run it late, observed_at tells you how late. Existing records are never changed.
"""
import json, os, datetime, urllib.request, collections, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PICKS = os.path.join(ROOT, "data", "picks.json")
OUT = os.path.join(ROOT, "data", "outcomes.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
UA = {"User-Agent": "meme-coin-explorer/1.0"}
# Prefer vision mirror — api.binance.com is geo-blocked in some regions (incl. GH Actions
# can vary). Same public market data, no key.
BN_BASE = "https://data-api.binance.vision"


def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20))


def is_binance(chain, pair_address=""):
    ch = (chain or "").lower()
    pa = (pair_address or "").upper()
    return ch in ("binance", "binance-spot") or (pa.endswith("USDT") and "/" not in pa and len(pa) >= 6)


def dex_pair_prices(chain, pairs):
    res = {}
    for i in range(0, len(pairs), 30):
        chunk = pairs[i : i + 30]
        d = get(f"https://api.dexscreener.com/latest/dex/pairs/{chain}/{','.join(chunk)}")
        for p in d.get("pairs") or []:
            res[p["pairAddress"]] = {
                "price_usd": float(p.get("priceUsd") or 0),
                "liquidity_usd": float(((p.get("liquidity") or {}).get("usd")) or 0),
                "source": "dexscreener",
            }
    return res


def bn_tickers(symbols):
    """Fetch 24hr tickers for Binance USDT symbols. Returns map symbol -> quote."""
    res = {}
    # Batch: /api/v3/ticker/24hr with no symbol returns all — too heavy.
    # Per-symbol is fine for our small todo sets; group unique.
    for sym in symbols:
        sym = sym.upper()
        try:
            d = get(f"{BN_BASE}/api/v3/ticker/24hr?symbol={sym}")
        except urllib.error.HTTPError as e:
            # 400 invalid symbol → treat as missing
            if e.code in (400, 404):
                continue
            raise
        except Exception:
            continue
        try:
            price = float(d.get("lastPrice") or 0)
            qv = float(d.get("quoteVolume") or 0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        res[sym] = {
            "price_usd": price,
            "liquidity_usd": qv,  # CEX proxy: 24h quote volume USDT
            "source": "binance-24hr",
        }
    return res


def live_quote(chain, pair_address, cache_dex, cache_bn):
    if is_binance(chain, pair_address):
        return cache_bn.get(pair_address.upper())
    # DexScreener is case-sensitive on some chains; try exact then lower
    q = cache_dex.get(pair_address) or cache_dex.get(pair_address.lower())
    return q


log = json.load(open(PICKS))
out = (
    json.load(open(OUT))
    if os.path.exists(OUT)
    else {"description": "Append-only horizon snapshots. Never edit.", "records": []}
)
done = {(r["pick_id"], r["horizon_h"]) for r in out["records"]}
now = datetime.datetime.now(TZ).replace(microsecond=0)
todo = []
for b in log["batches"]:
    for e in b["entries"]:
        t0 = datetime.datetime.fromisoformat(e["created_at"])
        for h in e.get("horizons_h", [24, 72, 168]):
            if now >= t0 + datetime.timedelta(hours=h) and (e["id"], h) not in done:
                todo.append((b, e, h))
if not todo:
    print("nothing due")
    raise SystemExit(0)

need_dex = collections.defaultdict(set)  # chain -> pair addresses
need_bn = set()
for b, e, h in todo:
    if is_binance(e.get("chain"), e.get("pair_address")):
        need_bn.add(e["pair_address"].upper())
    else:
        need_dex[e["chain"]].add(e["pair_address"])
    # SOL benchmark (prefer SOL key; fall back)
    bm = (b.get("benchmarks") or {})
    for key in ("BTC", "SOL"):
        sol = bm.get(key) or {}
        if not sol:
            continue
        if is_binance(sol.get("chain"), sol.get("pair_address")):
            need_bn.add(sol["pair_address"].upper())
        else:
            need_dex[sol["chain"]].add(sol["pair_address"])

cache_dex = {}
for ch, ps in need_dex.items():
    cache_dex.update(dex_pair_prices(ch, sorted(ps)))
cache_bn = bn_tickers(sorted(need_bn)) if need_bn else {}

def bm_ret(b, cache_dex, cache_bn, key):
    sol = ((b.get("benchmarks") or {}).get(key)) or {}
    if not sol:
        return None
    sq = live_quote(sol.get("chain"), sol.get("pair_address"), cache_dex, cache_bn)
    if sq and sol.get("price_usd"):
        try:
            return round((float(sq["price_usd"]) / float(sol["price_usd"]) - 1) * 100, 2)
        except (TypeError, ValueError, ZeroDivisionError):
            return None
    return None

for b, e, h in todo:
    q = live_quote(e.get("chain"), e.get("pair_address"), cache_dex, cache_bn)
    liq = (q or {}).get("liquidity_usd") or 0
    dead = not q or liq < 1000
    price = 0.0 if dead else float(q["price_usd"])
    entry = float(e["entry_price_usd"])
    btc_ret = bm_ret(b, cache_dex, cache_bn, "BTC")
    sol_ret = bm_ret(b, cache_dex, cache_bn, "SOL")
    if btc_ret is None:
        btc_ret = sol_ret  # legacy alias
    rec = {
        "pick_id": e["id"],
        "horizon_h": h,
        "observed_at": now.isoformat(),
        "price_usd": price,
        "liquidity_usd": liq,
        "status": "dead" if dead else "live",
        "return_pct": -100.0 if dead else round((price / entry - 1) * 100, 2),
        "btc_return_pct": btc_ret,
        "sol_return_pct": sol_ret if sol_ret is not None else btc_ret,
    }
    out["records"].append(rec)
    print("recorded", e["id"], f"{h}h", rec["return_pct"], rec["status"], (q or {}).get("source"))

tmp = OUT + ".tmp"
json.dump(out, open(tmp, "w"), indent=1)
os.replace(tmp, OUT)
