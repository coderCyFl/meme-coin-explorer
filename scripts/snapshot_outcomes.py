#!/usr/bin/env python3
"""Record horizon outcomes for picks (append-only). Run on a schedule, e.g. hourly.

For each entry in data/picks.json and each horizon (24h/72h/168h) that has passed and
has no recorded outcome yet, fetch the current price and append a record to
data/outcomes.json.

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

Exit-aware paper return (primary `return_pct`):
- When the pick has stop_loss_pct / take_profit_pct (and/or stop_price_usd /
  target_price_usd), paper P&L respects first-touch of stop or TP inside the
  hold window (entry → min(due, sell_by) when sell_by is set).
- Binance: walk 5m klines high/low for first touch. Same-bar both-hit → stop
  first (conservative). If kline path fetch fails, fall back to EOD-clip:
  if EOD return ≤ −stop → mark at −stop; if ≥ TP → mark at +TP; else hold EOD.
- Dex / no exit fields: hold to horizon (EOD only); note exit_method accordingly.
- Raw mark-to-market at horizon close is always kept as `return_pct_eod`.
- `exit_reason`: stop | take_profit | hold_horizon | hold_sell_by | dead | none
- `exit_method`: path_5m | eod_clip | none

Flags:
  --reseal-binance BATCH_ID[,BATCH_ID]  drop then re-seal those batches' binance rows
  --backfill-exits  recompute exit fields on existing sealed records (keeps EOD price;
                    rewrites return_pct from return_pct_eod + pick exit plan + optional path)
"""
import json, os, sys, datetime, urllib.request, collections, urllib.error, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PICKS = os.path.join(ROOT, "data", "picks.json")
OUT = os.path.join(ROOT, "data", "outcomes.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
UA = {"User-Agent": "meme-coin-explorer/1.0"}
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
    res = {}
    for sym in symbols:
        sym = sym.upper()
        try:
            d = get(f"{BN_BASE}/api/v3/ticker/24hr?symbol={sym}")
        except urllib.error.HTTPError as e:
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
            "liquidity_usd": qv,
            "source": "binance-24hr",
        }
    return res


_kline_cache = {}
_path_cache = {}


def bn_kline_close(sym, due):
    """Close of the Binance 1m kline for the minute containing `due` (aware datetime)."""
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
            continue
        if not isinstance(d, list):
            continue
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


def bn_klines_range(sym, start, end, interval="5m"):
    """Fetch OHLCV bars from start..end (aware). Returns list of
    {t_open_ms, o,h,l,c, t_close_ms} or None on total failure."""
    sym = sym.upper()
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    if end_ms <= start_ms:
        return []
    key = (sym, start_ms, end_ms, interval)
    if key in _path_cache:
        return _path_cache[key]
    # Binance limit 1000; 5m × 1000 ≈ 3.47d — enough for 24/72h; 168h needs paging.
    bars = []
    cursor = start_ms
    ok = False
    while cursor < end_ms:
        chunk = None
        for base in BN_KLINE_BASES:
            url = (
                f"{base}/api/v3/klines?symbol={sym}&interval={interval}"
                f"&startTime={cursor}&endTime={end_ms}&limit=1000"
            )
            try:
                d = get(url)
            except Exception:
                continue
            if isinstance(d, list):
                chunk = d
                ok = True
                break
        if not ok or chunk is None:
            _path_cache[key] = None
            return None
        if not chunk:
            break
        for k in chunk:
            bars.append(
                {
                    "t_open_ms": int(k[0]),
                    "o": float(k[1]),
                    "h": float(k[2]),
                    "l": float(k[3]),
                    "c": float(k[4]),
                    "t_close_ms": int(k[6]),
                }
            )
        last_open = int(chunk[-1][0])
        # advance past last bar
        step = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000}.get(interval, 300_000)
        nxt = last_open + step
        if nxt <= cursor:
            break
        cursor = nxt
        if len(chunk) < 1000:
            break
        time.sleep(0.05)
    _path_cache[key] = bars
    return bars


def pick_exit_levels(e):
    """Return (stop_pct, tp_pct, stop_px, tp_px) or Nones. pcts are positive magnitudes."""
    entry = float(e.get("entry_price_usd") or 0)
    if entry <= 0:
        return None, None, None, None
    sl = e.get("stop_loss_pct")
    tp = e.get("take_profit_pct")
    try:
        sl = float(sl) if sl is not None else None
    except (TypeError, ValueError):
        sl = None
    try:
        tp = float(tp) if tp is not None else None
    except (TypeError, ValueError):
        tp = None
    stop_px = e.get("stop_price_usd")
    tp_px = e.get("target_price_usd")
    try:
        stop_px = float(stop_px) if stop_px is not None else None
    except (TypeError, ValueError):
        stop_px = None
    try:
        tp_px = float(tp_px) if tp_px is not None else None
    except (TypeError, ValueError):
        tp_px = None
    if stop_px is None and sl is not None and sl > 0:
        stop_px = entry * (1 - sl / 100.0)
    if tp_px is None and tp is not None and tp > 0:
        tp_px = entry * (1 + tp / 100.0)
    if sl is None and stop_px is not None and stop_px < entry:
        sl = (1 - stop_px / entry) * 100.0
    if tp is None and tp_px is not None and tp_px > entry:
        tp = (tp_px / entry - 1) * 100.0
    return sl, tp, stop_px, tp_px


def hold_end(e, due):
    """End of exit-check window: min(due, sell_by) when sell_by parses."""
    end = due
    sb = e.get("sell_by")
    if sb:
        try:
            t = datetime.datetime.fromisoformat(sb)
            if t.tzinfo is None:
                t = t.replace(tzinfo=TZ)
            if t < end:
                end = t
        except (TypeError, ValueError):
            pass
    return end


def apply_exit_path(entry, sl, tp, stop_px, tp_px, bars):
    """First-touch walk. Same bar both → stop. Returns (ret_pct, reason, exit_px, method) or None."""
    if not bars or (stop_px is None and tp_px is None):
        return None
    for b in bars:
        hit_sl = stop_px is not None and b["l"] <= stop_px
        hit_tp = tp_px is not None and b["h"] >= tp_px
        if hit_sl and hit_tp:
            # Conservative: stop first when both print in one bar
            ret = -abs(sl) if sl is not None else round((stop_px / entry - 1) * 100, 2)
            return round(ret, 2), "stop", stop_px, "path_5m"
        if hit_sl:
            ret = -abs(sl) if sl is not None else round((stop_px / entry - 1) * 100, 2)
            return round(ret, 2), "stop", stop_px, "path_5m"
        if hit_tp:
            ret = abs(tp) if tp is not None else round((tp_px / entry - 1) * 100, 2)
            return round(ret, 2), "take_profit", tp_px, "path_5m"
    return None


def apply_exit_eod_clip(eod_ret, sl, tp):
    """EOD approximation when path unavailable. Returns (ret, reason, method)."""
    if sl is None and tp is None:
        return eod_ret, "hold_horizon", "none"
    if sl is not None and eod_ret <= -abs(sl):
        return round(-abs(sl), 2), "stop", "eod_clip"
    if tp is not None and eod_ret >= abs(tp):
        return round(abs(tp), 2), "take_profit", "eod_clip"
    return eod_ret, "hold_horizon", "eod_clip"


def resolve_exit(e, entry, eod_price, eod_ret, due, dead, want_path=True):
    """Compute exit-aware return fields for one seal."""
    if dead:
        return {
            "return_pct": -100.0,
            "return_pct_eod": -100.0,
            "exit_reason": "dead",
            "exit_method": "none",
            "exit_price_usd": 0.0,
        }
    sl, tp, stop_px, tp_px = pick_exit_levels(e)
    eod_ret = round(eod_ret, 2)
    out = {
        "return_pct_eod": eod_ret,
        "return_pct": eod_ret,
        "exit_reason": "hold_horizon",
        "exit_method": "none",
        "exit_price_usd": eod_price,
    }
    if sl is None and tp is None:
        return out

    path_hit = None
    if want_path and is_binance(e.get("chain"), e.get("pair_address")):
        t0 = datetime.datetime.fromisoformat(e["created_at"])
        end = hold_end(e, due)
        bars = bn_klines_range(e["pair_address"], t0, end, interval="5m")
        if bars is not None:
            path_hit = apply_exit_path(entry, sl, tp, stop_px, tp_px, bars)
        # bars is None → fetch failed; fall through to EOD clip

    if path_hit is not None:
        ret, reason, exit_px, method = path_hit
        out["return_pct"] = ret
        out["exit_reason"] = reason
        out["exit_method"] = method
        out["exit_price_usd"] = exit_px
        # sell_by earlier than horizon and no path hit already handled by shorter window
        if reason == "hold_horizon" and e.get("sell_by"):
            out["exit_reason"] = "hold_sell_by"
        return out

    # EOD clip (Dex, or Binance path unavailable / no touch)
    ret, reason, method = apply_exit_eod_clip(eod_ret, sl, tp)
    out["return_pct"] = ret
    out["exit_reason"] = reason
    out["exit_method"] = method
    if reason == "stop" and stop_px is not None:
        out["exit_price_usd"] = stop_px
    elif reason == "take_profit" and tp_px is not None:
        out["exit_price_usd"] = tp_px
    else:
        out["exit_price_usd"] = eod_price
        if e.get("sell_by") and due and hold_end(e, due) < due and reason == "hold_horizon":
            out["exit_reason"] = "hold_sell_by"
    return out


def live_quote(chain, pair_address, cache_dex, cache_bn):
    if is_binance(chain, pair_address):
        return cache_bn.get(pair_address.upper())
    q = cache_dex.get(pair_address) or cache_dex.get(pair_address.lower())
    return q


def pick_index(log):
    idx = {}
    for b in log["batches"]:
        for e in b["entries"]:
            idx[e["id"]] = (b, e)
    return idx


def backfill_exits(log, out):
    """Recompute exit-aware fields on existing records. Preserves EOD price/return_pct_eod."""
    idx = pick_index(log)
    n = 0
    for rec in out["records"]:
        pe = idx.get(rec["pick_id"])
        if not pe:
            continue
        b, e = pe
        if rec.get("status") == "dead":
            rec["return_pct_eod"] = rec.get("return_pct_eod", rec.get("return_pct", -100.0))
            rec["return_pct"] = -100.0
            rec["exit_reason"] = "dead"
            rec["exit_method"] = "none"
            rec["exit_price_usd"] = rec.get("exit_price_usd", 0.0)
            n += 1
            continue
        entry = float(e["entry_price_usd"])
        eod_price = float(rec.get("price_usd") or 0)
        if rec.get("return_pct_eod") is not None:
            eod_ret = float(rec["return_pct_eod"])
        else:
            # Legacy seal: current return_pct IS the EOD mark
            eod_ret = float(rec.get("return_pct") or 0)
        due = None
        if rec.get("due_at"):
            try:
                due = datetime.datetime.fromisoformat(rec["due_at"])
            except ValueError:
                due = None
        if due is None:
            due = datetime.datetime.fromisoformat(e["created_at"]) + datetime.timedelta(
                hours=int(rec.get("horizon_h") or 24)
            )
        fields = resolve_exit(e, entry, eod_price, eod_ret, due, dead=False, want_path=True)
        rec.update(fields)
        n += 1
        print(
            "backfill",
            rec["pick_id"],
            f"{rec.get('horizon_h')}h",
            "eod",
            fields["return_pct_eod"],
            "→",
            fields["return_pct"],
            fields["exit_reason"],
            fields["exit_method"],
        )
    return n


log = json.load(open(PICKS))
out = (
    json.load(open(OUT))
    if os.path.exists(OUT)
    else {"description": "Append-only horizon snapshots. Never edit.", "records": []}
)

if "--backfill-exits" in sys.argv:
    n = backfill_exits(log, out)
    tmp = OUT + ".tmp"
    json.dump(out, open(tmp, "w"), indent=1)
    os.replace(tmp, OUT)
    print(f"backfill-exits: updated {n} records → {OUT}")
    raise SystemExit(0)

reseal = set()
if "--reseal-binance" in sys.argv:
    reseal = set(sys.argv[sys.argv.index("--reseal-binance") + 1].split(","))
    ids = {
        e["id"]
        for b in log["batches"]
        if b["id"] in reseal
        for e in b["entries"]
        if is_binance(e.get("chain"), e.get("pair_address"))
    }
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
            if now >= t0 + datetime.timedelta(hours=h, minutes=1) and (e["id"], h) not in done:
                todo.append((b, e, h))
if not todo:
    print("nothing due")
    raise SystemExit(0)

need_dex = collections.defaultdict(set)
need_bn = set()
for b, e, h in todo:
    if is_binance(e.get("chain"), e.get("pair_address")):
        need_bn.add(e["pair_address"].upper())
    else:
        need_dex[e["chain"]].add(e["pair_address"])
    bm = b.get("benchmarks") or {}
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
    eod_ret = -100.0 if dead else (price / entry - 1) * 100
    btc_ret = bm_ret(b, cache_dex, cache_bn, "BTC", due)
    sol_ret = bm_ret(b, cache_dex, cache_bn, "SOL", due)
    if btc_ret is None:
        btc_ret = sol_ret
    if due is None:
        due = datetime.datetime.fromisoformat(e["created_at"]) + datetime.timedelta(hours=h)
    exit_fields = resolve_exit(e, entry, price, eod_ret, due, dead, want_path=True)
    rec = {
        "pick_id": e["id"],
        "horizon_h": h,
        "observed_at": observed_at,
        "price_usd": price,
        "liquidity_usd": liq,
        "status": "dead" if dead else "live",
        "return_pct": exit_fields["return_pct"],
        "return_pct_eod": exit_fields["return_pct_eod"],
        "exit_reason": exit_fields["exit_reason"],
        "exit_method": exit_fields["exit_method"],
        "exit_price_usd": exit_fields["exit_price_usd"],
        "btc_return_pct": btc_ret,
        "sol_return_pct": sol_ret if sol_ret is not None else btc_ret,
    }
    if is_binance(e.get("chain"), e.get("pair_address")):
        rec["due_at"] = due.isoformat()
        rec["price_source"] = "kline_1m_due" if not dead else "binance-24hr"
        rec["sealed_run_at"] = now.isoformat()
    out["records"].append(rec)
    print(
        "recorded",
        e["id"],
        f"{h}h",
        "exit",
        rec["return_pct"],
        "eod",
        rec["return_pct_eod"],
        rec["exit_reason"],
        rec["exit_method"],
        rec["status"],
        src,
        rec["observed_at"],
    )

tmp = OUT + ".tmp"
json.dump(out, open(tmp, "w"), indent=1)
os.replace(tmp, OUT)
