#!/usr/bin/env python3
"""Which 🔥 coins need an X check right now? (Binance public REST only; makes NO X calls.)

  python3 scripts/x_buzz_targets.py            # prints JSON to stdout, may update the cap block in x_buzz.json
  python3 scripts/x_buzz_targets.py --no-write # never touch x_buzz.json
  python3 scripts/x_buzz_targets.py --pumps-json FILE   # offline/test: use a saved 🔥 list instead of Binance

🔥 = exactly the site's rule (live.js computeGainerBoard / gainer_core): eligible Binance USDT spot
(stables / leveraged / tokenized stocks excluded, 24h quote volume >= $3M), screened by the rolling-4h
range >= 5% (site since 20261025g1: ALL of them, capped at 90 by rolling-4h change — same as here), then on 15m klines (forming bar included, like the site):
first bar in the last 4h with (rolling 1h >= +5% AND 1h vol >= 3x prev-24h hourly avg) OR 15m >= +5%.
⚡ X-early (2026-10-30): also check near-early candidates (c24<15, vr≥1.5, not top-20) so X 熱/升溫 can emit ⚡ before 🔥. Hourly cadence unchanged (no burst).

Per trigger (episode): first check right after the 🔥 trigger, then every RECHECK_MIN while within
HOLD_H of the trigger, at most MAX_CHECKS_PER_TRIGGER checks. Daily budget DAILY_TOTAL_CAP X calls
(counted from data/gainer_board/x_buzz_log.jsonl, Shanghai day); each target costs ~CALLS_PER_TARGET calls.
When the budget is gone: targets = [] and x_buzz.json gets cap.cap_reached = true (site: 「今日 X 額度用完」).

Output: {"generated_at", "cap_reached", "calls_today", "daily_total_cap", "calls_remaining",
         "on_board": [...all current 🔥...], "targets": [{symbol, base, flag, trigger_at, trigger_via,
         price, chg24, checks_this_trigger, last_checked_at, query, count_query, reason}]}
"""
import argparse, datetime, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gainer_core as g  # noqa: E402
import x_buzz_common as xc  # noqa: E402

# ---- configurable (Cyrus may change these) ----
RECHECK_MIN = 30              # recheck a 🔥 coin every 30 min while on board
RECHECK_SLACK_MIN = 3         # routine jitter: a check 27+ min ago counts as due
MAX_CHECKS_PER_TRIGGER = 8    # max X checks per coin per 🔥 trigger
DAILY_TOTAL_CAP = 60          # max X calls per Shanghai day (None = no cap)
CALLS_PER_TARGET = 2          # counts + search
MAX_TARGETS_PER_RUN = 8
HOLD_H = 4                    # 🔥 stays on the board 4h after the trigger (= live.js GB_TRIGGER_H)
SITE_POOL = 90                # live.js GB_POOL_MAX (site scans every >=5%-range coin since 20261025g1)
# Tickers that are everyday words / too short: add crypto context to the X query.
AMBIGUOUS = {"ONE", "GAS", "SUN", "MOVE", "PEOPLE", "ACT", "BANANA", "ME", "AI", "HOOK", "GO", "COOKIE", "TRUMP",
             "ANIME", "EPIC", "BOME", "PIXEL", "PORTAL", "TURBO", "NOT", "DOGS", "CAT", "BIO", "LAYER", "SIGN", "HOME",
             "KERNEL", "INIT", "TREE", "RED", "MAGIC", "BOND", "FLOW", "ID", "OM", "W", "S", "T", "G", "A", "C"}
# Common-word tickers (2026-10-25): X search drops the "$", so "($ANIME OR #ANIME) (crypto OR binance)" also matched
# general anime posts and inflated counts. For these, REQUIRE a coin-form term ("ANIME coin" / "ANIME token" /
# ANIMEUSDT / "$ANIME") AND a market word, and exclude obvious non-crypto senses. count_query == query.
COMMON_WORD_TICKERS = {"ANIME", "EPIC", "GAS", "ONE", "SUN", "MOVE", "PEOPLE", "ACT", "BANANA", "ME", "AI", "HOOK", "GO",
                       "COOKIE", "PIXEL", "PORTAL", "TURBO", "NOT", "DOGS", "CAT", "BIO", "LAYER", "SIGN", "HOME", "KERNEL",
                       "INIT", "TREE", "RED", "MAGIC", "BOND", "FLOW", "ID", "OM", "BANK", "MASK", "GAME", "STORY", "PUMP",
                       "TRUTH", "SOLO", "PROM", "EDU", "ERA", "NIL", "WIN", "HIGH", "CHESS", "COW", "DUSK", "FUN", "HOT", "LUNA"}
NON_CRYPTO_EXCLUDE = {
    "ANIME": ["manga", "episode", "season", "waifu", "cosplay", "crunchyroll", "netflix", "studio", "fanart"],
    "EPIC": ["\"epic games\"", "fortnite", "\"epic store\"", "\"epic fail\"", "unreal"],
    "GAS": ["petrol", "\"gas station\"", "\"gas prices\"", "diesel", "\"natural gas\"", "stove"],
    "SUN": ["weather", "sunset", "sunscreen", "beach"],
    "MOVE": ["movie", "football", "transfer"],
    "PEOPLE": ["magazine", "celebrity"],
    "COOKIE": ["recipe", "baking", "browser"],
    "HOME": ["\"real estate\"", "mortgage", "decor"],
    "RED": ["wine", "lipstick"],
    "MAGIC": ["\"magic the gathering\"", "orlando", "nba"],
    "GAME": ["playstation", "xbox", "nintendo"],
    "CAT": ["kitten", "meow", "vet"],
    "DOGS": ["puppy", "vet", "adopt"],
    "BANANA": ["recipe", "smoothie"],
    "TREE": ["garden", "christmas"],
    "BIO": ["instagram", "\"link in bio\""],
}
MARKET_WORDS = "(binance OR crypto OR pump OR listing OR price OR chart OR usdt)"


def query_for(base):
    if base in COMMON_WORD_TICKERS:
        coin = f'("{base} coin" OR "{base} token" OR {base}USDT OR "${base}")'
        neg = " ".join("-" + w for w in NON_CRYPTO_EXCLUDE.get(base, []))
        return f"{coin} {MARKET_WORDS}{' ' + neg if neg else ''} lang:en -is:retweet"
    tag = f"${base}" if re.match(r"^[A-Za-z][A-Za-z0-9_]*$", base) else f'"{base}"'
    hasht = f"#{base}" if re.match(r"^[A-Za-z][A-Za-z0-9_]*$", base) else ""
    core = f"({tag} OR {hasht})" if hasht else tag
    ctx = " (crypto OR binance)" if (len(base) <= 4 or base in AMBIGUOUS or not hasht) else ""
    return f"{core}{ctx} lang:en -is:retweet"


def rolling(symbols, window):
    out = {}
    for i in range(0, len(symbols), 100):
        chunk = symbols[i:i + 100]
        for x in g.get("/api/v3/ticker", {"type": "MINI", "windowSize": window, "symbols": json.dumps(chunk, separators=(",", ":"), ensure_ascii=False)}):
            out[x["symbol"]] = {k: float(x[k]) for k in ("openPrice", "highPrice", "lowPrice", "lastPrice")}
    return out


def fire(f):
    return (f["c1"] >= g.SURGE_C1 and f["vr"] >= g.SURGE_VR) or f["c15"] >= g.SURGE_C15


def current_pumps():
    """Current 🔥 rows, same as the site's board."""
    listed = set(g.universe())
    elig = []
    for x in g.get("/api/v3/ticker/24hr", {"type": "MINI"}):
        s = x["symbol"]
        if s not in listed:
            continue
        last, op, qv = float(x["lastPrice"]), float(x["openPrice"]), float(x["quoteVolume"])
        if last > 0 and op > 0 and qv >= g.MIN_QV24:
            elig.append({"symbol": s, "base": s[:-4], "price": last, "chg24": (last / op - 1) * 100})
    r4 = rolling([e["symbol"] for e in elig], "4h")
    rng = lambda e: (r4[e["symbol"]]["highPrice"] / r4[e["symbol"]]["lowPrice"] - 1) * 100 if e["symbol"] in r4 and r4[e["symbol"]]["lowPrice"] > 0 else 0
    c4 = lambda e: (r4[e["symbol"]]["lastPrice"] / r4[e["symbol"]]["openPrice"] - 1) * 100 if e["symbol"] in r4 and r4[e["symbol"]]["openPrice"] > 0 else 0
    # Site (20261025g1) screens every >=5%-range coin by rolling-4h change (cap SITE_POOL); same here.
    pool = sorted([e for e in elig if rng(e) >= g.SURGE_C15], key=lambda e: -c4(e))
    for i, e in enumerate(pool):
        e["site_pool"] = i < SITE_POOL
    now_ms = time.time() * 1000
    cutoff = now_ms - HOLD_H * 3600e3
    out = []
    for e in pool:
        try:
            b = g.klines(e["symbol"], "15m", 120)
        except Exception as ex:  # noqa: BLE001
            print("15m fail", e["symbol"], ex, file=sys.stderr)
            continue
        time.sleep(0.05)
        m = len(b)
        if m < 101:
            continue
        b[-1] = [b[-1][0], b[-1][1], max(b[-1][2], e["price"]), b[-1][3], e["price"], b[-1][5]]  # forming bar @ live px
        for j in range(max(99, m - 17), m):
            f = g.surge_feats(b, j)
            if f["t"] < cutoff:
                continue
            if fire(f):
                t = now_ms if j == m - 1 else f["t"]
                out.append({**e, "trigger_at": xc.iso(datetime.datetime.fromtimestamp(t / 1000, xc.TZ)),
                            "trigger_via": "1h+vol" if (f["c1"] >= g.SURGE_C1 and f["vr"] >= g.SURGE_VR) else "15m",
                            "trigger_price": f["p"]})
                break
    out.sort(key=lambda r: (not r.get("site_pool", True), -xc.parse_ts(r["trigger_at"]).timestamp()))
    return out


def current_early_candidates(limit=12):
    """Near-early coins for X 熱度早標 targeting (NOT yet 🔥). c24<15, 1h vol≥1.5x, rank>20.
    Cheap ticker pre-filter then 15m confirm. Caps at `limit` by |c24| then vr."""
    listed = set(g.universe())
    elig = []
    for x in g.get("/api/v3/ticker/24hr", {"type": "MINI"}):
        s = x["symbol"]
        if s not in listed:
            continue
        last, op, qv = float(x["lastPrice"]), float(x["openPrice"]), float(x["quoteVolume"])
        if last <= 0 or op <= 0 or qv < g.MIN_QV24:
            continue
        c24 = (last / op - 1) * 100
        if not (0 <= c24 < g.X_EARLY_C24_MAX):
            continue
        elig.append({"symbol": s, "base": s[:-4], "price": last, "chg24": c24, "qv": qv})
    elig.sort(key=lambda e: -e["chg24"])
    # rank proxy: position in full 24h leaderboard among listed USDT (approx via sorted elig of ALL would be better)
    allt = []
    for x in g.get("/api/v3/ticker/24hr", {"type": "MINI"}):
        s = x["symbol"]
        if s not in listed:
            continue
        last, op = float(x["lastPrice"]), float(x["openPrice"])
        if last > 0 and op > 0:
            allt.append((s, (last / op - 1) * 100))
    allt.sort(key=lambda z: -z[1])
    rank = {s: i + 1 for i, (s, _) in enumerate(allt)}
    out = []
    for e in elig[:40]:
        if rank.get(e["symbol"], 999) <= 20:
            continue
        try:
            b = g.klines(e["symbol"], "15m", 120)
        except Exception as ex:  # noqa: BLE001
            print("15m fail early", e["symbol"], ex, file=sys.stderr)
            continue
        time.sleep(0.05)
        m = len(b)
        if m < 101:
            continue
        b[-1] = [b[-1][0], b[-1][1], max(b[-1][2], e["price"]), b[-1][3], e["price"], b[-1][5]]
        sf = g.surge_feats(b, m - 1)
        if sf["vr"] < g.X_EARLY_VR:
            continue
        if g.surge_fire(sf):  # already 🔥 territory — leave to pump path
            continue
        out.append({**e, "rank": rank.get(e["symbol"]), "vr": round(sf["vr"], 2),
                    "trigger_at": xc.iso(datetime.datetime.fromtimestamp(sf["t"] / 1000, xc.TZ)),
                    "trigger_via": "x_early_cand", "trigger_price": sf["p"]})
        if len(out) >= limit:
            break
    return out


def plan(pumps, buzz, log, t_now=None, early_cands=None):
    t_now = t_now or xc.now()
    day = t_now.strftime("%Y-%m-%d")
    used = xc.calls_on(day, log)
    remaining = None if DAILY_TOTAL_CAP is None else max(0, DAILY_TOTAL_CAP - used)
    cap_reached = remaining is not None and remaining < CALLS_PER_TARGET
    slots = MAX_TARGETS_PER_RUN if remaining is None else min(MAX_TARGETS_PER_RUN, remaining // CALLS_PER_TARGET)
    hist = buzz.get("history") or []
    def _due_from(items, flag):
        out = []
        for p in items:
            sym = p["symbol"]
            trig = xc.parse_ts(p["trigger_at"])
            prev = (buzz.get("coins") or {}).get(sym) or {}
            try:
                st = xc.parse_ts(prev.get("trigger_at"))
                if t_now - st < datetime.timedelta(hours=HOLD_H) and abs((trig - st).total_seconds()) < HOLD_H * 3600:
                    trig = st
            except Exception:  # noqa: BLE001
                pass
            if t_now - trig >= datetime.timedelta(hours=HOLD_H):
                continue
            trig_iso = xc.iso(trig)
            mine = [h for h in hist if h.get("symbol") == sym and _same(h.get("trigger_at"), trig)]
            n = len(mine)
            last = max((xc.parse_ts(h["checked_at"]) for h in mine), default=None)
            if n >= MAX_CHECKS_PER_TRIGGER:
                continue
            if last and t_now - last < datetime.timedelta(minutes=RECHECK_MIN - RECHECK_SLACK_MIN):
                continue
            q = query_for(p["base"])
            out.append({"symbol": sym, "base": p["base"], "flag": flag, "trigger_at": trig_iso,
                        "trigger_via": p.get("trigger_via"), "site_pool": p.get("site_pool", True), "price": p.get("price"),
                        "chg24": round(p["chg24"], 2) if p.get("chg24") is not None else None,
                        "checks_this_trigger": n, "last_checked_at": xc.iso(last) if last else None,
                        "query": q, "count_query": q, "reason": "first" if n == 0 else "recheck"})
        return out

    due_pump = _due_from(pumps, "pump")
    # early candidates share the same hourly budget; pumps keep priority
    early = early_cands or []
    pump_syms = {p["symbol"] for p in pumps}
    early = [e for e in early if e["symbol"] not in pump_syms]
    due_early = _due_from(early, "early")
    # never-checked first; pumps before early; site_pool; newest trigger
    due = due_pump + due_early
    due.sort(key=lambda d: (d["flag"] != "pump", d["checks_this_trigger"] > 0, not d.get("site_pool", True),
                            -xc.parse_ts(d["trigger_at"]).timestamp()))
    targets = [] if cap_reached else due[:slots]
    return {"generated_at": xc.iso(t_now), "cap_reached": cap_reached, "calls_today": used,
            "daily_total_cap": DAILY_TOTAL_CAP, "calls_remaining": remaining,
            "config": {"RECHECK_MIN": RECHECK_MIN, "MAX_CHECKS_PER_TRIGGER": MAX_CHECKS_PER_TRIGGER,
                       "DAILY_TOTAL_CAP": DAILY_TOTAL_CAP, "CALLS_PER_TARGET": CALLS_PER_TARGET,
                       "MAX_TARGETS_PER_RUN": MAX_TARGETS_PER_RUN},
            "on_board": [{"symbol": p["symbol"], "trigger_at": p["trigger_at"], "via": p.get("trigger_via"), "site_pool": p.get("site_pool", True)} for p in pumps],
            "early_cands": [{"symbol": e["symbol"], "chg24": e.get("chg24"), "vr": e.get("vr"), "rank": e.get("rank")} for e in early],
            "due_total": len(due), "due_pump": len(due_pump), "due_early": len(due_early), "targets": targets}


def _same(a, trig):
    try:
        return abs((xc.parse_ts(a) - trig).total_seconds()) < 60
    except Exception:  # noqa: BLE001
        return False


def update_cap(buzz, res):
    cap = {"date": res["generated_at"][:10], "daily_total_cap": res["daily_total_cap"],
           "calls_today": res["calls_today"], "cap_reached": res["cap_reached"]}
    old = {k: (buzz.get("cap") or {}).get(k) for k in cap}
    if old == cap:
        return False
    buzz["cap"] = dict(cap, updated_at=res["generated_at"])
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--pumps-json")
    ap.add_argument("--now")
    a = ap.parse_args()
    t_now = xc.parse_ts(a.now).astimezone(xc.TZ) if a.now else xc.now()
    pumps = json.load(open(a.pumps_json)) if a.pumps_json else current_pumps()
    early = [] if a.pumps_json else current_early_candidates()
    buzz = xc.load_buzz()
    res = plan(pumps, buzz, xc.read_log(), t_now, early_cands=early)
    if not a.no_write and update_cap(buzz, res):
        xc.save_buzz(buzz)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
