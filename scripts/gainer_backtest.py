#!/usr/bin/env python3
"""30-day all-coins backtest for the 急升榜 tiers (🔥 pump / ⚡ early) → data/gainer_board/backtest_30d.json

Universe = every TRADING Binance USDT spot pair (stables / leveraged tokens excluded), same as the live
board; the $3M rolling-24h quote-volume floor is applied AT SIGNAL TIME (no today-volume selection bias).
One 1h-kline request per symbol (limit 1000 ≈ 41d), throttled. Signals evaluated on closed 1h bars over the
last 30 days; entry = that bar's close; outcome over the next 4 bars (4h). Same symbol+tier cooldown 4h.
Train = first 15 days, test = last 15 days. Rules are frozen in gainer_core.py.

Usage: python3 scripts/gainer_backtest.py [--cache DIR]   (DIR holds SYMBOL.json kline dumps)
"""
import argparse, datetime, json, os, statistics as st, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "data", "gainer_board", "backtest_30d.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
H = 4

CANDIDATES = {
    "naive (QA 起點) vr>=2 & 1h>=+3%": lambda f: f["vr"] >= 2 and f["c1"] >= 3,
    "accumulation vr>=2.5 & |1h|<2% & 24h<5%": lambda f: f["vr"] >= 2.5 and abs(f["c1"]) < 2 and f["c24"] < 5,
    "breakout72h & vr>=2 & wick<0.3 & 24h<15%": lambda f: f["brk72"] > 0 and f["vr"] >= 2 and f["wick"] < 0.3 and f["c24"] < 15,
    "breakout72h ... + BTC24h>=0": lambda f: f["brk72"] > 0 and f["vr"] >= 2 and f["wick"] < 0.3 and f["c24"] < 15 and f.get("btc24", 0) >= 0,
    "vol build 3h & 1h 0..5% & 24h<10%": lambda f: f["vr"] >= 1.5 and f["vr1"] >= 1.5 and f["vr2"] >= 1.5 and 0 <= f["c1"] < 5 and f["c24"] < 10,
    "pump alt 24h>=15% & from-high>=-10%": lambda f: f["c24"] >= 15 and f["fh"] >= -10,
    "pump alt 24h>=30%": lambda f: f["c24"] >= 30,
}


def load_bars(sym, cache):
    if cache:
        fn = os.path.join(cache, sym + ".json")
        if os.path.exists(fn):
            return json.load(open(fn))
    bars = g.klines(sym, "1h", 1000)
    time.sleep(0.1)
    if cache:
        os.makedirs(cache, exist_ok=True)
        json.dump(bars, open(os.path.join(cache, sym + ".json"), "w"))
    return bars


def load_bars15(sym, cache):
    if cache:
        fn = os.path.join(cache, sym + ".json")
        if os.path.exists(fn):
            return json.load(open(fn))
    raise FileNotFoundError(sym + " 15m not cached (run with --cache15 after fetching)")


def stats(fires):
    n = len(fires)
    if not n:
        return {"fires": 0}
    o = [x["o"] for x in fires]
    return {
        "fires": n,
        "hit20_4h_pct": round(sum(x["hit20"] for x in o) / n * 100, 2),
        "hit50_4h_pct": round(sum(x["hit50"] for x in o) / n * 100, 2),
        "closed_up_4h_pct": round(sum(x["close_pct"] > 0 for x in o) / n * 100, 1),
        "mean_close_4h_pct": round(st.mean(x["close_pct"] for x in o), 2),
        "median_close_4h_pct": round(st.median(x["close_pct"] for x in o), 2),
        "median_max_drawdown_4h_pct": round(st.median(x["max_drawdown_pct"] for x in o), 2),
        "dd5_4h_pct": round(sum(x["max_drawdown_pct"] <= -5 for x in o) / n * 100, 1),
        "mean_max_gain_4h_pct": round(st.mean(x["max_gain_pct"] for x in o), 2),
        "mean_exit_tp20_sl7_pct": round(st.mean(x["tp20sl7"] for x in fires), 2),
        "mean_exit_tp20_sl10_pct": round(st.mean(x["tp20sl10"] for x in fires), 2),
        "mean_exit_tp10_sl5_pct": round(st.mean(x["tp10sl5"] for x in fires), 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--cache15", default=None, help="dir of SYMBOL.json 15m klines (🔥 surge rule)")
    a = ap.parse_args()
    syms = g.universe()
    btc = load_bars("BTCUSDT", a.cache)
    bc = {b[0]: b[4] for b in btc}
    end = btc[-1][0]
    start = end - a.days * 86400000 - H * 3600000
    split = start + (end - start) / 2
    rows = []
    for k, s in enumerate(syms):
        try:
            bars = load_bars(s, a.cache)
        except Exception as e:  # noqa: BLE001
            print("skip", s, e, file=sys.stderr)
            continue
        for i in range(75, len(bars) - H):
            if bars[i][0] < start:
                continue
            f = g.feats(bars, i)
            if f["qv24"] < g.MIN_QV24:
                continue
            x, z = bc.get(bars[i][0]), bc.get(bars[i][0] - 86400000)
            f["btc24"] = (x / z - 1) * 100 if x and z else 0
            e, fut = bars[i][4], bars[i + 1:i + 1 + H]
            f["o"] = g.outcome(e, fut)
            f["tp20sl7"] = g.outcome(e, fut, 0.20, 0.07)["exit_rule_pct"]
            f["tp20sl10"] = g.outcome(e, fut, 0.20, 0.10)["exit_rule_pct"]
            f["tp10sl5"] = g.outcome(e, fut, 0.10, 0.05)["exit_rule_pct"]
            f["s"], f["i"] = s, i
            rows.append(f)
    n_sym = len({r["s"] for r in rows})

    def run(rule, sub=None, cool=g.COOLDOWN_H):
        fires, last = [], {}
        for r in rows:
            if sub == "train" and r["t"] >= split:
                continue
            if sub == "test" and r["t"] < split:
                continue
            if not rule(r):
                continue
            if r["s"] in last and r["i"] - last[r["s"]] < cool:
                continue
            last[r["s"]] = r["i"]
            fires.append(r)
        return fires

    def block(rule):
        return {"train": stats(run(rule, "train")), "test": stats(run(rule, "test")), "all": stats(run(rule))}

    # ---- 🔥 surge rule on 15m bars (rolling 1h / 15m windows), entry = 15m close, 4h = next 16 bars ----
    s_rows, base15 = [], []
    for s in syms:
        try:
            b15 = load_bars15(s, a.cache15)
        except Exception as e:  # noqa: BLE001
            print("skip15", s, e, file=sys.stderr)
            continue
        for j in range(99, len(b15) - 16):
            if b15[j][0] < start or b15[j][0] >= end + 3600000:
                continue
            sf = g.surge_feats(b15, j)
            if sf["qv24"] < g.MIN_QV24:
                continue
            fire = g.surge_fire(sf)
            if not fire and j % 16:
                continue  # keep every 16th bar for the 15m baseline
            e, fut = b15[j][4], b15[j + 1:j + 17]
            sf["o"] = g.outcome(e, fut)
            sf["tp20sl7"] = g.outcome(e, fut, 0.20, 0.07)["exit_rule_pct"]
            sf["tp20sl10"] = g.outcome(e, fut, 0.20, 0.10)["exit_rule_pct"]
            sf["tp10sl5"] = g.outcome(e, fut, 0.10, 0.05)["exit_rule_pct"]
            sf["s"], sf["i"], sf["fire"] = s, j, fire
            sf["via"] = "1h+vol" if (sf["c1"] >= g.SURGE_C1 and sf["vr"] >= g.SURGE_VR) else "15m"
            (s_rows if fire else base15).append(sf)
    s_rows.sort(key=lambda r: (r["s"], r["i"]))

    def run15(sub=None, pred=lambda r: True):
        fires, last = [], {}
        for r in s_rows:
            if sub == "train" and r["t"] >= split:
                continue
            if sub == "test" and r["t"] < split:
                continue
            if not pred(r):
                continue
            if r["s"] in last and r["i"] - last[r["s"]] < g.COOLDOWN_H * 4:
                continue
            last[r["s"]] = r["i"]
            fires.append(r)
        return fires

    tiers = {}
    pb = {"train": stats(run15("train")), "test": stats(run15("test")), "all": stats(run15())}
    pb["by_trigger_all"] = {"1h+vol": stats(run15(None, lambda r: r["via"] == "1h+vol")), "15m only": stats(run15(None, lambda r: r["via"] == "15m"))}
    pb["c24_at_fire_median"] = round(st.median(r["c24"] for r in run15()), 2) if s_rows else None
    pb["rule"] = g.RULE_TEXT["pump"]
    pb["bars"] = "15m"
    te = pb["test"]
    pb["passes_buy_gate"] = bool(te.get("fires") and te["mean_close_4h_pct"] > 0 and te["hit20_4h_pct"] >= 8)
    tiers["pump"] = pb
    leg = block(lambda f: g.RULES["pump_legacy_24h20"](f))
    leg["rule"] = g.RULE_TEXT["pump_legacy_24h20"]
    tiers["pump_legacy_24h20"] = leg
    for t in ("early",):
        rule = lambda f, t=t: g.RULES[t](f)
        b = block(rule)
        te = b["test"]
        b["rule"] = g.RULE_TEXT[t]
        b["passes_buy_gate"] = bool(te.get("fires") and te["mean_close_4h_pct"] > 0 and te["hit20_4h_pct"] >= 8)
        tiers[t] = b
    out = {
        "generated_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "method": ("All TRADING Binance USDT spot pairs (stables/leveraged excluded); rolling 24h quote volume "
                   ">= $3M at signal time; 1h klines; entry = signal bar close; 4h horizon; cooldown 4h per "
                   "symbol+tier; train = first half, test = second half of the window. Exit columns: TP/SL "
                   "checked bar by bar, stop first if both hit in one bar, else 4h close. No fees."),
        "window": {"start": datetime.datetime.fromtimestamp(start / 1000, TZ).isoformat(timespec="minutes"),
                   "split": datetime.datetime.fromtimestamp(split / 1000, TZ).isoformat(timespec="minutes"),
                   "end": datetime.datetime.fromtimestamp(end / 1000, TZ).isoformat(timespec="minutes"),
                   "days": a.days},
        "universe": {"symbols_listed": len(syms), "symbols_with_bars": n_sym, "bar_count": len(rows)},
        "buy_gate": "test-half mean 4h close > 0 AND +20%-in-4h hit-rate >= 8% (≈ clearly above naive 5%)",
        "baseline_every_bar": stats(run(lambda f: True, cool=1)),
        "baseline_15m_every_4h": stats(base15),
        "tiers": tiers,
        "candidates_rejected": {k: block(v) for k, v in CANDIDATES.items()},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: {"all": v["all"], "test": v["test"], "gate": v.get("passes_buy_gate")} for k, v in tiers.items()}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
