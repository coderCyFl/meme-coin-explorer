#!/usr/bin/env python3
"""⚡ early-signal event study + candidate backtest → data/gainer_board/backtest_early_30d.json

Universe = every TRADING Binance USDT spot pair (stables / leveraged / tokenized stocks excluded; same as the live
board). 15m klines (with trade count + taker-buy quote volume) for ~38 days; signals over the same window and
train/test split as backtest_30d.json (train = 2026-09-24 19:00 → 10-09 21:00 Asia/Shanghai, test = after).
Every candidate is evaluated on ALL eligible coins (not just coins that pumped) — no selection bias.

Pump EVENT = a closed 15m bar whose close is followed by a high >= +20% within the next 4h (16 bars); a new event
for the same coin only after the previous event's peak. CAUGHT = rule fired between 2h before the event bar and
the peak, at a price that still left >= +10% to the peak. LEAD vs 🔥 = 🔥 first fire time − rule first fire time
(both on the same event). Fire stats use a 4h per-coin cooldown; outcome = max high / close / min low over the next
4h from the signal bar close; FALSE ALARM = max gain < +10% in 4h. No fees. Needs numpy (offline tool only).

Usage: python3 scripts/gainer_early_backtest.py --cache15 DIR [--days 38]
"""
import argparse, datetime, json, os, statistics as st, sys, time
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as sw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "data", "gainer_board", "backtest_early_30d.json")
TZ = datetime.timezone(datetime.timedelta(hours=8))
Q = 900000
START = int(datetime.datetime(2026, 9, 24, 19, 0, tzinfo=TZ).timestamp() * 1000)   # = backtest_30d.json window
SPLIT = int(datetime.datetime(2026, 10, 9, 21, 0, tzinfo=TZ).timestamp() * 1000)
FLOOR = g.MIN_QV24
NAMED = ["BMTUSDT", "EPICUSDT", "ANIMEUSDT", "GTCUSDT"]
SHIPPED = "S ⚡v2 = E3b 起步 ∪ E5 細盤🔥($2–3M) · 近4h已🔥唔報"


def iso(t):
    return datetime.datetime.fromtimestamp(t / 1000, TZ).isoformat(timespec="minutes")


def fetch15(sym, days, cache):
    fn = os.path.join(cache, sym + ".json")
    if os.path.exists(fn):
        return json.load(open(fn))
    end = int(time.time() * 1000) // Q * Q
    s, bars = end - int(days * 86400000), []
    while s < end:
        d = g.get("/api/v3/klines", {"symbol": sym, "interval": "15m", "limit": 1000, "startTime": s})
        if not d:
            break
        bars += [[b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[7]), int(b[8]), float(b[10])] for b in d]
        s = d[-1][0] + Q
        if len(d) < 1000:
            break
        time.sleep(0.1)
    os.makedirs(cache, exist_ok=True)
    json.dump(bars, open(fn, "w"))
    return bars


def rmean_prev(x, w):
    c = np.concatenate([[0], np.cumsum(x)]); out = np.full(len(x), np.nan)
    out[w:] = (c[w:-1] - c[:-w - 1]) / w
    return out


def rmax_prev(x, w, fn=np.max):
    out = np.full(len(x), np.nan)
    if len(x) > w:
        out[w:] = fn(sw(x[:-1], w), axis=1)
    return out


def features(a, btc):
    t, o, h, l, c, qv, n, tb = a.T
    N = len(a)
    f = {"t": t, "o": o, "h": h, "l": l, "c": c, "qv": qv}
    q24 = np.convolve(qv, np.ones(96))[:N]; q24[:95] = np.nan; f["qv24"] = q24
    f["vr"] = qv / rmean_prev(qv, 96); f["vr7"] = qv / rmean_prev(qv, 672)
    cs = np.concatenate([[0], np.cumsum(qv)]); idx = np.arange(N); prev = np.full(N, np.nan); ok = idx >= 99
    prev[ok] = (cs[idx[ok] - 3] - cs[idx[ok] - 99]) / 24.0
    v1 = np.convolve(qv, np.ones(4))[:N]
    with np.errstate(all="ignore"):
        f["svr"] = v1 / prev
        f["c15"] = (c / o - 1) * 100
        f["c1"] = np.concatenate([np.full(4, np.nan), (c[4:] / c[:-4] - 1) * 100])
        f["c4"] = np.concatenate([np.full(16, np.nan), (c[16:] / c[:-16] - 1) * 100])
        f["c24"] = np.concatenate([np.full(96, np.nan), (c[96:] / c[:-96] - 1) * 100])
        f["tk"] = np.where(qv > 0, tb / np.maximum(qv, 1e-12), 0.5)
        f["hi24"] = rmax_prev(h, 96); lo24 = rmax_prev(l, 96, np.min)
        f["rng24"] = (f["hi24"] / lo24 - 1) * 100
        hi4 = rmax_prev(h, 15); lo4 = rmax_prev(l, 15, np.min)
        f["range4"] = (np.fmax(hi4, h) / np.fmin(lo4, l) - 1) * 100
        vacc = np.full(N, np.nan); i = np.arange(4, N); vacc[4:] = qv[4:] / ((cs[i] - cs[i - 4]) / 4); f["vacc"] = vacc
        bc = np.array([btc.get(int(x), np.nan) for x in t])
        f["rs1"] = f["c1"] - np.concatenate([np.full(4, np.nan), (bc[4:] / bc[:-4] - 1) * 100])
        fmax4 = np.full(N, np.nan); fmin4 = np.full(N, np.nan); fcl4 = np.full(N, np.nan)
        if N > 17:
            W = sw(h[1:], 16); fmax4[:len(W)] = W.max(1); fmin4[:len(W)] = sw(l[1:], 16).min(1); fcl4[:N - 16] = c[16:]
        f["g4"] = (fmax4 / c - 1) * 100; f["r4"] = (fcl4 / c - 1) * 100; f["d4"] = (fmin4 / c - 1) * 100
    f["pre"] = (f["c1"] < g.SURGE_C1) & (f["c15"] < g.SURGE_C15)
    f["fire_raw"] = ((f["c1"] >= g.SURGE_C1) & (f["svr"] >= g.SURGE_VR)) | (f["c15"] >= g.SURGE_C15)
    f["fire"] = f["fire_raw"] & (f["qv24"] >= FLOOR)
    f["recent_fire"] = np.convolve(f["fire"].astype(int), np.ones(17, int))[:N] > 0
    return f


def prevb(x):
    y = np.zeros_like(x, dtype=bool); y[1:] = x[:-1]; return y


def _A(f):
    return (f["vr"] >= 2.5) & (np.abs(f["c15"]) < 2) & (f["c1"] < 3)


def _E3b(f):
    return f["pre"] & (f["c15"] >= g.E2_C15) & (f["c1"] >= g.E2_C1_MIN) & (f["rng24"] >= g.E2_RNG24) & (f["qv24"] >= FLOOR)


def _E5(f):
    return f["fire_raw"] & (f["qv24"] < FLOOR) & (f["qv24"] >= g.E2_LOW_QV)


# (rule, liquidity floor applied at signal time)
CANDS = {
    "🔥 現行": (lambda f: f["fire"], FLOOR),
    "舊🔥 24h≥+20% 近高": (lambda f: (f["c24"] >= 20) & ((f["c"] / np.fmax(f["hi24"], f["h"]) - 1) * 100 >= -10), FLOOR),
    "舊⚡ 1h量≥2x 1h≥+3% 24h<15%": (lambda f: (f["svr"] >= 2) & (f["c1"] >= 3) & (f["c24"] < 15), FLOOR),
    "Q1 QA: 15m量≥2.5x(24h均) 價平 |15m|<2% 1h<3%": (_A, FLOOR),
    "Q2 QA: 連續2支 量≥2.5x 價平": (lambda f: _A(f) & prevb(_A(f)), FLOOR),
    "Q3 QA: 量≥2.5x 價平 taker≥0.55": (lambda f: _A(f) & (f["tk"] >= 0.55), FLOOR),
    "Q4 QA字面: 15m量≥2.5x(前1h均) 價平": (lambda f: (f["vacc"] >= 2.5) & (np.abs(f["c15"]) < 2) & (f["c1"] < 3), FLOOR),
    "E1 24h波幅≥40% 15m≥+1% 量≥2x(7d) 未🔥": (lambda f: f["pre"] & (f["rng24"] >= 40) & (f["c15"] >= 1) & (f["vr7"] >= 2), FLOOR),
    "E2 量≥5x(7d) 15m≥+1% 1h≥+1% 波幅≥25% 未🔥": (lambda f: f["pre"] & (f["vr7"] >= 5) & (f["c15"] >= 1) & (f["c1"] >= 1) & (f["rng24"] >= 25), FLOOR),
    "E3b 起步 15m≥+2.5% 1h≥0 波幅≥25% 未🔥": (_E3b, FLOOR),
    "E4 破24h高 量≥3x 15m≥+1.5% 未🔥": (lambda f: f["pre"] & (f["c"] > f["hi24"]) & (f["vr"] >= 3) & (f["c15"] >= 1.5), FLOOR),
    "E5 細盤🔥 24h量$2–3M": (_E5, g.E2_LOW_QV),
    SHIPPED: (lambda f: (_E3b(f) | _E5(f)) & ~f["recent_fire"], g.E2_LOW_QV),
    "S′ 同上但細盤下限$1.5M": (lambda f: (_E3b(f) | (f["fire_raw"] & (f["qv24"] < FLOOR) & (f["qv24"] >= 1.5e6))) & ~f["recent_fire"], 1.5e6),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache15", required=True)
    ap.add_argument("--days", type=float, default=38)
    a = ap.parse_args()
    syms = g.universe()
    btcb = fetch15("BTCUSDT", a.days, a.cache15)
    btc = {int(b[0]): b[4] for b in btcb}
    F = {}
    for s in syms:
        try:
            b = fetch15(s, a.days, a.cache15)
        except Exception as e:  # noqa: BLE001
            print("skip", s, e, file=sys.stderr); continue
        if len(b) >= 800:
            F[s] = features(np.array(b, dtype=float), btc)
    END = int(btcb[-1][0])
    LASTC, OUTOK = END - Q, END - 17 * Q
    syms = [s for s in F if s != "BTCUSDT"]
    allt = {}
    for s in syms:
        f = F[s]
        for j in np.nonzero((f["qv24"] >= FLOOR) & (f["range4"] >= 5) & (f["t"] >= START))[0]:
            allt.setdefault(int(f["t"][j]), []).append((f["c4"][j], s))
    pool = {t: {s for _, s in sorted(L, reverse=True)[:10]} for t, L in allt.items()}

    def run(rule, floor):
        out = {}
        for s in syms:
            f = F[s]
            with np.errstate(invalid="ignore"):
                m = rule(f) & (f["qv24"] >= floor) & (f["t"] >= START) & (f["t"] <= LASTC)
            last, L = -99, []
            for j in np.nonzero(m)[0]:
                if j - last < 16:
                    continue
                last = j; t = int(f["t"][j]); done = t <= OUTOK
                r2 = lambda k: round(float(f[k][j]), 2) if done else None
                L.append({"s": s, "j": int(j), "t": t, "p": float(f["c"][j]), "g4": r2("g4"), "r4": r2("r4"), "d4": r2("d4"),
                          "inpool": s in pool.get(t, ()), "qv24": float(f["qv24"][j])})
            if L:
                out[s] = L
        return out

    events = []
    for s in syms:
        f = F[s]; lastpk = -1
        with np.errstate(invalid="ignore"):
            cand = np.nonzero((f["g4"] >= 20) & (f["t"] >= START) & (f["t"] <= OUTOK))[0]
        for j in cand:
            if j <= lastpk:
                continue
            k = j + 1 + int(np.argmax(f["h"][j + 1:j + 17])); lastpk = k
            events.append({"s": s, "j": int(j), "t": int(f["t"][j]), "peak_j": k, "peak_t": int(f["t"][k]),
                           "base": float(f["c"][j]), "peak": float(f["h"][k]), "qv24": float(f["qv24"][j])})

    def catch(fb, e, lo=8, minup=10):
        for x in fb.get(e["s"], []):
            if e["j"] - lo <= x["j"] < e["peak_j"] and (e["peak"] / x["p"] - 1) * 100 >= minup:
                return x
        return None

    dtr, dte = (SPLIT - START) / 86400000, (OUTOK - SPLIT) / 86400000
    fb_all = {n: run(r, fl) for n, (r, fl) in CANDS.items()}
    fire = fb_all["🔥 現行"]

    def stats(L, days):
        L = [x for x in L if x["g4"] is not None]; n = len(L)
        if not n:
            return {"fires": 0}
        return {"fires": n, "fires_per_day": round(n / days, 1),
                "hit20_4h_pct": round(100 * sum(x["g4"] >= 20 for x in L) / n, 2),
                "hit10_4h_pct": round(100 * sum(x["g4"] >= 10 for x in L) / n, 1),
                "false_alarms": sum(x["g4"] < 10 for x in L), "false_alarm_pct": round(100 * sum(x["g4"] < 10 for x in L) / n, 1),
                "mean_close_4h_pct": round(st.mean(x["r4"] for x in L), 2), "median_close_4h_pct": round(st.median(x["r4"] for x in L), 2),
                "mean_max_gain_4h_pct": round(st.mean(x["g4"] for x in L), 2),
                "median_max_drawdown_4h_pct": round(st.median(x["d4"] for x in L), 2),
                "outside_top10_pool_pct": round(100 * sum(not x["inpool"] for x in L) / n, 1)}

    def recall(fb, sub):
        E = [e for e in events if (e["t"] < SPLIT) == (sub == "train")]
        c = u = only = 0; leads = []
        for e in E:
            x, fz, fz10 = catch(fb, e), catch(fire, e, minup=0), catch(fire, e)
            u += bool(x or fz10)
            if x:
                c += 1
                if fz:
                    leads.append((fz["t"] - x["t"]) / 60000)
                else:
                    only += 1
        return {"events": len(E), "caught": c, "recall_pct": round(100 * c / max(1, len(E)), 1),
                "recall_with_fire_pct": round(100 * u / max(1, len(E)), 1),
                "median_lead_vs_fire_min": st.median(leads) if leads else None,
                "earlier_than_fire_pct": round(100 * sum(l > 0 for l in leads) / len(leads), 1) if leads else None,
                "caught_when_fire_missed": only}

    cands = {}
    for n, fb in fb_all.items():
        L = [x for v in fb.values() for x in v]
        cands[n] = {"floor_usd": CANDS[n][1],
                    "train": {**stats([x for x in L if x["t"] < SPLIT], dtr), **recall(fb, "train")},
                    "test": {**stats([x for x in L if x["t"] >= SPLIT], dte), **recall(fb, "test")}}
        te = cands[n]["test"]
        cands[n]["passes_buy_gate"] = bool(te.get("fires") and te["mean_close_4h_pct"] > 0 and te["hit20_4h_pct"] >= 8)
    named = []
    for s in NAMED:
        for e in [e for e in events if e["s"] == s]:
            row = {"symbol": s[:-4], "event_bar_close": iso(e["t"] + Q), "base": e["base"], "peak": e["peak"], "peak_bar": iso(e["peak_t"]),
                   "move_pct": round((e["peak"] / e["base"] - 1) * 100, 1), "qv24_at_start": round(e["qv24"]), "first_alert": {}}
            for n in ("🔥 現行", "舊🔥 24h≥+20% 近高", "舊⚡ 1h量≥2x 1h≥+3% 24h<15%", "Q1 QA: 15m量≥2.5x(24h均) 價平 |15m|<2% 1h<3%", SHIPPED):
                x = catch(fb_all[n], e, minup=0)
                row["first_alert"][n] = {"alert_at": iso(x["t"] + Q), "price": x["p"], "left_to_peak_pct": round((e["peak"] / x["p"] - 1) * 100, 1)} if x else None
            named.append(row)
    pump_ev = {"train": sum(e["t"] < SPLIT for e in events), "test": sum(e["t"] >= SPLIT for e in events),
               "qv24_at_start": {"<$1M": sum(e["qv24"] < 1e6 for e in events), "$1–3M": sum(1e6 <= e["qv24"] < 3e6 for e in events),
                                 ">=$3M": sum(e["qv24"] >= 3e6 for e in events)}}
    compact = lambda fb: [[x["s"][:-4], iso(x["t"] + Q), x["p"], x["g4"], x["r4"], x["d4"], x["inpool"]] for v in fb.values() for x in v]
    sh = cands[SHIPPED]
    out = {
        "generated_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "method": __doc__.split("Usage:")[0].strip(),
        "window": {"start": iso(START), "split": iso(SPLIT), "end_last_closed_bar": iso(LASTC), "outcomes_until": iso(OUTOK),
                   "train_days": round(dtr, 1), "test_days": round(dte, 1)},
        "universe": {"symbols": len(syms), "bars": "15m", "tokenized_excluded": len(g.TOKENIZED)},
        "buy_gate": "test-half mean 4h close > 0 AND +20%-in-4h hit >= 8%",
        "pump_events": pump_ev,
        "shipped": SHIPPED, "shipped_rule": g.RULE_TEXT["early2"],
        "chip": {"median_lead_vs_fire_min": sh["test"]["median_lead_vs_fire_min"], "hit20_4h_pct": sh["test"]["hit20_4h_pct"],
                 "mean_close_4h_pct": sh["test"]["mean_close_4h_pct"], "fires_per_day": sh["test"]["fires_per_day"],
                 "recall_with_fire_pct": sh["test"]["recall_with_fire_pct"], "fire_alone_recall_pct": cands["🔥 現行"]["test"]["recall_pct"]},
        "candidates": cands,
        "named_coins": named,
        "fires_columns": ["symbol", "alert_at (15m bar close, +08:00)", "price (bar close = entry)", "max_gain_4h_pct", "close_4h_pct", "max_drawdown_4h_pct", "in_site_top10_pool"],
        "fires": {n: compact(fb) for n, fb in fb_all.items()},
    }
    json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
    for n, v in cands.items():
        for sub in ("train", "test"):
            x = v[sub]
            print(f"{n[:40]:40} {sub:5} /d {x.get('fires_per_day')} hit20 {x.get('hit20_4h_pct')} r4 {x.get('mean_close_4h_pct')} FA {x.get('false_alarms')}/{x.get('fires')} "
                  f"out10 {x.get('outside_top10_pool_pct')} recall {x['recall_pct']} ∪🔥 {x['recall_with_fire_pct']} lead {x['median_lead_vs_fire_min']} early% {x['earlier_than_fire_pct']} 🔥missed {x['caught_when_fire_missed']}")


if __name__ == "__main__":
    main()
