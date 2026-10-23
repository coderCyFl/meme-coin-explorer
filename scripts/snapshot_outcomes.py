#!/usr/bin/env python3
"""Record horizon outcomes for picks (append-only). Run on a schedule, e.g. hourly.

For each entry in data/picks.json and each horizon (24h/72h/168h) that has passed and
has no recorded outcome yet, fetch the current price and append
{pick_id, horizon_h, observed_at, price_usd, liquidity_usd, status, return_pct, sol_return_pct}
to data/outcomes.json.

Pricing:
- chain "binance" (pair_address like TRUMPUSDT): Binance public REST. The horizon price is
  the CLOSE of the 1m kline for the minute containing the due time (created_at + h), so a
  late run still records the price AT the due time, not the run-time spot price.
  observed_at = that kline's close time; price_source = "kline_1m_due". Benchmarks
  (BTC/SOL) use the same due-minute kline. data-api.binance.vision first, then
  api.binance.com if the mirror fails. Liveness (dead/delisted) still uses the 24hr
  ticker: missing symbol or quoteVolume < $1k → status "dead".
- other chains (legacy Dex / Solana batch-001): DexScreener pairs API. Missing pair
  or liquidity < $1k → status "dead".

Dex (legacy) picks have no historical endpoint: they use run-time spot price, so for those
observed_at tells you how late. Existing records are never changed (use --reseal-binance
BATCH_ID[,BATCH_ID] to rewrite that batch's binance records with the kline method).
"""
import json, os, sys, datetime, urllib.request, collections, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PICKS = os.path.join(ROOT, "data", "picks.json")
OUT = os.path.join(ROOT, "data", "outcomes.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
UA = {"User-Agent": "meme-coin-explorer/1.0"}
# Prefer vision mirror — api.binance.com is geo-blocked in some regions (incl. GH Actions
# can vary). Same public market data, no key.
BN_BASE = "https://data-api.binance.vision"
BN_KLINE_BASES = ("https://data-api.binance.vision", "https://api.binance.com")


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


_kline_cache = {}


def bn_kline_close(sym, due):
    """Close of the Binance 1m kline for the minute containing `due` (aware datetime).
    Returns {price_usd, observed_at, open_ms} or None (symbol missing / no kline yet)."""
    sym = sym.upper()
    minute_ms = int(due.timestamp() * 1000) // 60000 * 60000
    key = (sym, minute_ms)
    if key in _kline_cache:
        return _kline_cache[key]
    res = None
    for base in BN_KLINE_BASES:
        url = f"{base}/api/v3/klines?symbol={sym}&interval=1m&startTime={minute_ms}&limit=1"
        try:
            d = get(url)
        except Exception:
            continue  # geo-block (451/403) or network → try mirror
        if not isinstance(d, list):
            continue  # e.g. {"code":0,"msg":"restricted location"}
        if d and int(d[0][0]) == minute_ms:
            k = d[0]
            close_ms = int(k[6])
            res = {
                "price_usd": float(k[4]),
                "observed_at": datetime.datetime.fromtimestamp(close_ms // 1000, TZ).isoformat(),
                "open_ms": minute_ms,
                "source": "kline_1m_due",
            }
        break
    _kline_cache[key] = res
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
reseal = set()
if "--reseal-binance" in sys.argv:
    reseal = set(sys.argv[sys.argv.index("--reseal-binance") + 1].split(","))
    ids = {e["id"] for b in log["batches"] if b["id"] in reseal for e in b["entries"]
           if is_binance(e.get("chain"), e.get("pair_address"))}
    before = len(out["records"])
    out["records"] = [r for r in out["records"] if r["pick_id"] not in ids]
    print(f"reseal {sorted(reseal)}: dropped {before - len(out['records'])} old records")
done = {(r["pick_id"], r["horizon_h"]) for r in out["records"]}
now = datetime.datetime.now(TZ).replace(microsecond=0)
todo = []
for b in log["batches"]:
    for e in b["entries"]:
        t0 = datetime.datetime.fromisoformat(e["created_at"])
        for h in e.get("horizons_h", [24, 72, 168]):
            # +1 min so the due-minute kline is closed before we seal from it
            if now >= t0 + datetime.timedelta(hours=h, minutes=1) and (e["id"], h) not in done:
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

def bm_ret(b, cache_dex, cache_bn, key, due=None):
    sol = ((b.get("benchmarks") or {}).get(key)) or {}
    if not sol:
        return None
    sq = None
    if due is not None and is_binance(sol.get("chain"), sol.get("pair_address")):
        sq = bn_kline_close(sol["pair_address"], due)
    if sq is None:
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
    observed_at = now.isoformat()
    src = (q or {}).get("source")
    due = None
    if is_binance(e.get("chain"), e.get("pair_address")):
        due = datetime.datetime.fromisoformat(e["created_at"]) + datetime.timedelta(hours=h)
        if not dead:
            kq = bn_kline_close(e["pair_address"], due)
            if kq is None:
                print("skip (no due kline yet)", e["id"], f"{h}h")
                continue
            q = dict(q, price_usd=kq["price_usd"])
            observed_at = kq["observed_at"]
            src = kq["source"]
    price = 0.0 if dead else float(q["price_usd"])
    entry = float(e["entry_price_usd"])
    btc_ret = bm_ret(b, cache_dex, cache_bn, "BTC", due)
    sol_ret = bm_ret(b, cache_dex, cache_bn, "SOL", due)
    if btc_ret is None:
        btc_ret = sol_ret  # legacy alias
    rec = {
        "pick_id": e["id"],
        "horizon_h": h,
        "observed_at": observed_at,
        "price_usd": price,
        "liquidity_usd": liq,
        "status": "dead" if dead else "live",
        "return_pct": -100.0 if dead else round((price / entry - 1) * 100, 2),
        "btc_return_pct": btc_ret,
        "sol_return_pct": sol_ret if sol_ret is not None else btc_ret,
    }
    if due is not None:
        rec["due_at"] = due.isoformat()
        rec["price_source"] = "kline_1m_due" if not dead else "binance-24hr"
        rec["sealed_run_at"] = now.isoformat()
    out["records"].append(rec)
    print("recorded", e["id"], f"{h}h", rec["return_pct"], rec["status"], src, rec["observed_at"])

tmp = OUT + ".tmp"
json.dump(out, open(tmp, "w"), indent=1)
os.replace(tmp, OUT)
