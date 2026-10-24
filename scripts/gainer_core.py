"""急升榜 shared core: Binance public REST, 1h-kline features, tier rules, outcome math.

Used by scripts/gainer_board.py (hourly snapshot / 4h+24h seal / daily scorecard) and
scripts/gainer_backtest.py (30d all-coins backtest). The browser (live.js computeGainerBoard)
mirrors FEATURES + RULES below — keep both in sync.

Bars are lists [open_time_ms, o, h, l, c, quote_volume]. Features at index i use bars <= i only.
"""
import json, math, re, time, urllib.parse, urllib.request

BN_BASES = ("https://data-api.binance.vision", "https://api.binance.com")
UA = {"User-Agent": "meme-coin-explorer/gainer-board"}
STABLE = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "EURI", "AEUR", "XUSD", "USD1", "BFUSD",
          "USDE", "USDEB", "U", "FRAX", "RLUSD", "USDS", "RWUSD", "PYUSD", "PAXG", "XAUT", "WBTC", "WBETH", "BNSOL"}
LEV_OK = {"JUP", "SYRUP", "SUP"}
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
    if base in STABLE:
        return False
    if re.search(r"(UP|DOWN|BULL|BEAR)$", base) and base not in LEV_OK:
        return False
    return True


def universe():
    ex = get("/api/v3/exchangeInfo")
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
#  🔥 pump : already +20% in 24h and still within 10% of the 24h high (best +20%-in-4h hit-rate found, 8%).
#  ⚡ early: 1h quote volume >= 2x its 24h average AND the previous hour >= 1.5x (volume keeps climbing),
#           1h candle >= +3%, but not yet pumped (24h < +15%). Failed the buy gate -> watch-only 「觀察」.
PUMP_C24 = 20.0
PUMP_FROM_HIGH = -10.0
EARLY_VR, EARLY_VR1, EARLY_C1, EARLY_C24_MAX = 2.0, 1.5, 3.0, 15.0
COOLDOWN_H = 4  # same symbol+tier not re-flagged within 4h (backtest and live)
RULES = {
    "pump": lambda f, btc24=0.0: f["c24"] >= PUMP_C24 and f["fh"] >= PUMP_FROM_HIGH,
    "early": lambda f, btc24=0.0: (f["vr"] >= EARLY_VR and f["vr1"] >= EARLY_VR1 and f["c1"] >= EARLY_C1
                                   and f["c24"] < EARLY_C24_MAX),
}
RULE_TEXT = {
    "pump": f"24h >= +{PUMP_C24:g}% 且 距 24h 高 <= {abs(PUMP_FROM_HIGH):g}%",
    "early": f"1h 成交 >= {EARLY_VR:g}x 24h 平均 且 上一個鐘 >= {EARLY_VR1:g}x（量持續升）· 1h >= +{EARLY_C1:g}% · 24h < +{EARLY_C24_MAX:g}%",
}


def tier(f, btc24=0.0):
    """Return 'pump' (🔥), 'early' (⚡) or None."""
    if f["qv24"] < MIN_QV24:
        return None
    if RULES["pump"](f, btc24):
        return "pump"
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
