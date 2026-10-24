#!/usr/bin/env python3
"""急升榜 data pipeline (GitHub Actions, no AI tokens, Binance public REST only, no X).

  python3 scripts/gainer_board.py hourly      # seal due 4h/24h outcomes, snapshot both tiers, rebuild summary
  python3 scripts/gainer_board.py scorecard   # daily 23:55 Asia/Shanghai: our flags vs Binance top-20 gainers
  python3 scripts/gainer_board.py summary     # rebuild data/gainer_board/summary.json only

Files (all under data/gainer_board/):
  snapshots/YYYY-MM-DD.json   hourly batches (Shanghai day). Each entry: symbol, pair, tier (pump|early),
                              picked_at (ISO +08:00), entry_price_usd, change_24h_at_pick, rank_24h_at_pick,
                              batch, score, change_1h/4h, vol_x_avg, vol_x_prev_hour, outcomes{4h,24h}
  latest.json                 newest batch + active flags (last 12h) for the site
  summary.json                live 4h (headline) / 24h hit-rates per tier, latest sealed 4h batch,
                              backtest digest, last 7 daily scorecards
  daily_vs_gainers/DATE.json  daily scorecard
  backtest_30d.json           from scripts/gainer_backtest.py

Outcomes use Binance 1m klines from picked_at: max gain, close return, max drawdown, hit +20% / +50%.
"""
import datetime, glob, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
D = os.path.join(ROOT, "data", "gainer_board")
SNAP = os.path.join(D, "snapshots")
CARD = os.path.join(D, "daily_vs_gainers")
TZ = datetime.timezone(datetime.timedelta(hours=8))
MAX_PER_TIER = 10
HORIZONS = (4, 24)


def now():
    return datetime.datetime.now(TZ)


def iso(dt):
    return dt.astimezone(TZ).isoformat(timespec="seconds")


def pt(s):
    return datetime.datetime.fromisoformat(s)


def jload(fn, default):
    try:
        with open(fn) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def jsave(fn, obj):
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    with open(fn, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def snap_files(days=None):
    fs = sorted(glob.glob(os.path.join(SNAP, "*.json")))
    return fs[-days:] if days else fs


def all_tickers():
    """Every TRADING Binance USDT spot pair (stables / leveraged excluded), ranked by 24h % — the real
    Binance gainer list. No volume floor here; signals apply g.MIN_QV24 separately."""
    listed = set(g.universe())
    out = []
    for x in g.get("/api/v3/ticker/24hr", {"type": "MINI"}):
        s = x["symbol"]
        if s not in listed:
            continue
        last, op, qv = float(x["lastPrice"]), float(x["openPrice"]), float(x["quoteVolume"])
        if last > 0 and op > 0:
            out.append({"pair": s, "price": last, "chg24": (last / op - 1) * 100, "qv": qv, "high": float(x["highPrice"])})
    out.sort(key=lambda r: -r["chg24"])
    for i, r in enumerate(out):
        r["rank"] = i + 1
    return out


def eligible_tickers(allt=None):
    return [r for r in (allt or all_tickers()) if r["qv"] >= g.MIN_QV24]


# ---------------- snapshot ----------------
def recent_flags(hours):
    cut = now() - datetime.timedelta(hours=hours)
    res = []
    for fn in snap_files(2):
        for b in jload(fn, {}).get("batches", []):
            for e in b.get("entries", []):
                if pt(e["picked_at"]) >= cut:
                    res.append(e)
    return res


def snapshot():
    t0 = now()
    allt = all_tickers()
    tick = eligible_tickers(allt)
    btc = next((r for r in tick if r["pair"] == "BTCUSDT"), None)
    cool = {(e["pair"], e["tier"]) for e in recent_flags(g.COOLDOWN_H - 0.1)}
    fires = {"pump": [], "early": []}
    for r in tick:
        try:
            bars = g.klines(r["pair"], "1h", 80)
        except Exception as e:  # noqa: BLE001
            print("kline fail", r["pair"], e, file=sys.stderr)
            continue
        time.sleep(0.05)
        closed = bars[:-1]  # last bar is still forming
        if len(closed) < 76:
            continue
        f = g.feats(closed, len(closed) - 1)
        t = g.tier(f)
        if not t or (r["pair"], t) in cool:
            continue
        fires[t].append((g.score(f), r, f))
    batch = "gb-" + t0.strftime("%Y%m%d-%H%M")
    entries = []
    for t in ("pump", "early"):
        for sc, r, f in sorted(fires[t], key=lambda x: -x[0])[:MAX_PER_TIER]:
            entries.append({
                "symbol": r["pair"][:-4], "pair": r["pair"], "tier": t, "picked_at": iso(t0),
                "entry_price_usd": r["price"], "change_24h_at_pick": round(r["chg24"], 2),
                "rank_24h_at_pick": r["rank"], "batch": batch, "score": sc,
                "change_1h_at_pick": round(f["c1"], 2), "change_4h_at_pick": round(f["c4"], 2),
                "vol_x_avg": round(f["vr"], 2), "vol_x_prev_hour": round(f["vr1"], 2),
                "from_24h_high_pct": round(f["fh"], 2), "quote_volume_24h": round(r["qv"]),
                "outcomes": {},
            })
    fn = os.path.join(SNAP, t0.strftime("%Y-%m-%d") + ".json")
    day = jload(fn, {"date": t0.strftime("%Y-%m-%d"), "batches": []})
    day["batches"].append({
        "batch": batch, "picked_at": iso(t0), "universe": len(tick),
        "btc_24h_pct": round(btc["chg24"], 2) if btc else None, "universe_all": len(allt),
        "top20_24h": [r["pair"] for r in allt[:20]], "entries": entries,
    })
    jsave(fn, day)
    print(f"snapshot {batch}: {len(tick)} eligible, pump {len(fires['pump'])}, early {len(fires['early'])}")


# ---------------- seal ----------------
def window_bars(pair, start_ms, hours):
    out, t, end = [], start_ms, start_ms + hours * 3600000
    while t < end:
        bs = g.klines(pair, "1m", 1000, start=t, end=end - 1)
        if not bs:
            break
        out += bs
        t = bs[-1][0] + 60000
        if len(bs) < 1000:
            break
        time.sleep(0.05)
    return out


def seal():
    n = 0
    tnow = now()
    for fn in snap_files(3):
        day = jload(fn, None)
        if not day:
            continue
        changed = False
        for b in day.get("batches", []):
            for e in b.get("entries", []):
                for h in HORIZONS:
                    k = f"{h}h"
                    if k in e["outcomes"]:
                        continue
                    t = pt(e["picked_at"])
                    if tnow < t + datetime.timedelta(hours=h, minutes=2):
                        continue
                    start = int(t.timestamp() * 1000) // 60000 * 60000
                    try:
                        bars = window_bars(e["pair"], start, h)
                    except Exception as ex:  # noqa: BLE001
                        print("seal fail", e["pair"], ex, file=sys.stderr)
                        continue
                    o = g.outcome(e["entry_price_usd"], bars)
                    if not o:
                        o = {"status": "no_data"}
                    else:
                        o.pop("exit_rule_pct", None)
                        o["bars_1m"] = len(bars)
                    o["sealed_at"] = iso(tnow)
                    e["outcomes"][k] = o
                    changed = True
                    n += 1
        if changed:
            jsave(fn, day)
    print("sealed", n)


# ---------------- scorecard ----------------
def main_picks_on(date):
    res = []
    for b in jload(os.path.join(ROOT, "data", "picks.json"), {}).get("batches", []):
        for e in b.get("entries", []):
            if e.get("type") != "buy" or not str(e.get("created_at", "")).startswith(date):
                continue
            pair = (e.get("pair_address") or "").upper()
            if not pair.endswith("USDT"):
                continue
            res.append({"pair": pair, "symbol": pair[:-4], "tier": "main", "picked_at": e["created_at"],
                        "change_24h_at_pick": (e.get("entry_snapshot") or {}).get("chg24h_pct"),
                        "rank_24h_at_pick": None, "entry_price_usd": e.get("entry_price_usd")})
    return res


def scheduled_date(t=None):
    """Scorecard date = the scheduled 23:55 Asia/Shanghai day. A run GitHub delays past midnight
    (before 12:00) still belongs to the previous day."""
    t = t or now()
    if t.hour < 12:
        t = t - datetime.timedelta(days=1)
    return t.strftime("%Y-%m-%d")


def scorecard(date=None):
    t0 = now()
    date = date or scheduled_date(t0)
    allt = all_tickers()           # real Binance gainers: all USDT spot, stables/leveraged excluded
    top20 = allt[:20]
    top_pairs = [r["pair"] for r in top20]
    by_pair = {r["pair"]: r for r in allt}
    day = jload(os.path.join(SNAP, date + ".json"), {"batches": []})
    flags = [e for b in day["batches"] for e in b.get("entries", [])] + main_picks_on(date)
    first = {}
    for e in sorted(flags, key=lambda x: x["picked_at"]):
        first.setdefault(e["pair"], {"first": e, "tiers": set()})["tiers"].add(e["tier"])
    rows = []
    for pair, v in first.items():
        e = v["first"]
        rk, c24 = e.get("rank_24h_at_pick"), e.get("change_24h_at_pick")
        late = (rk is not None and rk <= 20) or (c24 is not None and c24 >= 15)
        in_top = pair in top_pairs
        row = {"symbol": pair[:-4], "pair": pair, "tiers": sorted(v["tiers"]),
               "buyable": bool(v["tiers"] & {"pump", "main"}),  # rows that had a buy button
               "flag_time": e["picked_at"], "rank_24h_at_flag": rk, "change_24h_at_flag": c24,
               "entry_price_usd": e.get("entry_price_usd"), "late": bool(late), "in_top20": in_top,
               "final_rank": top_pairs.index(pair) + 1 if in_top else None,
               "final_change_24h": round(by_pair[pair]["chg24"], 2) if pair in by_pair else None}
        if in_top:
            try:
                bars = g.klines(pair, "1h", 24)
                pk = max(bars, key=lambda b: b[2])
                row["peak_time"] = iso(datetime.datetime.fromtimestamp(pk[0] / 1000, TZ))
                row["lead_h"] = round((pk[0] / 1000 - pt(e["picked_at"]).timestamp()) / 3600, 1)
            except Exception:  # noqa: BLE001
                pass
        rows.append(row)
    early_rows = [r for r in rows if not r["late"]]
    late_rows = [r for r in rows if r["late"]]
    early_hits = [r for r in early_rows if r["in_top20"]]
    late_hits = [r for r in late_rows if r["in_top20"]]
    caught = {r["pair"] for r in early_hits}
    top10 = set(top_pairs[:10])
    pc = lambda a, b: round(a / b * 100, 1) if b else None
    card = {
        "date": date, "scheduled_for": f"{date}T23:55:00+08:00", "taken_at": iso(t0), "universe_all": len(allt),
        "rule": ("Top 20 = ALL Binance USDT spot pairs (stables / leveraged excluded, no volume floor) by 24h %, "
                 "taken at the 23:55 Asia/Shanghai run. A flag is EARLY only if rank_24h_at_flag > 20 and 24h % < +15% "
                 "at flag time; otherwise LATE. Precision / recall use EARLY flags only; LATE reported separately."),
        "flagged": len(rows), "early_flagged": len(early_rows), "late_flagged": len(late_rows),
        "early_hits": len(early_hits), "late_hits": len(late_hits),
        "precision_pct": pc(len(early_hits), len(early_rows)),
        "late_precision_pct": pc(len(late_hits), len(late_rows)),
        "recall_top20_pct": pc(len(caught), len(top20)),
        "recall_top10_pct": pc(len(caught & top10), min(10, len(top20))),
        "late_recall_top20_pct": pc(len({r["pair"] for r in late_hits} - caught), len(top20)),
        "buyable_flagged": sum(r["buyable"] for r in rows),
        "buyable_early_hits": sum(r["buyable"] for r in early_hits),
        "hits": early_hits, "late": late_hits,
        "missed": [{"symbol": r["pair"][:-4], "rank": r["rank"], "change_24h": round(r["chg24"], 2)} for r in top20
                   if r["pair"] not in caught and r["pair"] not in {x["pair"] for x in late_hits}],
        "top20": [{"symbol": r["pair"][:-4], "rank": r["rank"], "change_24h": round(r["chg24"], 2), "quote_volume_24h": round(r["qv"])} for r in top20],
        "flags": rows,
    }
    jsave(os.path.join(CARD, date + ".json"), card)
    print(f"scorecard {date}: flagged {len(rows)} (early {len(early_rows)} / late {len(late_rows)}), "
          f"early hits {len(early_hits)}, late hits {len(late_hits)}, recall {card['recall_top20_pct']}%")


# ---------------- summary ----------------
def agg(es, k):
    os_ = [e["outcomes"][k] for e in es if k in e.get("outcomes", {}) and "max_gain_pct" in e["outcomes"][k]]
    n = len(os_)
    if not n:
        return {"n": 0}
    m = lambda key: round(sum(o[key] for o in os_) / n, 2)
    return {"n": n, "hit20": sum(o["hit20"] for o in os_), "hit50": sum(o["hit50"] for o in os_),
            "avg_max_gain_pct": m("max_gain_pct"), "avg_close_pct": m("close_pct"),
            "avg_max_drawdown_pct": m("max_drawdown_pct"),
            "closed_up": sum(o["close_pct"] > 0 for o in os_)}


def summary():
    allb = []
    for fn in snap_files():
        allb += jload(fn, {}).get("batches", [])
    es = [e for b in allb for e in b.get("entries", [])]
    horizons, tiers = {}, {}
    for h in HORIZONS:
        horizons[f"{h}h"] = agg(es, f"{h}h")
    for t in ("pump", "early"):
        te = [e for e in es if e["tier"] == t]
        tiers[t] = {f"{h}h": agg(te, f"{h}h") for h in HORIZONS}
        tiers[t]["flags"] = len(te)
    latest4 = None
    for b in reversed(allb):
        sealed = [e for e in b.get("entries", []) if "max_gain_pct" in e.get("outcomes", {}).get("4h", {})]
        if sealed:
            latest4 = {"batch": b["batch"], "picked_at": b["picked_at"], "entries": [
                {"symbol": e["symbol"], "tier": e["tier"], "entry_price_usd": e["entry_price_usd"],
                 "change_24h_at_pick": e["change_24h_at_pick"], **{k: e["outcomes"]["4h"][k] for k in ("max_gain_pct", "close_pct", "max_drawdown_pct", "hit20", "hit50")}}
                for e in sealed]}
            break
    bt = jload(os.path.join(D, "backtest_30d.json"), {})
    btd = {t: {"rule": v.get("rule"), "all": v.get("all"), "test": v.get("test"), "passes_buy_gate": v.get("passes_buy_gate")}
           for t, v in (bt.get("tiers") or {}).items()}
    cards = [jload(fn, None) for fn in sorted(glob.glob(os.path.join(CARD, "*.json")))[-7:]]
    cards = [c for c in cards if c]
    fl = sum(c.get("early_flagged", c["flagged"]) for c in cards)
    eh = sum(c["early_hits"] for c in cards)
    rc = sum(round(c["recall_top20_pct"] * len(c["top20"]) / 100) for c in cards)
    tt = sum(len(c["top20"]) for c in cards)
    cut = now() - datetime.timedelta(hours=12)
    active = [e for e in es if pt(e["picked_at"]) >= cut]
    out = {
        "updated_at": iso(now()), "batches": len(allb), "flags": len(es),
        "horizons": horizons, "tiers": tiers, "latest_4h": latest4,
        "backtest_30d": {"generated_at": bt.get("generated_at"), "window": bt.get("window"), "tiers": btd},
        "scorecards": [{k: c.get(k) for k in ("date", "flagged", "early_flagged", "late_flagged", "early_hits", "late_hits",
                                               "precision_pct", "late_precision_pct", "recall_top20_pct", "recall_top10_pct", "buyable_flagged")}
                       | {"hits": [{"symbol": h["symbol"], "flag_time": h["flag_time"], "final_rank": h["final_rank"], "lead_h": h.get("lead_h")} for h in c["hits"]],
                          "late": [{"symbol": h["symbol"], "flag_time": h["flag_time"], "rank_24h_at_flag": h.get("rank_24h_at_flag"), "final_rank": h["final_rank"]} for h in c.get("late", [])],
                          "missed": [m["symbol"] for m in c["missed"]][:10]} for c in cards],
        "scorecard_7d": {"days": len(cards), "early_flagged": fl, "flagged": sum(c["flagged"] for c in cards), "early_hits": eh,
                         "late_hits": sum(c["late_hits"] for c in cards),
                         "precision_pct": round(eh / fl * 100, 1) if fl else None,
                         "recall_top20_pct": round(rc / tt * 100, 1) if tt else None},
    }
    jsave(os.path.join(D, "summary.json"), out)
    lb = allb[-1] if allb else None
    jsave(os.path.join(D, "latest.json"), {
        "updated_at": iso(now()), "batch": lb and lb["batch"], "picked_at": lb and lb["picked_at"],
        "btc_24h_pct": lb and lb.get("btc_24h_pct"), "universe": lb and lb.get("universe"),
        "active": sorted(active, key=lambda e: e["picked_at"], reverse=True)[:30],
    })
    print("summary ok", len(allb), "batches")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "hourly"
    if cmd == "hourly":
        seal(); snapshot(); summary()
    elif cmd == "seal":
        seal(); summary()
    elif cmd == "snapshot":
        snapshot(); summary()
    elif cmd == "scorecard":
        scorecard(sys.argv[2] if len(sys.argv) > 2 else None); summary()
    elif cmd == "summary":
        summary()
    else:
        sys.exit("unknown command " + cmd)
