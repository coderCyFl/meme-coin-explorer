#!/usr/bin/env python3
"""Dry-run early-capture recall vs sealed Binance top-20 (daily_vs_gainers).

Measures first-fire EARLY (c24 < 15 at signal bar) for:
  - current early2 legs (start / prec / thin) individually and union
  - candidate looser grind precursor (prec_e) param grid
  - denser-snapshot proxy: fire detected within N minutes of bar close
    (Actions cadence; denser cron reduces miss risk but full-scan dry-run
     already sees every closed 15m bar)

Usage:
  python3 scripts/dryrun_precursor.py [--dates 2026-10-25,2026-10-29] [--cache DIR]
"""
from __future__ import annotations
import argparse, datetime, json, os, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CARD = os.path.join(ROOT, "data", "gainer_board", "daily_vs_gainers")
TZ = datetime.timezone(datetime.timedelta(hours=8))
Q = 900_000  # 15m ms
EARLY_C24 = 15.0


def day_bounds(date: str):
    d = datetime.datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=TZ)
    start = d  # 00:00 HKT
    end = d + datetime.timedelta(days=1) - datetime.timedelta(minutes=5)  # ~23:55
    # need ~120 bars lookback before day start
    fetch_start = int((start - datetime.timedelta(hours=30)).timestamp() * 1000)
    fetch_end = int(end.timestamp() * 1000)
    day_start_ms = int(start.timestamp() * 1000)
    day_end_ms = fetch_end
    return fetch_start, fetch_end, day_start_ms, day_end_ms


def fetch15(sym: str, start_ms: int, end_ms: int, cache: str):
    fn = os.path.join(cache, f"{sym}_{start_ms}_{end_ms}.json")
    if os.path.exists(fn):
        return json.load(open(fn))
    bars, s = [], start_ms
    while s < end_ms:
        d = g.get("/api/v3/klines", {"symbol": sym, "interval": "15m", "limit": 1000, "startTime": s, "endTime": end_ms})
        if not d:
            break
        bars += [[b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[7])] for b in d]
        s = d[-1][0] + Q
        if len(d) < 1000:
            break
        time.sleep(0.08)
    os.makedirs(cache, exist_ok=True)
    json.dump(bars, open(fn, "w"))
    time.sleep(0.05)
    return bars


def first_fire(b15, day_start_ms, day_end_ms, leg_fn):
    """Return (j, leg, c24, t_ms, price) for first EARLY fire on the Shanghai day, or None."""
    n = len(b15)
    for j in range(115, n):
        # only closed bars whose close falls inside the day window
        close_t = b15[j][0] + 15 * 60_000
        if close_t < day_start_ms:
            continue
        if close_t > day_end_ms:
            break
        leg = leg_fn(b15, j)
        if not leg:
            continue
        sf = g.early2_feats(b15, j) if hasattr(g, "early2_feats") else g.surge_feats(b15, j)
        c24 = sf.get("c24")
        if c24 is None:
            c24 = (b15[j][4] / b15[j - 96][4] - 1) * 100 if j >= 96 and b15[j - 96][4] > 0 else 0
        if c24 >= EARLY_C24:
            continue  # LATE — not an early capture
        # suppress if 🔥 in last 4h (same as early2_at) — caller may already include this
        return {"j": j, "leg": leg, "c24": round(c24, 2), "t": close_t, "p": b15[j][4]}
    return None


def make_prec_e(c1, vr, c24_max, require_not_surge=True):
    """Looser grind precursor: modest 1h grind + volume creep, not yet 🔥."""
    def leg(b15, j):
        if j < 115:
            return None
        for k in range(j - 16, j + 1):
            if g.surge_fire(g.surge_feats(b15, k)):
                return None
        sf = g.early2_feats(b15, j)
        if sf["qv24"] < g.MIN_QV24:
            return None
        if require_not_surge and not (sf["c15"] < g.SURGE_C15 and sf["c1"] < g.SURGE_C1):
            return None
        if sf["c1"] >= c1 and sf["vr"] >= vr and sf["c24"] < c24_max:
            return "prec_e"
        return None
    return leg


def early2_shipped_leg(want=None):
    """want=None → any early2 leg; or 'start'|'prec'|'thin'."""
    def leg(b15, j):
        v = g.early2_at(b15, j)
        if not v:
            return None
        if want is None or v == want:
            return v
        return None
    return leg


def union_legs(*fns):
    def leg(b15, j):
        for fn in fns:
            v = fn(b15, j)
            if v:
                return v
        return None
    return leg


GRID = [
    # (name, c1, vr, c24_max) — looser grind candidates
    ("prec_e_1.5_2.0_15", 1.5, 2.0, 15.0),
    ("prec_e_1.5_1.5_15", 1.5, 1.5, 15.0),
    ("prec_e_2.0_2.0_15", 2.0, 2.0, 15.0),
    ("prec_e_1.0_2.0_15", 1.0, 2.0, 15.0),
    ("prec_e_1.5_2.0_12", 1.5, 2.0, 12.0),
    ("prec_e_2.0_1.5_15", 2.0, 1.5, 15.0),
    ("prec_e_1.0_1.5_15", 1.0, 1.5, 15.0),
    ("prec_e_2.5_2.0_15", 2.5, 2.0, 15.0),  # current-ish but looser vr + c24
    ("prec_e_2.0_2.5_15", 2.0, 2.5, 15.0),
    ("prec_shipped", 2.5, 2.5, 12.0),  # current prec alone
]


def load_days(dates):
    out = []
    for d in dates:
        fn = os.path.join(CARD, d + ".json")
        if not os.path.exists(fn):
            print("missing scorecard", fn, file=sys.stderr)
            continue
        out.append(json.load(open(fn)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates", default="2026-10-25:2026-10-29")
    ap.add_argument("--cache", default="/workspace/precursor-dryrun-cache")
    ap.add_argument("--pick", default="", help="If set, only evaluate this named grid row + shipped early2")
    args = ap.parse_args()
    if ":" in args.dates:
        a, b = args.dates.split(":")
        start = datetime.datetime.strptime(a, "%Y-%m-%d").date()
        end = datetime.datetime.strptime(b, "%Y-%m-%d").date()
        dates = []
        cur = start
        while cur <= end:
            dates.append(cur.isoformat())
            cur += datetime.timedelta(days=1)
    else:
        dates = [x.strip() for x in args.dates.split(",") if x.strip()]

    cards = load_days(dates)
    # Build rule set
    rules = {
        "e2_start": early2_shipped_leg("start"),
        "e2_prec": early2_shipped_leg("prec"),
        "e2_thin": early2_shipped_leg("thin"),
        "e2_all": early2_shipped_leg(None),
    }
    for name, c1, vr, c24m in GRID:
        rules[name] = make_prec_e(c1, vr, c24m)

    # Also: shipped early2 UNION each prec_e (what we'd ship)
    for name, c1, vr, c24m in GRID:
        if name == "prec_shipped":
            continue
        rules[f"e2+{name}"] = union_legs(early2_shipped_leg(None), make_prec_e(c1, vr, c24m))

    if args.pick:
        rules = {k: v for k, v in rules.items() if k == args.pick or k.startswith("e2_") or k == f"e2+{args.pick}"}

    # Preload bars per (date, pair)
    day_data = []
    for card in cards:
        date = card["date"]
        fs, fe, ds, de = day_bounds(date)
        pairs = []
        for t in card["top20"]:
            sym = t["symbol"]
            pair = sym + "USDT" if not sym.endswith("USDT") else sym
            # Chinese / odd symbols: scorecard stores base without USDT
            if not pair.endswith("USDT"):
                pair = sym + "USDT"
            pairs.append({"symbol": sym, "pair": pair, "rank": t["rank"], "chg24": t["change_24h"]})
        print(f"fetch {date} top20…", flush=True)
        bars_map = {}
        for p in pairs:
            try:
                bars_map[p["pair"]] = fetch15(p["pair"], fs, fe, args.cache)
            except Exception as e:  # noqa: BLE001
                print("  fail", p["pair"], e, file=sys.stderr)
                bars_map[p["pair"]] = []
        day_data.append({"date": date, "pairs": pairs, "bars": bars_map, "ds": ds, "de": de,
                         "live_recall": card.get("recall_top20_pct"), "live_prec": card.get("precision_pct"),
                         "live_early_hits": card.get("early_hits"), "live_early_flagged": card.get("early_flagged")})

    # Evaluate
    results = {name: {"per_day": {}, "caught": 0, "n": 0, "fires_est": 0} for name in rules}
    detail = {name: {} for name in rules}

    for dd in day_data:
        for name, fn in rules.items():
            caught_syms = []
            for p in dd["pairs"]:
                b = dd["bars"].get(p["pair"]) or []
                if len(b) < 116:
                    continue
                hit = first_fire(b, dd["ds"], dd["de"], fn)
                if hit:
                    caught_syms.append({"symbol": p["symbol"], "rank": p["rank"], **{k: hit[k] for k in ("leg", "c24", "t")}})
            n = len(dd["pairs"])
            results[name]["per_day"][dd["date"]] = {
                "caught": len(caught_syms), "n": n,
                "recall_pct": round(len(caught_syms) / n * 100, 1) if n else None,
                "syms": [s["symbol"] for s in caught_syms],
            }
            results[name]["caught"] += len(caught_syms)
            results[name]["n"] += n
            detail[name][dd["date"]] = caught_syms

    # Aggregate + pick best prec_e alone near 55%
    print("\n=== AGGREGATE (early recall vs sealed top-20) ===")
    rows = []
    for name, r in results.items():
        rec = round(r["caught"] / r["n"] * 100, 1) if r["n"] else None
        rows.append((name, rec, r["caught"], r["n"], r["per_day"]))
        print(f"{name:28s}  recall {rec}%  ({r['caught']}/{r['n']})")
        for d, pd in r["per_day"].items():
            print(f"  {d}: {pd['caught']}/{pd['n']} = {pd['recall_pct']}%  {pd['syms']}")

    # Recommend: prec_e alone closest to 55% without going absurdly loose on fires
    alone = [(n, rec, c, tot, pd) for n, rec, c, tot, pd in rows if n.startswith("prec_e_")]
    alone.sort(key=lambda x: (abs((x[1] or 0) - 55), -(x[1] or 0)))
    print("\n=== closest prec_e alone to 55% ===")
    for x in alone[:5]:
        print(x[0], x[1], f"{x[2]}/{x[3]}")

    out = {
        "generated_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "window": dates,
        "method": "full-scan closed 15m bars on sealed top-20; EARLY = c24<15 at first fire; 🔥-suppressed",
        "live_scorecard": [{k: dd[k] for k in ("date", "live_recall", "live_prec", "live_early_hits", "live_early_flagged")} for dd in day_data],
        "aggregate": {n: {"recall_pct": round(r["caught"] / r["n"] * 100, 1) if r["n"] else None,
                          "caught": r["caught"], "n": r["n"], "per_day": r["per_day"]} for n, r in results.items()},
        "recommend_prec_e": alone[0][0] if alone else None,
    }
    out_path = "/workspace/precursor-dryrun-raw.json"
    json.dump(out, open(out_path, "w"), ensure_ascii=False, indent=2)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
