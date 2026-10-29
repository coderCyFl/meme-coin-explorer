"""急升榜 shared core: Binance public REST, 1h-kline features, tier rules, outcome math.

Used by scripts/gainer_board.py (hourly snapshot / 4h+24h seal / daily scorecard) and
scripts/gainer_backtest.py (30d all-coins backtest). The browser (live.js computeGainerBoard)
mirrors FEATURES + RULES below — keep both in sync.

Bars are lists [open_time_ms, o, h, l, c, quote_volume]. Features at index i use bars <= i only.
"""
import json, math, os, re, time, urllib.parse, urllib.request

BN_BASES = ("https://data-api.binance.vision", "https://api.binance.com")
UA = {"User-Agent": "meme-coin-explorer/gainer-board"}
STABLE = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "EURI", "AEUR", "XUSD", "USD1", "BFUSD",
          "USDE", "USDEB", "U", "FRAX", "RLUSD", "USDS", "RWUSD", "PYUSD", "PAXG", "XAUT", "WBTC", "WBETH", "BNSOL"}
LEV_OK = {"JUP", "SYRUP", "SUP"}
# Tokenized single stocks / ETFs ("bStocks", e.g. NVDAB, SOXSB). Detected from Binance metadata — NOT an
# "ends with B" rule (that would wrongly drop BNB, ARB, SHIB, CKB, TRB, BB, DGB, Y …):
#   1. exchangeInfo permissionSets marker TRD_GRP_261 (only bStocks carry it; 100/100 match on 2026-10-25)
#   2. Binance product tag "bStocks" (binance.com bapi; best effort, may be geo-blocked)
#   3. maintained fallback list data/gainer_board/tokenized_stocks.json (refreshed by every Actions run)
TOKENIZED_MARKER = "TRD_GRP_261"
TOKENIZED_LIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "gainer_board", "tokenized_stocks.json")
TOKENIZED = set()          # bases, filled by universe()
TOKENIZED_SOURCE = "none"


def _load_tokenized_list():
    try:
        return set(json.load(open(TOKENIZED_LIST)).get("bases") or [])
    except Exception:  # noqa: BLE001
        return set()


def _bstocks_tag_bases():
    try:
        req = urllib.request.Request("https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products", headers=UA)
        d = json.load(urllib.request.urlopen(req, timeout=15)).get("data") or []
        return {x["b"] for x in d if x.get("q") == "USDT" and "bStocks" in (x.get("tags") or [])}
    except Exception:  # noqa: BLE001
        return set()


def detect_tokenized(ex_symbols):
    """Return (bases, source) for tokenized stocks/ETFs from exchangeInfo symbols (+ tag cross-check)."""
    marker = {s["baseAsset"] for s in ex_symbols
              if any(TOKENIZED_MARKER in ps for ps in (s.get("permissionSets") or []))}
    tag = _bstocks_tag_bases()
    if marker or tag:
        src = "+".join(x for x, v in (("exchangeInfo:" + TOKENIZED_MARKER, marker), ("product-tag:bStocks", tag)) if v)
        return marker | tag, src
    return _load_tokenized_list(), "maintained-list"


def save_tokenized_list(bases, source):
    out = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": source,
           "marker_group": TOKENIZED_MARKER, "count": len(bases), "bases": sorted(bases)}
    try:
        old = json.load(open(TOKENIZED_LIST))
        if old.get("names"):
            out["names"] = {b: old["names"].get(b) for b in sorted(bases) if old["names"].get(b)}
    except Exception:  # noqa: BLE001
        pass
    if bases:
        json.dump(out, open(TOKENIZED_LIST, "w"), ensure_ascii=False, indent=1)
MIN_QV24 = 3e6  # min rolling 24h quote volume (USDT)


def get(path, q=None, timeout=30):
    last = None
    for base in BN_BASES:
        u = base + path + ("?" + urllib.parse.urlencode(q) if q else "")
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=timeout))
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def eligible_symbol(sym):
    if not sym.endswith("USDT"):
        return False
    base = sym[:-4]
    if base in STABLE or base in TOKENIZED:
        return False
    if re.search(r"(UP|DOWN|BULL|BEAR)$", base) and base not in LEV_OK:
        return False
    return True


def universe():
    global TOKENIZED, TOKENIZED_SOURCE
    ex = get("/api/v3/exchangeInfo", {"permissions": "SPOT", "symbolStatus": "TRADING"})
    TOKENIZED, TOKENIZED_SOURCE = detect_tokenized(ex["symbols"])
    if not TOKENIZED:
        TOKENIZED = _load_tokenized_list()
    return [s["symbol"] for s in ex["symbols"]
            if s["status"] == "TRADING" and s["quoteAsset"] == "USDT" and s.get("isSpotTradingAllowed")
            and eligible_symbol(s["symbol"])]


def klines(sym, interval="1h", limit=1000, start=None, end=None):
    q = {"symbol": sym, "interval": interval, "limit": limit}
    if start is not None:
        q["startTime"] = int(start)
    if end is not None:
        q["endTime"] = int(end)
    d = get("/api/v3/klines", q)
    return [[b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[7])] for b in d]


def feats(bars, i):
    """Features at CLOSED bar i (needs i >= 74)."""
    o = lambda k: bars[k][1]; h = lambda k: bars[k][2]; l = lambda k: bars[k][3]
    c = lambda k: bars[k][4]; qv = lambda k: bars[k][5]
    p = c(i)
    def avg_qv(a, b):
        xs = [qv(k) for k in range(a, b)]
        return sum(xs) / len(xs) if xs else 0
    m24 = avg_qv(i - 24, i)
    m24p = avg_qv(i - 25, i - 1)
    m24pp = avg_qv(i - 26, i - 2)
    hi24 = max(h(k) for k in range(i - 23, i + 1))
    hi72 = max(h(k) for k in range(i - 72, i))
    rng = h(i) - l(i)
    return {
        "t": bars[i][0], "p": p,
        "c1": (p / c(i - 1) - 1) * 100, "c4": (p / c(i - 4) - 1) * 100, "c24": (p / c(i - 24) - 1) * 100,
        "qv24": sum(qv(k) for k in range(i - 23, i + 1)),
        "vr": qv(i) / m24 if m24 > 0 else 0,
        "vr1": qv(i - 1) / m24p if m24p > 0 else 0,
        "vr2": qv(i - 2) / m24pp if m24pp > 0 else 0,
        "fh": (p / hi24 - 1) * 100, "hi24": hi24,
        "brk72": (p / hi72 - 1) * 100,
        "wick": (h(i) - p) / rng if rng > 0 else 0,
    }


# ---------------- Tier rules (FROZEN after backtest; see data/gainer_board/backtest_30d.json) ----------------
# Chosen after the 30d all-coins train/test backtest (scripts/gainer_backtest.py):
#  🔥 pump (2026-10-25, QA): EARLY surge trigger, NO 24h minimum —
#           (rolling 1h >= +5% AND 1h quote volume >= 3x the previous-24h hourly average) OR 15m candle >= +5%.
#           Evaluated on closed 15m bars (rolling windows), entry = that 15m close. Old "24h >= +20% & near high"
#           fired too late (e.g. EPIC 10-24 11:00 1h +30% / vol 19.9x but 24h +16.8%) and is no longer required.
#  ⚡ early: 1h quote volume >= 2x its 24h average AND the previous hour >= 1.5x (volume keeps climbing),
#           1h candle >= +3%, but not yet pumped (24h < +15%). Failed the buy gate -> watch-only 「觀察」.
PUMP_C24 = 20.0          # legacy (pre-2026-10-25) rule, kept only for comparison in the backtest
PUMP_FROM_HIGH = -10.0
SURGE_C1, SURGE_VR, SURGE_C15 = 5.0, 3.0, 5.0
EARLY_VR, EARLY_VR1, EARLY_C1, EARLY_C24_MAX = 2.0, 1.5, 3.0, 15.0
COOLDOWN_H = 4  # same symbol+tier not re-flagged within 4h (backtest and live)


def surge_feats(b15, j):
    """Rolling features at CLOSED 15m bar j (needs j >= 99). b15 = 15m bars [t,o,h,l,c,qv]."""
    o, c, q = b15[j][1], b15[j][4], (lambda k: b15[k][5])
    v1 = sum(q(k) for k in range(j - 3, j + 1))
    avg = sum(q(k) for k in range(j - 99, j - 3)) / 24.0
    hi24 = max(b15[k][2] for k in range(j - 95, j + 1))
    return {"t": b15[j][0] + 15 * 60000, "p": c,
            "c15": (c / o - 1) * 100 if o > 0 else 0, "c1": (c / b15[j - 4][4] - 1) * 100,
            "c4": (c / b15[j - 16][4] - 1) * 100, "c24": (c / b15[j - 96][4] - 1) * 100,
            "vr": v1 / avg if avg > 0 else 0, "qv24": sum(q(k) for k in range(j - 95, j + 1)),
            "fh": (c / hi24 - 1) * 100 if hi24 > 0 else 0}


def surge_raw(sf):
    """🔥 price/volume condition WITHOUT the liquidity floor."""
    return (sf["c1"] >= SURGE_C1 and sf["vr"] >= SURGE_VR) or sf["c15"] >= SURGE_C15


def surge_fire(sf):
    if sf["qv24"] < MIN_QV24:
        return False
    return surge_raw(sf)


# ---------------- ⚡ 早期 v2 (2026-10-30b x-early: modest widen + X 熱度早標; still watch-only) ----------------
# Legs on CLOSED 15m bars; suppressed if 🔥 fired in last 4h (bars j-16..j):
#   (a) 起步 — qv>=$3M, not 🔥, 15m>=+2.5%, 1h>=0, prior-24h range>=25%.
#   (b) 細盤 — qv $1.5M..$3M + surge_raw.
#   (c) prec / grind prec_e — MODEST WIDEN 2026-10-30b: qv>=$3M, not 🔥,
#       1h>=+1.2% (was 1.5), vr>=1.5x, 24h%<+15%. Target ~+2–5 early flags/day, not FP explode.
#   (d) X 熱度早標 (x_early_ok) — when x_buzz flips 熱/升溫 AND c24<+15 AND not top-20 AND
#       1h vol≥1.5x → emit ⚡ via=x_buzz (can coexist with prec). Keep 🚩 shill. X stays hourly.
# Capture scorecard UNCHANGED: early = before top20 + c24<15. X is never a buy signal by itself.
# Still fails buy gate on 4h mean → watch-only 「觀察」.
E2_C15, E2_C1_MIN, E2_RNG24, E2_LOW_QV = 2.5, 0.0, 25.0, 1.5e6
E2_PREC_C1, E2_PREC_VR, E2_PREC_C24_MAX = 1.2, 1.5, 15.0
# X 熱度早標 thresholds (Strategy/QA lock 2026-10-30)
X_EARLY_VERDICTS = ("熱", "升溫")
X_EARLY_C24_MAX, X_EARLY_VR = 15.0, 1.5


def early2_feats(b15, j):
    """surge_feats + prior-24h range (bars j-96..j-1). Needs j >= 99."""
    sf = surge_feats(b15, j)
    hi = max(b15[k][2] for k in range(j - 96, j))
    lo = min(b15[k][3] for k in range(j - 96, j))
    sf["rng24"] = (hi / lo - 1) * 100 if lo > 0 else 0
    return sf


def early2_leg(sf):
    """'start' / 'prec' / 'thin' / None for one bar (ignores the recent-🔥 suppression)."""
    if sf["qv24"] >= MIN_QV24:
        if sf["c15"] < SURGE_C15 and sf["c1"] < SURGE_C1:
            if sf["c15"] >= E2_C15 and sf["c1"] >= E2_C1_MIN and sf["rng24"] >= E2_RNG24:
                return "start"
            if sf["c1"] >= E2_PREC_C1 and sf["vr"] >= E2_PREC_VR and sf["c24"] < E2_PREC_C24_MAX:
                return "prec"
        return None
    if sf["qv24"] >= E2_LOW_QV and surge_raw(sf):
        return "thin"
    return None


def early2_at(b15, j):
    """⚡ v2 at closed 15m bar j (needs j >= 115): leg name or None. Suppressed if 🔥 fired in bars j-16..j."""
    if j < 115:
        return None
    for k in range(j - 16, j + 1):
        if surge_fire(surge_feats(b15, k)):
            return None
    return early2_leg(early2_feats(b15, j))


def x_early_ok(verdict, c24, vr, rank24=None):
    """X 熱度早標: 熱/升溫 while still early (c24<15, not top-20, 1h vol≥1.5x).
    Returns True if this X check should emit a ⚡ early flag (via=x_buzz). Shill is display-only."""
    if verdict not in X_EARLY_VERDICTS:
        return False
    if c24 is None or c24 >= X_EARLY_C24_MAX:
        return False
    if vr is None or vr < X_EARLY_VR:
        return False
    if rank24 is not None and rank24 <= 20:
        return False
    return True


# Default exit_plan for ⚡/🔥 paper cards (must appear on every early/🚀 card).
EARLY_EXIT = {"tp": 20.0, "tp2": 50.0, "sl": 10.0, "review_h": 4, "sell_by_h": 12}


def exit_plan_for(tier):
    """Attach to every early2/pump/chase card. ⚡ stays watch_only; plan is for paper if user taps."""
    return dict(EARLY_EXIT)


RULES = {
    "pump": lambda f, btc24=0.0: surge_fire(f),
    "pump_legacy_24h20": lambda f, btc24=0.0: f["c24"] >= PUMP_C24 and f["fh"] >= PUMP_FROM_HIGH,
    "early": lambda f, btc24=0.0: (f["vr"] >= EARLY_VR and f["vr1"] >= EARLY_VR1 and f["c1"] >= EARLY_C1
                                   and f["c24"] < EARLY_C24_MAX),
}
RULE_TEXT = {
    "pump": f"(1h >= +{SURGE_C1:g}% 且 1h 成交 >= {SURGE_VR:g}x 24h 平均) 或 15m >= +{SURGE_C15:g}% · 冇 24h 下限",
    "pump_legacy_24h20": f"24h >= +{PUMP_C24:g}% 且 距 24h 高 <= {abs(PUMP_FROM_HIGH):g}%（舊，已停用）",
    "early2": f"⚡ 起步：15m >= +{E2_C15:g}% 且 1h >= 0 且 前 24h 波幅 >= {E2_RNG24:g}%（未 🔥，>= $3M）／prec：1h >= +{E2_PREC_C1:g}% 且 量 >= {E2_PREC_VR:g}x 且 24h < +{E2_PREC_C24_MAX:g}%／細盤 🔥（${E2_LOW_QV/1e6:g}M–$3M）／X熱度早標：X 熱|升溫 且 24h < +{X_EARLY_C24_MAX:g}% 且 量 >= {X_EARLY_VR:g}x 且未入 top20 · 近 4h 已 🔥 唔重報",
    "early": f"（舊 ⚡，網站已停用）1h 成交 >= {EARLY_VR:g}x 24h 平均 且 上一個鐘 >= {EARLY_VR1:g}x（量持續升）· 1h >= +{EARLY_C1:g}% · 24h < +{EARLY_C24_MAX:g}%",
}


def tier(f, btc24=0.0):
    """Return 'pump' (🔥), 'early' (⚡) or None."""
    if f["qv24"] < MIN_QV24:
        return None
    # 🔥 is decided on 15m bars (surge_fire); this 1h path only yields ⚡ now.
    if RULES["early"](f, btc24):
        return "early"
    return None


def score(f):
    s = (min(max(f["c4"] * 1.2, -20), 30) + min(max(f["c1"] * 2, -15), 20)
         + min(max(math.log2(max(f["vr"], 0.01)) * 8, -5), 20)
         + min(max(f["c24"] / 3, 0), 15) + min(max(15 + f["fh"] * 0.75, -15), 15))
    return round(s, 1)


def outcome(entry, fut, tp=None, sl=None):
    """fut = bars after entry (within horizon). Returns pct numbers."""
    if not fut or not (entry > 0):
        return None
    mg = max(b[2] for b in fut) / entry - 1
    md = min(b[3] for b in fut) / entry - 1
    cl = fut[-1][4] / entry - 1
    r = cl
    if tp or sl:
        for b in fut:
            if sl and b[3] <= entry * (1 - sl):  # conservative: stop first if both in one bar
                r = -sl; break
            if tp and b[2] >= entry * (1 + tp):
                r = tp; break
    return {"max_gain_pct": round(mg * 100, 2), "max_drawdown_pct": round(md * 100, 2),
            "close_pct": round(cl * 100, 2), "exit_rule_pct": round(r * 100, 2),
            "hit20": mg >= 0.20, "hit50": mg >= 0.50}
