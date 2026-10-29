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

# ---------------- QA follow-up (2026-10-30): 35/15 time split, fees, pass criteria ----------------
# Fee: 0.1% per side Binance taker = 0.2% round trip (same as scripts/dryrun_setup_exit.py FEE=0.2 and
# picks.js SPOT_FEE_DEFAULT=0.1 per side). Applied to every trade regardless of stake (it is a % of the stake).
FEE_RT = 0.2
N_IN = 35
for i, t in enumerate(trades): t["split"] = "in" if i < N_IN else "held"
def wstats(rs, w):
    n = len(rs)
    if not n: return dict(n=0)
    stake = [w(x) for x in rs]; S = sum(stake)
    ew = sum(x["ret"] for x in rs) / n; sw = sum(s * x["ret"] for s, x in zip(stake, rs)) / S
    nf = sum(1 for s in stake if s == 1)
    return dict(n=n, W=sum(1 for x in rs if x["ret"] > 0), L=sum(1 for x in rs if x["ret"] <= 0),
                ew=round(ew, 2), ew_fee=round(ew - FEE_RT, 2), sw=round(sw, 2), sw_fee=round(sw - FEE_RT, 2),
                n_full=nf, full_ew=round(sum(x["ret"] for s, x in zip(stake, rs) if s == 1) / nf, 2) if nf else None,
                full_ew_fee=round(sum(x["ret"] for s, x in zip(stake, rs) if s == 1) / nf - FEE_RT, 2) if nf else None,
                n_full_lt15=nf < 15)
SCEN = {
    "baseline": (base, lambda x: 1),
    "minus_rotation": (norot, lambda x: 1),
    "minus_rotation_hl_quarter": (norot, lambda x: 0.25 if x["setup"] == "higher_lows" else 1),
}
for W in (6, 12, 24):
    SCEN[f"overlap_{W}h_full_else_quarter"] = (norot, lambda x, W=W: 1 if x[f"ov{W}"] else 0.25)
SPLIT = {}
for k, (rs, w) in SCEN.items():
    SPLIT[k] = {part: wstats([x for x in rs if part == "all" or x["split"] == part], w) for part in ("all", "in", "held")}
bh = SPLIT["baseline"]["held"]
for k, v in SPLIT.items():
    a, h = v["all"], v["held"]
    c1 = a["n_full"] >= 15
    c2 = a["sw_fee"] >= 0 or a["sw_fee"] >= -1.0   # "clearly better than −2.0%": ≥1.0pt better after fees
    c3 = h["sw"] > bh["sw"] + 0.25 if k != "baseline" else False   # held-out must beat baseline held-out by >0.25pt
    v["qa"] = dict(full_n_ge15=c1, after_fee_ok=c2, heldout_beats_baseline=c3, PASS=bool(c1 and c2 and c3))
out["fee_rt_pct"] = FEE_RT; out["fee_source"] = "0.1%/side taker (repo: dryrun_setup_exit.py FEE=0.2, picks.js SPOT_FEE_DEFAULT=0.1)"
out["split"] = dict(in_sample=[trades[0]["e"]["created_at"], trades[N_IN-1]["e"]["created_at"]],
                    held_out=[trades[N_IN]["e"]["created_at"], trades[-1]["e"]["created_at"]], scenarios=SPLIT)

# ---------------- Market baseline at the same 50 entry timestamps ----------------
# BTCUSDT + 30 random liquid Binance USDT spot coins per timestamp (fixed seed; prior-24h quote vol ≥ $1.5M from 5m bars;
# stables / leveraged / tokenized excluded; current exchangeInfo universe). Entry = open of the 5m bar containing t0.
# Two exits: plain 12h hold, and setup_20261030e (+10/−4/12h first touch, stop first).
import random
from concurrent.futures import ThreadPoolExecutor
CM = os.environ.get("MKT_CACHE", "/tmp/stop_rotation_mkt"); os.makedirs(CM, exist_ok=True)
def get_json(path):
    for k in range(6):  # data-api.binance.vision is flaky (SSL EOF); api.binance.com is 451 here but kept as backup
        host = "https://api.binance.com" if k == 5 else "https://data-api.binance.vision"
        try: return json.load(urllib.request.urlopen(host + path, timeout=12))
        except Exception as ex: print("err", path[:60], ex, file=sys.stderr); time.sleep(1 + k)
    return None
# 5m bars from data.binance.vision daily zips (fast + reliable; the REST data-api is flaky from this box).
import zipfile, io
DAYS = sorted({(t["t0"] + datetime.timedelta(days=d)).astimezone(datetime.timezone.utc).strftime("%Y-%m-%d") for t in trades for d in (-1, 0, 1)})
_SER = {}
def _day(sym, day):
    fn = f"{CM}/{sym}_{day}.csv"
    if not os.path.exists(fn):
        url = f"https://data.binance.vision/data/spot/daily/klines/{sym}/5m/{sym}-5m-{day}.zip"; txt = ""
        for k in range(4):
            try:
                with urllib.request.urlopen(url, timeout=20) as r: txt = zipfile.ZipFile(io.BytesIO(r.read())).read(f"{sym}-5m-{day}.csv").decode(); break
            except urllib.error.HTTPError as ex:
                if ex.code == 404: break
            except Exception as ex: print("zip err", sym, day, ex, file=sys.stderr); time.sleep(1 + k)
        open(fn, "w").write(txt)
    out = []
    for line in open(fn).read().splitlines():
        k = line.split(",")
        if len(k) < 8 or not k[0].isdigit(): continue
        t = int(k[0]); t = t // 1000 if t > 1e14 else t
        out.append([t, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[7])])
    return out
def series(sym):
    if sym not in _SER:
        _SER[sym] = sorted(x for d in DAYS for x in _day(sym, d))
    return _SER[sym]
def bars5(sym, t0ms):
    return [x for x in series(sym) if t0ms - 24*3600_000 <= x[0] < t0ms + 12*3600_000] or None
def mkt_trade(b, t0ms, need_qv=True):
    pre = [x for x in b if x[0] < t0ms and x[0] >= t0ms - 24*3600_000]; post = [x for x in b if x[0] + 300_000 > t0ms and x[0] < t0ms + 12*3600_000]
    if len(post) < 100 or len(pre) < 200: return None
    if need_qv and sum(x[5] for x in pre) < 1.5e6: return None
    entry = post[0][1]; sp, tpp = entry * 0.96, entry * 1.10; plain = (post[-1][4] / entry - 1) * 100; ex = None
    for o_t, o, h, l, c, q in post:
        if l <= sp: ex = -4.0; break
        if h >= tpp: ex = 10.0; break
    if ex is None: ex = plain
    return plain, ex
_xi = f"{CM}/exchangeInfo.json"
info = json.load(open(_xi)) if os.path.exists(_xi) else get_json("/api/v3/exchangeInfo")
if info and not os.path.exists(_xi): json.dump(info, open(_xi, "w"))
tok = set()
try: tok = set(json.load(open(f"{REPO}/data/gainer_board/tokenized_stocks.json")).get("bases") or [])
except Exception: pass
STABLE = {"USDC","FDUSD","TUSD","USDP","DAI","BUSD","EUR","EURI","AEUR","XUSD","USD1","BFUSD","USDE","USDEB","U","FRAX","RLUSD","USDS","RWUSD","PYUSD","PAXG","XAUT","WBTC","WBETH","BNSOL"}
UNI = sorted(x["symbol"] for x in info["symbols"] if x["status"] == "TRADING" and x["quoteAsset"] == "USDT" and x.get("isSpotTradingAllowed")
             and x["baseAsset"] not in STABLE and x["baseAsset"] not in tok and not __import__("re").search(r"(UP|DOWN|BULL|BEAR)$", x["baseAsset"]))
with ThreadPoolExecutor(16) as pool:  # prefetch every universe symbol's daily zips once
    list(pool.map(lambda sd: _day(*sd), [(sy, d) for sy in UNI + ["BTCUSDT"] + [t["e"]["pair_address"].upper() for t in trades if t["e"]["chain"] == "binance"] for d in DAYS]))
MK = []
for i, t in enumerate(trades):
    t0ms = int(t["t0"].timestamp() * 1000); rng = random.Random(20261030 + i)
    cand = UNI[:]; rng.shuffle(cand); got = []
    for sym in cand:
        if len(got) >= 30: break
        if sym == "BTCUSDT": continue
        b = bars5(sym, t0ms)
        r = mkt_trade(b, t0ms) if b else None
        if r: got.append((sym, r))
    bb = bars5("BTCUSDT", t0ms); btc = mkt_trade(bb, t0ms, need_qv=False) if bb else None
    # setup pick plain 12h hold (comparable to the market plain hold)
    pk = None
    if t["e"]["chain"] == "binance":
        pb = bars5(t["e"]["pair_address"].upper(), t0ms); pk = mkt_trade(pb, t0ms, need_qv=False) if pb else None
    MK.append(dict(id=t["e"]["id"], split=t["split"], setup=t["setup"], pick_rule=t["ret"], pick_plain=pk[0] if pk else None,
                   btc_plain=btc[0] if btc else None, btc_rule=btc[1] if btc else None, n_rand=len(got),
                   rand_plain=sum(r[0] for _, r in got) / len(got) if got else None, rand_rule=sum(r[1] for _, r in got) / len(got) if got else None,
                   rand_syms=[s for s, _ in got]))
    print(f"mkt {i+1}/50 n_rand={len(got)}", file=sys.stderr)
def mavg(rows, k):
    xs = [r[k] for r in rows if r[k] is not None]; return round(sum(xs) / len(xs), 2) if xs else None
MKT = {}
for part in ("all", "in", "held"):
    rows = [r for r in MK if part == "all" or r["split"] == part]
    d = {k: mavg(rows, k) for k in ("pick_rule", "pick_plain", "btc_plain", "btc_rule", "rand_plain", "rand_rule")}
    d["n"] = len(rows)
    d["excess_rule_vs_rand_rule"] = round(d["pick_rule"] - d["rand_rule"], 2)
    d["excess_rule_vs_btc_rule"] = round(d["pick_rule"] - d["btc_rule"], 2)
    pr = [r for r in rows if r["pick_plain"] is not None]
    d["n_pick_plain"] = len(pr)
    d["excess_plain_vs_rand_plain"] = round(mavg(pr, "pick_plain") - mavg(pr, "rand_plain"), 2) if pr else None
    d["excess_plain_vs_btc_plain"] = round(mavg(pr, "pick_plain") - mavg(pr, "btc_plain"), 2) if pr else None
    MKT[part] = d
out["market_baseline"] = dict(method="BTCUSDT + 30 random liquid (prior-24h qv≥$1.5M) Binance USDT spot per entry timestamp (5m bars from data.binance.vision daily zips), seed 20261030+i; plain 12h hold and +10/−4/12h 5m first-touch stop-first; returns before fees",
                              summary=MKT, rows=MK)
json.dump(out, open(os.environ.get("OUT", "stop-rotation-dryrun-20261030.json"), "w"), indent=1, ensure_ascii=False)
print(json.dumps(dict(R=R, per=per, overlap=OV, split=SPLIT, market=MKT), ensure_ascii=False, indent=1))
