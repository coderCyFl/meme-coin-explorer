#!/usr/bin/env python3
"""X-early dry-run vs sealed top-20 (2026-10-25..30). Strategy trial 2026-10-31:
X via=x_buzz uses c24<+8 (tightened from 15); hard seal EARLY still c24<15.
Also reports very_early recall (caught with c24<8). X alone = dry only, no paper.
Original window note: 2026-10-25..29.

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
    """All unique X checks across git versions of x_buzz.json (branch + origin/main)."""
    commits = []
    for rev_args in (
        ["git", "log", "--pretty=%H", "--", "data/gainer_board/x_buzz.json"],
        ["git", "log", "--pretty=%H", "origin/main", "--", "data/gainer_board/x_buzz.json"],
    ):
        try:
            commits += subprocess.check_output(rev_args, text=True, cwd=ROOT).strip().split("\n")
        except Exception:  # noqa: BLE001
            pass
    # de-dupe commit list preserving order
    seen_c, commits_u = set(), []
    for c in commits:
        if c and c not in seen_c:
            seen_c.add(c); commits_u.append(c)
    commits = commits_u
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
    ap.add_argument("--dates", default="2026-10-25:2026-10-30")
    ap.add_argument("--cache", default="/workspace/precursor-dryrun-cache")
    ap.add_argument("--json", default="/workspace/x-early-dryrun-20261030-r2.json")
    ap.add_argument("--x-c24-max", type=float, default=8.0,
                    help="X-alone c24 max (Strategy trial; default 8, was 15)")
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
        """X-alone (trial): 熱/升溫, shill excluded, c24<x_c24_max (default 8), vr>=1.5, not top20.
        Dry numbers only — does NOT open paper."""
        day = dd["date"]
        x_c24 = args.x_c24_max
        caught = []
        for p in dd["pairs"]:
            b = dd["bars"].get(p["pair"]) or []
            checks = [x for x in hot if x.get("symbol") == p["pair"]
                      and (x.get("checked_at") or "")[:10] == day
                      and not x.get("shill_flag")]
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
                c24, vr = sf.get("c24"), sf.get("vr")
                # Trial gate: same as x_early_ok but c24_max from --x-c24-max (8)
                if x.get("verdict") not in g.X_EARLY_VERDICTS:
                    continue
                if c24 is None or c24 >= x_c24:
                    continue
                if vr is None or vr < g.X_EARLY_VR:
                    continue
                # rank unknown historically → treat as not-top20 (None allowed)
                caught.append({"symbol": p["symbol"], "leg": "x_buzz", "c24": round(c24, 2),
                               "t": t_ms, "verdict": x.get("verdict"), "shill": False,
                               "vr": round(vr, 2), "x_c24_max": x_c24})
                break
        return caught

    VE_C24 = 8.0  # very_early column (separate from hard seal c24<15)
    agg = {"e2": {"caught": 0, "n": 0, "per_day": {}},
           "x": {"caught": 0, "n": 0, "per_day": {}},
           "union": {"caught": 0, "n": 0, "per_day": {}},
           "e2_very_early": {"caught": 0, "n": 0, "per_day": {}},
           "union_very_early": {"caught": 0, "n": 0, "per_day": {}}}
    detail = {"e2": {}, "x": {}, "union": {}, "e2_very_early": {}, "union_very_early": {}}

    for dd in day_data:
        e2c = eval_e2(dd)
        xc = eval_x(dd)
        e2s = {c["symbol"] for c in e2c}
        xs = {c["symbol"] for c in xc}
        uni = e2s | xs
        e2_ve = {c["symbol"] for c in e2c if c.get("c24") is not None and c["c24"] < VE_C24}
        # X trial already requires c24<8, so all X counts as very_early; union_ve = e2_ve | xs
        uni_ve = e2_ve | xs
        n = len(dd["pairs"])
        for name, caught_n, syms, rows in (
            ("e2", len(e2s), sorted(e2s), e2c),
            ("x", len(xs), sorted(xs), xc),
            ("union", len(uni), sorted(uni), None),
            ("e2_very_early", len(e2_ve), sorted(e2_ve),
             [c for c in e2c if c["symbol"] in e2_ve]),
            ("union_very_early", len(uni_ve), sorted(uni_ve), None),
        ):
            agg[name]["caught"] += caught_n
            agg[name]["n"] += n
            agg[name]["per_day"][dd["date"]] = {
                "caught": caught_n, "n": n,
                "recall_pct": round(caught_n / n * 100, 1) if n else None,
                "syms": syms,
            }
            if name in ("e2", "x", "e2_very_early"):
                detail[name][dd["date"]] = rows
            else:
                detail[name][dd["date"]] = [
                    {"symbol": s, "via": ("both" if s in e2s and s in xs else "e2" if s in e2s else "x")}
                    for s in syms
                ]
        only_x = xs - e2s
        print(f"{dd['date']}: e2={len(e2s)}/{n} x={len(xs)}/{n} (only_x={sorted(only_x)}) "
              f"union={len(uni)}/{n} ve_e2={len(e2_ve)} ve_u={len(uni_ve)} live={dd['live_recall']}%")

    def pct(a):
        return round(a["caught"] / a["n"] * 100, 1) if a["n"] else None

    live_avg = round(sum(dd["live_recall"] or 0 for dd in day_data) / len(day_data), 1) if day_data else None
    # live seal: any day in window with recall>=10 counts toward real pass narrative
    live_ge10_days = [dd["date"] for dd in day_data if (dd["live_recall"] or 0) >= 10]
    out = {
        "generated_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "window": dates,
        "trial": {
            "x_c24_max": args.x_c24_max,
            "hard_seal_c24_max": 15.0,
            "very_early_c24_max": VE_C24,
            "x_opens_paper": False,
            "note": "Strategy preview 2026-10-31: X tightened to c24<8; hard seal unchanged c24<15; X dry-only",
        },
        "constants": {
            "E2_PREC": [g.E2_PREC_C1, g.E2_PREC_VR, g.E2_PREC_C24_MAX],
            "X_EARLY_shipped": {"verdicts": list(g.X_EARLY_VERDICTS), "c24_max": g.X_EARLY_C24_MAX, "vr": g.X_EARLY_VR},
            "X_EARLY_trial": {"verdicts": list(g.X_EARLY_VERDICTS), "c24_max": args.x_c24_max, "vr": g.X_EARLY_VR, "shill_excluded": True},
        },
        "x_history": {"checks": len(xhist), "hot_warm": len(hot),
                      "note": "Historical X mostly post-🔥; understates prospective early-candidate X targeting"},
        "live_scorecard": [{k: dd[k] for k in ("date", "live_recall", "live_prec", "live_early_hits", "live_early_flagged")} for dd in day_data],
        "live_avg_recall_pct": live_avg,
        "live_ge10_days": live_ge10_days,
        "dry": {
            "e2": {"recall_pct": pct(agg["e2"]), **{k: agg["e2"][k] for k in ("caught", "n", "per_day")}},
            "x_alone": {"recall_pct": pct(agg["x"]), **{k: agg["x"][k] for k in ("caught", "n", "per_day")}},
            "e2_union_x": {"recall_pct": pct(agg["union"]), **{k: agg["union"][k] for k in ("caught", "n", "per_day")}},
            "e2_very_early_c24lt8": {"recall_pct": pct(agg["e2_very_early"]), **{k: agg["e2_very_early"][k] for k in ("caught", "n", "per_day")}},
            "union_very_early_c24lt8": {"recall_pct": pct(agg["union_very_early"]), **{k: agg["union_very_early"][k] for k in ("caught", "n", "per_day")}},
            "x_incremental_pp": round((pct(agg["union"]) or 0) - (pct(agg["e2"]) or 0), 1),
            "old_dry_10_25_29_union_pct": 38.0,
        },
        "detail": detail,
        "gate": {
            "dry_union_recall_ge_10": (pct(agg["union"]) or 0) >= 10,
            "live_seal_ge_10_days": live_ge10_days,
            "note": "Dry ≥10% = trial OK to hand QA; live seal ≥10% is the real pass. X alone does not open paper. 🚀 EW separate.",
        },
    }
    json.dump(out, open(args.json, "w"), ensure_ascii=False, indent=2)
    print("\n=== AGGREGATE (hard EARLY c24<15; X trial c24<%g; very_early c24<8) ===" % args.x_c24_max)
    print(f"live avg recall: {live_avg}%  ge10 days: {live_ge10_days}")
    print(f"dry e2: {pct(agg['e2'])}% ({agg['e2']['caught']}/{agg['e2']['n']})")
    print(f"dry X alone (no paper): {pct(agg['x'])}% ({agg['x']['caught']}/{agg['x']['n']})")
    print(f"dry e2∪X: {pct(agg['union'])}% ({agg['union']['caught']}/{agg['union']['n']})  X lift +{out['dry']['x_incremental_pp']}pp")
    print(f"very_early e2 (c24<8): {pct(agg['e2_very_early'])}% ({agg['e2_very_early']['caught']}/{agg['e2_very_early']['n']})")
    print(f"very_early union: {pct(agg['union_very_early'])}% ({agg['union_very_early']['caught']}/{agg['union_very_early']['n']})")
    print(f"old dry 10/25-29 union: 38.0%")
    print(f"gate dry≥10%: {out['gate']['dry_union_recall_ge_10']}")
    print("wrote", args.json)


if __name__ == "__main__":
    main()
