"""BTC regime dry-run (2026-10-30h, Strategy+QA). ONE pre-declared rule, no threshold search:
   BTC's last COMPLETED 4h candle (Binance UTC-aligned) before entry closed down (close < open) => setup pick ¼ size (still opens).
Sample: sealed 24h setup type:buy picks (non-chase); primary = 43 without rotation, also 50. Split BY BATCH (~70% / ~30%).
Exits unchanged: setup_20261030e +10/−4/12h, 5m bars, first touch, stop first. Fee 0.2% round trip (0.1%/side taker).
Benchmarks at the same timestamps, same exits, same fee: BTCUSDT and 30 random liquid USDT spot coins (seed 20261030+i,
same draw as dryrun_stop_rotation.py). 5m bars = data.binance.vision daily zips (REST is 451 / flaky from the box).
Secondary (note only): delayed entry — if BTC 4h down, wait for the first BTC 1h candle closing up (max 4h), enter at next 5m open."""
import json, os, sys, datetime, time, urllib.request, urllib.error, zipfile, io, random, re, pathlib
from concurrent.futures import ThreadPoolExecutor
REPO = str(pathlib.Path(__file__).resolve().parents[1])
CM = os.environ.get("MKT_CACHE", "/tmp/stop_rotation_mkt"); os.makedirs(CM, exist_ok=True)
TZ = datetime.timezone(datetime.timedelta(hours=8)); FEE = 0.2; H = 3600_000
log = json.load(open(f"{REPO}/data/picks.json")); outc = json.load(open(f"{REPO}/data/outcomes.json"))["records"]
idx = {e["id"]: (b, e) for b in log["batches"] for e in b["entries"]}
trades = []
for r in outc:
    if r["horizon_h"] != 24: continue
    b, e = idx[r["pick_id"]]
    if e.get("type") != "buy" or e.get("tier") == "chase": continue
    t0 = datetime.datetime.fromisoformat(e["created_at"])
    trades.append(dict(r=r, b=b["id"], e=e, t0=t0, t0ms=int(t0.timestamp() * 1000), setup=e.get("angle") or "untagged",
                       bn=e["chain"] == "binance", sym=e["pair_address"].upper()))
trades.sort(key=lambda t: t["t0"])
DAYS = sorted({(t["t0"] + datetime.timedelta(days=d)).astimezone(datetime.timezone.utc).strftime("%Y-%m-%d") for t in trades for d in (-1, 0, 1)})

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
_S = {}
def series(sym):
    if sym not in _S: _S[sym] = sorted(x for d in DAYS for x in _day(sym, d))
    return _S[sym]

def run_exit(bars_after, entry, tp=10, sl=4, hold_h=12, start_ms=None):
    sp, tpp = entry * (1 - sl / 100), entry * (1 + tp / 100); end = start_ms + hold_h * H; last = None
    for t, o, h, l, c, q in bars_after:
        if t >= end: break
        last = c
        if l <= sp: return -float(sl)
        if h >= tpp: return float(tp)
    return round((last / entry - 1) * 100, 3) if last else None

def pick_ret(t, start_ms=None):
    """Pick return under the rule. start_ms=None → original entry (entry_price_usd, bars opening ≥ t0)."""
    if not t["bn"]: return t["r"]["return_pct"]  # no Binance path (batch-001 Solana): sealed value
    s = series(t["sym"])
    if start_ms is None:
        bars = [x for x in s if x[0] >= t["t0ms"]]
        return run_exit(bars, float(t["e"]["entry_price_usd"]), start_ms=t["t0ms"]) if bars else t["r"]["return_pct"]
    bars = [x for x in s if x[0] >= start_ms]
    return run_exit(bars, bars[0][1], start_ms=start_ms) if bars else None

def bench(sym, t0ms, need_qv=True):
    s = series(sym)
    pre = [x for x in s if t0ms - 24 * H <= x[0] < t0ms]; post = [x for x in s if x[0] + 300_000 > t0ms and x[0] < t0ms + 12 * H]
    if len(post) < 100 or len(pre) < 200: return None
    if need_qv and sum(x[5] for x in pre) < 1.5e6: return None
    return run_exit(post, post[0][1], start_ms=post[0][0])

def btc_4h(t0ms):
    """Last COMPLETED UTC-aligned 4h BTC candle before entry."""
    s = series("BTCUSDT"); start = (t0ms // (4 * H)) * (4 * H) - 4 * H
    w = [x for x in s if start <= x[0] < start + 4 * H]
    if len(w) < 48: return None
    o, c = w[0][1], w[-1][4]
    return dict(open_utc=datetime.datetime.fromtimestamp(start / 1000, datetime.timezone.utc).isoformat()[:16], o=o, c=c, ret_pct=round((c / o - 1) * 100, 3), down=c < o)
def btc_delay(t0ms, max_h=4):
    """First BTC 1h candle (UTC hour-aligned, opened after t0's hour) closing up; enter at its close; max 4h."""
    s = series("BTCUSDT"); h0 = (t0ms // H) * H
    for k in range(1, max_h + 1):
        hs = h0 + k * H; w = [x for x in s if hs <= x[0] < hs + H]
        if len(w) == 12 and w[-1][4] > w[0][1]: return min(hs + H, t0ms + max_h * H)
    return t0ms + max_h * H

info = json.load(open(f"{CM}/exchangeInfo.json"))
tok = set()
try: tok = set(json.load(open(f"{REPO}/data/gainer_board/tokenized_stocks.json")).get("bases") or [])
except Exception: pass
STABLE = {"USDC","FDUSD","TUSD","USDP","DAI","BUSD","EUR","EURI","AEUR","XUSD","USD1","BFUSD","USDE","USDEB","U","FRAX","RLUSD","USDS","RWUSD","PYUSD","PAXG","XAUT","WBTC","WBETH","BNSOL"}
UNI = sorted(x["symbol"] for x in info["symbols"] if x["status"] == "TRADING" and x["quoteAsset"] == "USDT" and x.get("isSpotTradingAllowed")
             and x["baseAsset"] not in STABLE and x["baseAsset"] not in tok and not re.search(r"(UP|DOWN|BULL|BEAR)$", x["baseAsset"]))
with ThreadPoolExecutor(16) as pool:
    list(pool.map(lambda sd: _day(*sd), [(sy, d) for sy in UNI + ["BTCUSDT"] + [t["sym"] for t in trades if t["bn"]] for d in DAYS]))

def rand30(i, t0ms):
    rng = random.Random(20261030 + i); cand = UNI[:]; rng.shuffle(cand); got = []
    for sym in cand:
        if len(got) >= 30: break
        if sym == "BTCUSDT": continue
        r = bench(sym, t0ms)
        if r is not None: got.append(r)
    return sum(got) / len(got) if got else None

for i, t in enumerate(trades):
    t["reg"] = btc_4h(t["t0ms"]); t["down"] = bool(t["reg"] and t["reg"]["down"])
    t["ret"] = pick_ret(t); t["btc"] = bench("BTCUSDT", t["t0ms"], need_qv=False); t["rnd"] = rand30(i, t["t0ms"])
    if t["down"]:
        d = btc_delay(t["t0ms"]); t["delay_h"] = round((d - t["t0ms"]) / H, 2)
        rd = pick_ret(t, d) if t["bn"] else t["ret"]
        t["ret_delay"] = rd if rd is not None else t["ret"]
        t["btc_delay"] = bench("BTCUSDT", d, need_qv=False); t["rnd_delay"] = rand30(i, d)
    else:
        t["ret_delay"], t["btc_delay"], t["rnd_delay"], t["delay_h"] = t["ret"], t["btc"], t["rnd"], 0
    print(f"{i+1}/{len(trades)}", file=sys.stderr)

batches = []
for t in trades:
    if t["b"] not in batches: batches.append(t["b"])
n_in = round(len(batches) * 0.7); IN = set(batches[:n_in])
for t in trades: t["split"] = "in" if t["b"] in IN else "held"

def agg(rs, w, rk="ret", bk="btc", nk="rnd"):
    if not rs: return dict(n=0)
    st = [w(x) for x in rs]; S = sum(st)
    sw = lambda k: sum(s * x[k] for s, x in zip(st, rs)) / S
    pick = sw(rk); btc = sw(bk); rnd = sw(nk)
    return dict(n=len(rs), batches=len({x["b"] for x in rs}), W=sum(1 for x in rs if x[rk] > 0), L=sum(1 for x in rs if x[rk] <= 0),
                n_full=sum(1 for s in st if s == 1), n_quarter=sum(1 for s in st if s != 1),
                ew_fee=round(sum(x[rk] for x in rs) / len(rs) - FEE, 2), sw_fee=round(pick - FEE, 2),
                btc_sw_fee=round(btc - FEE, 2), rnd_sw_fee=round(rnd - FEE, 2),
                btc_ew_fee=round(sum(x[bk] for x in rs) / len(rs) - FEE, 2), rnd_ew_fee=round(sum(x[nk] for x in rs) / len(rs) - FEE, 2),
                excess_vs_btc=round(pick - btc, 2), excess_vs_rnd=round(pick - rnd, 2))
FULL = lambda x: 1
REG = lambda x: 0.25 if x["down"] else 1
SETS = {"43_no_rotation": [t for t in trades if t["setup"] != "rotation"], "50_all": trades}
RES = {}
for name, S in SETS.items():
    RES[name] = {}
    for part in ("all", "in", "held"):
        rs = [x for x in S if part == "all" or x["split"] == part]
        RES[name][part] = dict(no_filter=agg(rs, FULL), regime_quarter=agg(rs, REG),
                               delayed_entry_note=agg(rs, FULL, "ret_delay", "btc_delay", "rnd_delay"),
                               down_only=agg([x for x in rs if x["down"]], FULL), up_only=agg([x for x in rs if not x["down"]], FULL))
    h = RES[name]["held"]; rq, nf = h["regime_quarter"], h["no_filter"]
    RES[name]["verdict"] = dict(
        heldout_beats_btc=rq["sw_fee"] > rq["btc_sw_fee"], heldout_beats_random30=rq["sw_fee"] > rq["rnd_sw_fee"],
        heldout_beats_no_filter=rq["sw_fee"] > nf["sw_fee"],
        PASS=bool(rq["sw_fee"] > rq["btc_sw_fee"] and rq["sw_fee"] > rq["rnd_sw_fee"] and rq["sw_fee"] > nf["sw_fee"]),
        note="PASS also requires the ¼ rule to beat the same picks with no filter on held-out (else the filter adds nothing)")
out = dict(generated_at=datetime.datetime.now(TZ).isoformat(timespec="seconds"),
           rule="BTC last completed UTC 4h candle close<open at entry → setup ¼ size (paper still opens); 🚀/⚡ unchanged",
           exits="+10/−4/12h 5m first touch stop first", fee_rt_pct=FEE,
           benchmarks="BTCUSDT and random-30 liquid USDT spot (prior-24h qv≥$1.5M) at the same timestamps, same exits, same fee; *_sw = weighted by the same stakes",
           split=dict(in_batches=batches[:n_in], held_batches=batches[n_in:]), results=RES,
           rows=[dict(id=t["e"]["id"], batch=t["b"], at=t["e"]["created_at"], setup=t["setup"], split=t["split"], btc4h=t["reg"], down=t["down"],
                      ret=t["ret"], btc=t["btc"], rnd30=t["rnd"], delay_h=t["delay_h"], ret_delay=t["ret_delay"]) for t in trades])
json.dump(out, open(os.environ.get("OUT", "btc-regime-dryrun-20261030.json"), "w"), indent=1, ensure_ascii=False)
print(json.dumps(dict(split=out["split"], results=RES), ensure_ascii=False, indent=1))
