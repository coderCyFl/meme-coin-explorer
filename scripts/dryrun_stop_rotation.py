"""Dry-run (2026-10-30g): stop rotation setup buys, higher_lows at ¼, and early-flag overlap filter.
Replays the sealed 24h type:buy setup picks with setup_20261030e exits (+10/−4/sell_by 12h, 5m first touch, stop first).
Early overlap = ⚡ early2 (start/prec/thin, scripts/gainer_core.early2_at on closed 15m bars) on the SAME coin
fired in [entry−W, entry] (no lookahead), OR a live gainer_board snapshot early/early2 entry in that window."""
import json, os, sys, datetime, time, urllib.request, collections, glob, pathlib
REPO = str(pathlib.Path(__file__).resolve().parents[1]); sys.path.insert(0, REPO + "/scripts")
import gainer_core as gc
C5 = os.environ.get("SETUP_EXIT_CACHE", "/tmp/setup_exit_cache"); C15 = os.environ.get("E2_CACHE", "/tmp/stop_rotation_cache15")
os.makedirs(C5, exist_ok=True); os.makedirs(C15, exist_ok=True)
log = json.load(open(f"{REPO}/data/picks.json")); outc = json.load(open(f"{REPO}/data/outcomes.json"))["records"]
idx = {e["id"]: (b, e) for b in log["batches"] for e in b["entries"]}
API = "https://data-api.binance.vision/api/v3/klines"
def fetch(sym, interval, s, en):
    for _ in range(3):
        time.sleep(0.5)
        try:
            d = json.load(urllib.request.urlopen(f"{API}?symbol={sym}&interval={interval}&startTime={s}&endTime={en}&limit=1000", timeout=20))
            if isinstance(d, list): return d
        except Exception as ex: print("err", sym, ex, file=sys.stderr)
    return None
def k5(sym, t0):
    fn = f"{C5}/{sym}_{int(t0.timestamp())}.json"
    if os.path.exists(fn): return json.load(open(fn))
    s = int(t0.timestamp() * 1000); d = fetch(sym, "5m", s, s + 24 * 3600_000)
    if d is None: return None
    bars = [[int(k[0]), float(k[2]), float(k[3]), float(k[4]), int(k[6])] for k in d]; json.dump(bars, open(fn, "w")); return bars
def k15(sym, t0, back_h=60):
    s = int(t0.timestamp() * 1000) - back_h * 3600_000; fn = f"{C15}/{sym}_{s}.json"
    if os.path.exists(fn): return json.load(open(fn))
    d = fetch(sym, "15m", s, int(t0.timestamp() * 1000))
    if d is None: return None
    bars = [[int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[7])] for k in d]; json.dump(bars, open(fn, "w")); return bars

trades = []
for r in outc:
    if r["horizon_h"] != 24: continue
    b, e = idx[r["pick_id"]]
    if e.get("type") != "buy" or e.get("tier") == "chase": continue
    t0 = datetime.datetime.fromisoformat(e["created_at"])
    trades.append(dict(r=r, b=b, e=e, t0=t0, setup=e.get("angle") or "untagged"))
trades.sort(key=lambda t: t["t0"])

def sim(t, tp=10, sl=4, hold_h=12):
    e = t["e"]
    if e["chain"] != "binance": return t["r"]["return_pct"], "nopath(sealed)"
    bars = k5(e["pair_address"].upper(), t["t0"])
    if not bars: return t["r"]["return_pct"], "nopath(sealed)"
    entry = float(e["entry_price_usd"]); sp = entry * (1 - sl / 100); tpp = entry * (1 + tp / 100)
    end = int(t["t0"].timestamp() * 1000) + hold_h * 3600_000; last = None
    for o, h, l, c, ct in bars:
        if o >= end: break
        last = c
        if l <= sp: return -sl, "stop"
        if h >= tpp: return tp, "tp"
    return round((last / entry - 1) * 100, 2), "sell_by"

# live snapshot early flags
live = collections.defaultdict(list)
for f in glob.glob(f"{REPO}/data/gainer_board/snapshots/*.json"):
    for b in json.load(open(f))["batches"]:
        for x in b["entries"]:
            if x.get("tier") in ("early", "early2"):
                live[x["pair"].upper()].append(datetime.datetime.fromisoformat(x["picked_at"]))

def early_fires(t):
    e = t["e"]
    if e["chain"] != "binance": return None
    b = k15(e["pair_address"].upper(), t["t0"])
    if not b or len(b) < 120: return None
    t0ms = int(t["t0"].timestamp() * 1000); fires = []
    for j in range(115, len(b)):
        close_ms = b[j][0] + 15 * 60000
        if close_ms > t0ms: break
        leg = gc.early2_at(b, j)
        if leg: fires.append((close_ms, leg))
    return fires

for t in trades:
    t["ret"], t["why"] = sim(t)
    t["fires"] = early_fires(t)

def overlap(t, W):
    t0ms = int(t["t0"].timestamp() * 1000)
    rep = [leg for ms, leg in (t["fires"] or []) if t0ms - W * 3600_000 <= ms <= t0ms]
    lv = [x for x in live.get(t["e"]["pair_address"].upper(), []) if t["t0"] - datetime.timedelta(hours=W) <= x <= t["t0"]]
    return bool(rep or lv), rep, len(lv)

def stats(rs, w=None):
    n = len(rs)
    if not n: return dict(n=0)
    W = sum(1 for x in rs if x["ret"] > 0); c = collections.Counter(x["why"] for x in rs)
    d = dict(n=n, W=W, L=n - W, ew=round(sum(x["ret"] for x in rs) / n, 2), tp=c["tp"], sl=c["stop"], sell_by=c["sell_by"], nopath=c["nopath(sealed)"])
    if w:
        stake = [w(x) for x in rs]; d["size_weighted_pct"] = round(sum(s * x["ret"] for s, x in zip(stake, rs)) / sum(stake), 2)
        d["stake_units"] = round(sum(stake), 2); d["pnl_units_per_100"] = round(sum(s * x["ret"] for s, x in zip(stake, rs)), 2)
        d["n_full"] = sum(1 for s in stake if s == 1)
    return d

base = trades; norot = [t for t in trades if t["setup"] != "rotation"]
R = {
    "baseline": stats(base, lambda x: 1),
    "minus_rotation": stats(norot, lambda x: 1),
    "minus_rotation_hl_quarter": stats(norot, lambda x: 0.25 if x["setup"] == "higher_lows" else 1),
}
per = {s: stats([t for t in base if t["setup"] == s]) for s in sorted({t["setup"] for t in base})}
OV = {}
for W in (6, 12, 24):
    for t in norot: t[f"ov{W}"] = overlap(t, W)[0]
    full = [t for t in norot if t[f"ov{W}"]]; rest = [t for t in norot if not t[f"ov{W}"]]
    wq = lambda x, W=W: 1 if x[f"ov{W}"] else (0.25)
    OV[f"W{W}h"] = dict(
        overlap_full_subset=stats(full),
        non_overlap_subset=stats(rest),
        size_weighted_overlap_full_else_quarter=stats(norot, wq),
        size_weighted_overlap_full_else_quarter_hlq=stats(norot, lambda x, W=W: 1 if (x[f"ov{W}"] and x["setup"] != "higher_lows") else 0.25),
        cherry_pick_flag=len(full) < 15,
    )
rows = [dict(id=t["e"]["id"], at=t["e"]["created_at"], sym=t["e"]["symbol"], setup=t["setup"], ret=t["ret"], why=t["why"],
             early_fires_24h=[(datetime.datetime.fromtimestamp(ms/1000, datetime.timezone(datetime.timedelta(hours=8))).isoformat()[:16], leg)
                              for ms, leg in (t["fires"] or []) if int(t["t0"].timestamp()*1000) - 24*3600_000 <= ms],
             live_flags_24h=overlap(t, 24)[2], no_15m=t["fires"] is None) for t in trades]
out = dict(generated_at=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="seconds"),
           rule="setup_20261030e +10/−4/sell_by 12h, 5m first touch, stop first; no-Binance-path rows keep sealed value",
           window=[trades[0]["e"]["created_at"], trades[-1]["e"]["created_at"]], R=R, per_setup=per, overlap=OV, rows=rows)
json.dump(out, open(os.environ.get("OUT", "stop-rotation-dryrun-20261030.json"), "w"), indent=1, ensure_ascii=False)
print(json.dumps(dict(R=R, per=per, overlap=OV), ensure_ascii=False, indent=1))
