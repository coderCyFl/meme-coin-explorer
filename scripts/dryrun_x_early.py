#!/usr/bin/env python3
"""X-early + modest prec widen dry-run vs sealed top-20 (2026-10-25..29).

Reports (SEPARATE from 🚀 EW):
  - live scorecard recall (~3%)
  - dry e2∪prec (shipped / widened)
  - dry X-alone (from mined x_buzz history 熱/升溫 checks)
  - dry e2∪prec∪X union
  - X incremental lift vs e2∪prec

X history is sparse (checks were mostly post-🔥). X-alone uses real checks only —
no synthetic buzz. Prospective early-candidate X targeting is new; dry numbers understate
future lift until live seals accumulate.

Usage: python3 scripts/dryrun_x_early.py [--cache DIR]
"""
from __future__ import annotations
import argparse, datetime, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402
import dryrun_precursor as dp  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TZ = datetime.timezone(datetime.timedelta(hours=8))


def mine_x_history():
    """All unique X checks across git versions of x_buzz.json."""
    try:
        commits = subprocess.check_output(
            ["git", "log", "--pretty=%H", "--", "data/gainer_board/x_buzz.json"],
            text=True, cwd=ROOT).strip().split("\n")
    except Exception:  # noqa: BLE001
        commits = []
    seen, out = set(), []
    for c in commits:
        if not c:
            continue
        try:
            raw = subprocess.check_output(
                ["git", "show", f"{c}:data/gainer_board/x_buzz.json"],
                text=True, stderr=subprocess.DEVNULL, cwd=ROOT)
            d = json.loads(raw)
        except Exception:  # noqa: BLE001
            continue
        for x in (d.get("history") or []):
            key = (x.get("symbol"), x.get("checked_at"), x.get("verdict"))
            if key in seen:
                continue
            seen.add(key)
            out.append(x)
        for x in (d.get("coins") or {}).values():
            key = (x.get("symbol"), x.get("checked_at"), x.get("verdict"))
            if key in seen:
                continue
            seen.add(key)
            out.append(x)
    # also current file
    try:
        d = json.load(open(os.path.join(ROOT, "data/gainer_board/x_buzz.json")))
        for x in (d.get("history") or []) + list((d.get("coins") or {}).values()):
            key = (x.get("symbol"), x.get("checked_at"), x.get("verdict"))
            if key in seen:
                continue
            seen.add(key)
            out.append(x)
    except Exception:  # noqa: BLE001
        pass
    return out


def feats_at(b15, t_ms):
    """Closed 15m bar features at/just before t_ms."""
    if len(b15) < 116:
        return None
    best = None
    for j in range(115, len(b15)):
        close_t = b15[j][0] + 15 * 60_000
        if close_t > t_ms:
            break
        best = j
    if best is None:
        return None
    return g.early2_feats(b15, best), best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates", default="2026-10-25:2026-10-29")
    ap.add_argument("--cache", default="/workspace/precursor-dryrun-cache")
    ap.add_argument("--json", default="/workspace/x-early-dryrun-20261030.json")
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

    cards = dp.load_days(dates)
    xhist = mine_x_history()
    hot = [x for x in xhist if x.get("verdict") in g.X_EARLY_VERDICTS]
    print(f"X history checks={len(xhist)} hot/warm={len(hot)}", flush=True)

    # Rules: shipped e2 (with NEW widened prec constants already in gainer_core),
    # X-alone, union.
    e2_fn = dp.early2_shipped_leg(None)

    day_data = []
    for card in cards:
        date = card["date"]
        fs, fe, ds, de = dp.day_bounds(date)
        pairs = []
        for t in card["top20"]:
            sym = t["symbol"]
            pair = sym if sym.endswith("USDT") else sym + "USDT"
            pairs.append({"symbol": sym, "pair": pair, "rank": t["rank"], "chg24": t["change_24h"]})
        print(f"fetch {date} top20…", flush=True)
        bars_map = {}
        for p in pairs:
            try:
                bars_map[p["pair"]] = dp.fetch15(p["pair"], fs, fe, args.cache)
            except Exception as e:  # noqa: BLE001
                print("  fail", p["pair"], e, file=sys.stderr)
                bars_map[p["pair"]] = []
        day_data.append({
            "date": date, "pairs": pairs, "bars": bars_map, "ds": ds, "de": de,
            "live_recall": card.get("recall_top20_pct"), "live_prec": card.get("precision_pct"),
            "live_early_hits": card.get("early_hits"), "live_early_flagged": card.get("early_flagged"),
        })

    def eval_e2(dd):
        caught = []
        for p in dd["pairs"]:
            b = dd["bars"].get(p["pair"]) or []
            hit = dp.first_fire(b, dd["ds"], dd["de"], e2_fn)
            if hit:
                caught.append({"symbol": p["symbol"], "leg": hit["leg"], "c24": hit["c24"], "t": hit["t"]})
        return caught

    def eval_x(dd):
        """X-alone: first 熱/升溫 check that day on this pair while x_early_ok on bar feats."""
        day = dd["date"]
        caught = []
        for p in dd["pairs"]:
            b = dd["bars"].get(p["pair"]) or []
            checks = [x for x in hot if x.get("symbol") == p["pair"]
                      and (x.get("checked_at") or "")[:10] == day]
            checks.sort(key=lambda x: x.get("checked_at") or "")
            for x in checks:
                try:
                    t_ms = int(datetime.datetime.fromisoformat(x["checked_at"]).timestamp() * 1000)
                except Exception:  # noqa: BLE001
                    continue
                if t_ms < dd["ds"] or t_ms > dd["de"]:
                    continue
                got = feats_at(b, t_ms)
                if not got:
                    continue
                sf, _j = got
                # rank unknown historically → None (x_early_ok allows None)
                if g.x_early_ok(x.get("verdict"), sf.get("c24"), sf.get("vr"), None):
                    caught.append({"symbol": p["symbol"], "leg": "x_buzz", "c24": round(sf["c24"], 2),
                                   "t": t_ms, "verdict": x.get("verdict"), "shill": bool(x.get("shill_flag")),
                                   "vr": round(sf["vr"], 2)})
                    break
        return caught

    agg = {"e2": {"caught": 0, "n": 0, "per_day": {}},
           "x": {"caught": 0, "n": 0, "per_day": {}},
           "union": {"caught": 0, "n": 0, "per_day": {}}}
    detail = {"e2": {}, "x": {}, "union": {}}

    for dd in day_data:
        e2c = eval_e2(dd)
        xc = eval_x(dd)
        e2s = {c["symbol"] for c in e2c}
        xs = {c["symbol"] for c in xc}
        uni = e2s | xs
        n = len(dd["pairs"])
        for name, caught_n, syms, rows in (
            ("e2", len(e2s), sorted(e2s), e2c),
            ("x", len(xs), sorted(xs), xc),
            ("union", len(uni), sorted(uni), None),
        ):
            agg[name]["caught"] += caught_n
            agg[name]["n"] += n
            agg[name]["per_day"][dd["date"]] = {
                "caught": caught_n, "n": n,
                "recall_pct": round(caught_n / n * 100, 1) if n else None,
                "syms": syms,
            }
            detail[name][dd["date"]] = rows if rows is not None else [
                {"symbol": s, "via": ("both" if s in e2s and s in xs else "e2" if s in e2s else "x")}
                for s in syms
            ]
        # incremental: X catches not in e2
        only_x = xs - e2s
        print(f"{dd['date']}: e2={len(e2s)}/{n} x={len(xs)}/{n} (only_x={sorted(only_x)}) union={len(uni)}/{n}  live={dd['live_recall']}%")

    def pct(a):
        return round(a["caught"] / a["n"] * 100, 1) if a["n"] else None

    live_avg = round(sum(dd["live_recall"] or 0 for dd in day_data) / len(day_data), 1) if day_data else None
    out = {
        "generated_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "window": dates,
        "constants": {
            "E2_PREC": [g.E2_PREC_C1, g.E2_PREC_VR, g.E2_PREC_C24_MAX],
            "X_EARLY": {"verdicts": list(g.X_EARLY_VERDICTS), "c24_max": g.X_EARLY_C24_MAX, "vr": g.X_EARLY_VR},
        },
        "x_history": {"checks": len(xhist), "hot_warm": len(hot),
                      "note": "Historical X mostly post-🔥; understates prospective early-candidate X targeting"},
        "live_scorecard": [{k: dd[k] for k in ("date", "live_recall", "live_prec", "live_early_hits", "live_early_flagged")} for dd in day_data],
        "live_avg_recall_pct": live_avg,
        "dry": {
            "e2_widened": {"recall_pct": pct(agg["e2"]), **{k: agg["e2"][k] for k in ("caught", "n", "per_day")}},
            "x_alone": {"recall_pct": pct(agg["x"]), **{k: agg["x"][k] for k in ("caught", "n", "per_day")}},
            "e2_union_x": {"recall_pct": pct(agg["union"]), **{k: agg["union"][k] for k in ("caught", "n", "per_day")}},
            "x_incremental_pp": round((pct(agg["union"]) or 0) - (pct(agg["e2"]) or 0), 1),
            "baseline_prior_e2_union_prec_e_pct": 36.0,
        },
        "detail": detail,
        "gate": {
            "dry_union_recall_ge_10": (pct(agg["union"]) or 0) >= 10,
            "live_seal_ge_10_is_real_pass": False,
            "note": "Dry ≥10% = trial OK to hand QA; live seal ≥10% is the real pass. 🚀 EW is a separate track.",
        },
    }
    json.dump(out, open(args.json, "w"), ensure_ascii=False, indent=2)
    print("\n=== AGGREGATE ===")
    print(f"live avg recall: {live_avg}%")
    print(f"dry e2 (widened prec 1.2/1.5/15): {pct(agg['e2'])}% ({agg['e2']['caught']}/{agg['e2']['n']})")
    print(f"dry X alone: {pct(agg['x'])}% ({agg['x']['caught']}/{agg['x']['n']})")
    print(f"dry e2∪X: {pct(agg['union'])}% ({agg['union']['caught']}/{agg['union']['n']})  X lift +{out['dry']['x_incremental_pp']}pp")
    print(f"prior dry e2∪prec_e: 36%")
    print(f"gate dry≥10%: {out['gate']['dry_union_recall_ge_10']}")
    print("wrote", args.json)


if __name__ == "__main__":
    main()
