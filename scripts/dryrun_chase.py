#!/usr/bin/env python3
"""🚀 續升買 (chase) dry-run on Binance 1h signals + 5m exits.

Signal at each CLOSED 1h bar i (Asia/Shanghai window): gainer_core.chase_ok on
  c24 = close_i / close_{i-24} - 1, fh = close_i / max(high_{i-23..i}) - 1,
  vr = qv_i / mean(qv_{i-24..i-1}), c1 = close_i / open_i - 1 (1h candle up), qv24 = sum(qv_{i-23..i}).
Entry = close of bar i. One entry per symbol per 24h (no re-entry inside the sell_by window).
Exits on 5m bars from entry for CHASE_SELL_H hours, stop checked first inside a bar:
  A "seal" model = what outcomes.json exit-aware sealing measures (single TP +20% / SL −10% / 24h close).
  B "ladder"     = +20% sell half (stop on rest → entry) / +50% clear rest / −10% / 24h close.
Usage: python3 scripts/dryrun_chase.py --from 2026-10-25 --to 2026-10-29 [--cache DIR] [--json OUT]
"""
from __future__ import annotations
import argparse, datetime, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402

TZ = datetime.timezone(datetime.timedelta(hours=8))
H, M5 = 3_600_000, 300_000


def _get_retry(path, q, tries=8):
    for k in range(tries):
        try:
            return g.get(path, q)
        except Exception:  # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(1.5 * (k + 1))


def fetch(sym, interval, start, end, cache, step):
    fn = os.path.join(cache, f"{sym}_{interval}_{start}_{end}.json")
    if os.path.exists(fn):
        return json.load(open(fn))
    bars, s = [], start
    while s < end:
        d = _get_retry("/api/v3/klines", {"symbol": sym, "interval": interval, "limit": 1000, "startTime": s, "endTime": end})
        if not d:
            break
        bars += [[b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[7])] for b in d]
        s = d[-1][0] + step
        if len(d) < 1000:
            break
        time.sleep(0.05)
    os.makedirs(cache, exist_ok=True)
    json.dump(bars, open(fn, "w"))
    return bars


def simulate(entry, bars, tp, tp2, sl):
    """Return dict with seal (A) + ladder (B) returns in %."""
    stop_px, tp_px, tp2_px = entry * (1 - sl / 100), entry * (1 + tp / 100), entry * (1 + tp2 / 100)
    A = None
    for b in bars:
        if b[3] <= stop_px:
            A = (-sl, "stop"); break
        if b[2] >= tp_px:
            A = (tp, "take_profit"); break
    last = bars[-1][4] if bars else entry
    if A is None:
        A = ((last / entry - 1) * 100, "hold_sell_by")
    # ladder
    half, stop, realized, reason = False, stop_px, 0.0, None
    for b in bars:
        if b[3] <= stop:
            r = (stop / entry - 1) * 100
            realized += (0.5 if half else 1.0) * r
            reason = "be_after_half" if half else "stop"; break
        if not half and b[2] >= tp_px:
            half, realized, stop = True, 0.5 * tp, entry
            if b[2] >= tp2_px:
                realized += 0.5 * tp2; reason = "tp2"; break
            continue
        if half and b[2] >= tp2_px:
            realized += 0.5 * tp2; reason = "tp2"; break
    if reason is None:
        realized += (0.5 if half else 1.0) * (last / entry - 1) * 100
        reason = "half+sell_by" if half else "hold_sell_by"
    mg = (max(b[2] for b in bars) / entry - 1) * 100 if bars else 0
    md = (min(b[3] for b in bars) / entry - 1) * 100 if bars else 0
    return {"A": round(A[0], 2), "A_reason": A[1], "B": round(realized, 2), "B_reason": reason,
            "max_gain": round(mg, 2), "max_dd": round(md, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d0", default="2026-10-25")
    ap.add_argument("--to", dest="d1", default="2026-10-29")
    ap.add_argument("--cache", default="/tmp/chase_cache")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    t0 = int(datetime.datetime.strptime(a.d0, "%Y-%m-%d").replace(tzinfo=TZ).timestamp() * 1000)
    t1 = int((datetime.datetime.strptime(a.d1, "%Y-%m-%d").replace(tzinfo=TZ) + datetime.timedelta(days=1)).timestamp() * 1000)
    now = int(time.time() * 1000)
    uf = os.path.join(a.cache, "universe.json")
    if os.path.exists(uf):
        syms = json.load(open(uf))
    else:
        for k in range(6):
            try:
                syms = g.universe(); break
            except Exception:  # noqa: BLE001
                if k == 5:
                    raise
                time.sleep(3 * (k + 1))
        os.makedirs(a.cache, exist_ok=True)
        json.dump(syms, open(uf, "w"))
    print("universe", len(syms), "tokenized excluded", len(g.TOKENIZED), file=sys.stderr)
    fs, fe = t0 - 26 * H, t1
    sigs = []
    from concurrent.futures import ThreadPoolExecutor

    def load(sym):
        try:
            return sym, fetch(sym, "1h", fs, fe, a.cache, H)
        except Exception as e:  # noqa: BLE001
            print("fail", sym, e, file=sys.stderr)
            return sym, None
    with ThreadPoolExecutor(6) as ex:
        loaded = list(ex.map(load, syms))
    failed = [s for s, b in loaded if b is None]
    for n, (sym, b) in enumerate(loaded):
        if b is None:
            continue
        busy_until = 0
        for i in range(25, len(b)):
            close_t = b[i][0] + H
            if close_t <= t0 or close_t > t1 or close_t > now:
                continue
            if close_t < busy_until:
                continue
            c = b[i][4]
            prev = [x[5] for x in b[i - 24:i]]
            avg = sum(prev) / 24 if prev else 0
            hi24 = max(x[2] for x in b[i - 23:i + 1])
            f = {"c24": (c / b[i - 24][4] - 1) * 100, "fh": (c / hi24 - 1) * 100,
                 "vr": b[i][5] / avg if avg > 0 else 0, "c1": (c / b[i][1] - 1) * 100,
                 "qv24": sum(x[5] for x in b[i - 23:i + 1])}
            leg = g.chase_ok(f["c24"], f["fh"], f["vr"], f["c1"], f["qv24"])
            if not leg:
                continue
            end = close_t + g.CHASE_SELL_H * H
            sigs.append({"pair": sym, "t": close_t, "entry": c, "leg": leg, "end": end, **{k: round(v, 2) for k, v in f.items()}})
            busy_until = end  # refined after exit below
        if n % 50 == 0:
            print(f"{n}/{len(syms)} signals {len(sigs)}", file=sys.stderr)
    # exits on 5m
    out = []
    def load5(s):
        end = min(s["end"], now)
        return fetch(s["pair"], "5m", s["t"], end - 1, a.cache, M5)
    with ThreadPoolExecutor(6) as ex:
        b5 = list(ex.map(load5, sigs))
    for s, bars in zip(sigs, b5):
        end = min(s["end"], now)
        bars = [x for x in bars if x[0] >= s["t"] and x[0] + M5 <= end]
        r = simulate(s["entry"], bars, g.CHASE_TP, g.CHASE_TP2, g.CHASE_SL)
        s.update(r)
        s["complete"] = s["end"] <= now
        s["at"] = datetime.datetime.fromtimestamp(s["t"] / 1000, TZ).strftime("%m-%d %H:%M")
        out.append(s)
    out.sort(key=lambda x: x["t"])
    if a.json:
        json.dump({"generated": datetime.datetime.now(TZ).isoformat(), "window": [a.d0, a.d1], "rule": {
            "c24": [g.CHASE_C24_MIN, g.CHASE_C24_MAX], "fh_min": g.CHASE_FH_MIN, "vr": g.CHASE_VR, "c1": ">0",
            "min_qv": g.CHASE_MIN_QV, "small_qv": g.CHASE_SMALL_QV, "tp": g.CHASE_TP, "tp2": g.CHASE_TP2, "sl": g.CHASE_SL,
            "sell_h": g.CHASE_SELL_H}, "universe": len(syms), "failed": failed, "signals": out}, open(a.json, "w"), indent=1)
    print(json.dumps({"signals": len(out)}))


if __name__ == "__main__":
    main()
