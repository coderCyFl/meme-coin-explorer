#!/usr/bin/env python3
"""Merge X-buzz results (from the Grok Bot routine) into data/gainer_board/x_buzz.json + log every X call.

  python3 scripts/x_buzz_write.py < results.json

stdin:
{
 "coins": [{
   "symbol": "ANIMEUSDT",              # Binance pair (base+USDT) as given by x_buzz_targets.py
   "trigger_at": "2026-10-25T00:00:00+08:00",   # copy from the target (episode key)
   "checked_at": "2026-10-25T03:30:00+08:00",
   "posts_last_1h": 42, "posts_prev_6h_avg_per_h": 10.0, "spike_ratio": 4.2,   # from X counts
   "verdict": "熱" | "升溫" | "冷", "one_line": "≤20 字廣東話",
   "shill_flag": false,                 # many low-follower/new accounts, copy-paste promo, 'gem 100x' style
   "big_accounts": 1,                   # authors with >= 100k followers in the sample
   "top_posts": [{"id": "1850...", "url": "https://x.com/u/status/1850...", "text": "≤140", "likes": 10,
                  "author_username": "u", "author_followers": 1234,
                  "created_at": "2026-10-25T03:12:00+08:00"}]                  # up to 3; created_at optional
 }],
 "calls": [{"ts": ISO, "symbol": "ANIMEUSDT", "tool": "counts" | "search", "query": "...", "result_count": 42}]
}

Every valid call is appended to data/gainer_board/x_buzz_log.jsonl (the daily cap counts these lines).
Invalid coins are rejected one by one (listed on stderr, exit code 2); valid ones are still merged.
A garbage payload (not JSON / wrong top-level shape) writes nothing and exits 1.
"""
import datetime, json, math, re, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_buzz_common as xc  # noqa: E402

SYM_RE = re.compile(r"^[A-Z0-9]{1,20}USDT$")
USER_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
ID_RE = re.compile(r"^[0-9]{5,25}$")
MAX_TEXT, MAX_LINE, MAX_POSTS = 140, 20, 3
FUTURE_SLACK = datetime.timedelta(minutes=10)
MAX_AGE = datetime.timedelta(hours=6)


class Bad(Exception):
    pass


def _num(v, name, integer=False, allow_none=False):
    if v is None and allow_none:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
        raise Bad(f"{name} must be a number")
    if v < 0 or v > 1e9:
        raise Bad(f"{name} out of range")
    if integer:
        if isinstance(v, float) and not v.is_integer():
            raise Bad(f"{name} must be an integer")
        return int(v)
    return round(float(v), 2)


def _ts(v, name, t_now, check_age=True):
    try:
        d = xc.parse_ts(v)
    except Exception:  # noqa: BLE001
        raise Bad(f"{name} not ISO time")
    if d - t_now > FUTURE_SLACK:
        raise Bad(f"{name} in the future")
    if check_age and t_now - d > MAX_AGE:
        raise Bad(f"{name} older than 6h")
    return d


def _clean(s):
    s = re.sub(r"https?://t\.co/\S+", "", s)
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def coin(c, t_now):
    if not isinstance(c, dict):
        raise Bad("coin not an object")
    sym = str(c.get("symbol", "")).upper().strip()
    if SYM_RE.match(sym) is None and re.match(r"^[A-Z0-9]{1,20}$", sym):
        sym += "USDT"
    if not SYM_RE.match(sym):
        raise Bad(f"bad symbol {c.get('symbol')!r}")
    checked = _ts(c.get("checked_at"), "checked_at", t_now)
    trig = _ts(c.get("trigger_at"), "trigger_at", t_now, check_age=False)
    if t_now - trig > datetime.timedelta(hours=xc.HISTORY_H):
        raise Bad("trigger_at older than 48h")
    verdict = c.get("verdict")
    if verdict not in xc.VERDICTS:
        raise Bad(f"verdict must be one of {xc.VERDICTS}")
    line = c.get("one_line", "")
    if not isinstance(line, str):
        raise Bad("one_line must be text")
    line = _clean(line)
    if len(line) > MAX_LINE:
        raise Bad(f"one_line > {MAX_LINE} chars")
    if not isinstance(c.get("shill_flag", False), bool):
        raise Bad("shill_flag must be true/false")
    posts = c.get("top_posts") or []
    if not isinstance(posts, list) or len(posts) > MAX_POSTS:
        raise Bad(f"top_posts must be a list of <= {MAX_POSTS}")
    tp = []
    for p in posts:
        if not isinstance(p, dict):
            raise Bad("post not an object")
        pid, user = str(p.get("id", "")), str(p.get("author_username", "")).lstrip("@")
        if not ID_RE.match(pid):
            raise Bad(f"bad post id {pid!r}")
        if not USER_RE.match(user):
            raise Bad(f"bad author_username {user!r}")
        url = p.get("url")
        if url is not None and not re.match(r"^https://(x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/" + pid + r"(\?.*)?$", str(url)):
            raise Bad(f"post url doesn't match id {pid}")
        text = p.get("text", "")
        if not isinstance(text, str):
            raise Bad("post text must be text")
        text = _clean(text)
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT - 1] + "…"
        post = {"id": pid, "url": f"https://x.com/{user}/status/{pid}", "text": text,
                "likes": _num(p.get("likes", 0), "likes", True), "author_username": user,
                "author_followers": _num(p.get("author_followers", 0), "author_followers", True)}
        # Optional post time (search window ≈ 7h). Missing / unparseable / future → simply omitted.
        if p.get("created_at"):
            try:
                ca = xc.parse_ts(p.get("created_at"))
                if ca - t_now <= FUTURE_SLACK:
                    post["created_at"] = xc.iso(ca)
            except Exception:  # noqa: BLE001
                pass
        tp.append(post)
    p1 = _num(c.get("posts_last_1h"), "posts_last_1h", True)
    p6 = _num(c.get("posts_prev_6h_avg_per_h"), "posts_prev_6h_avg_per_h")
    sr = _num(c.get("spike_ratio"), "spike_ratio", allow_none=True)
    if sr is None and p6 > 0:
        sr = round(p1 / p6, 2)
    return {"symbol": sym, "base": sym[:-4], "flag": "pump", "trigger_at": xc.iso(trig), "checked_at": xc.iso(checked),
            "posts_last_1h": p1, "posts_prev_6h_avg_per_h": p6, "spike_ratio": sr, "verdict": verdict, "one_line": line,
            "shill_flag": bool(c.get("shill_flag", False)), "big_accounts": _num(c.get("big_accounts", 0), "big_accounts", True),
            "top_posts": tp}


def call(x, t_now):
    if not isinstance(x, dict):
        raise Bad("call not an object")
    if x.get("tool") not in ("counts", "search"):
        raise Bad("call.tool must be counts|search")
    q = x.get("query")
    if not isinstance(q, str) or not q.strip() or len(q) > 512:
        raise Bad("call.query must be text")
    sym = str(x.get("symbol", "")).upper()
    if sym and not SYM_RE.match(sym):
        sym = sym + "USDT" if re.match(r"^[A-Z0-9]{1,20}$", sym) else ""
    d = _ts(x.get("ts"), "call.ts", t_now, check_age=False)
    return {"ts": xc.iso(d), "symbol": sym or None, "tool": x["tool"], "query": q.strip(),
            "result_count": _num(x.get("result_count", 0), "result_count", True)}


def merge(payload, t_now=None):
    t_now = t_now or xc.now()
    if not isinstance(payload, dict) or not isinstance(payload.get("coins", []), list) or not isinstance(payload.get("calls", []), list):
        raise SystemExit("payload must be {coins:[...], calls:[...]}")
    errs, good, calls = [], [], []
    for i, c in enumerate(payload.get("coins", [])):
        try:
            good.append(coin(c, t_now))
        except Bad as e:
            errs.append(f"coins[{i}] ({(c or {}).get('symbol') if isinstance(c, dict) else '?'}): {e}")
    for i, x in enumerate(payload.get("calls", [])):
        try:
            calls.append(call(x, t_now))
        except Bad as e:
            errs.append(f"calls[{i}]: {e}")
    # 1) log calls (append) + prune > LOG_KEEP_D days
    if calls or os.path.exists(xc.LOG):
        cut = t_now - datetime.timedelta(days=xc.LOG_KEEP_D)
        keep = [x for x in xc.read_log() if _safe_ts(x.get("ts")) and _safe_ts(x.get("ts")) >= cut] + calls
        os.makedirs(xc.D, exist_ok=True)
        tmp = xc.LOG + ".tmp"
        with open(tmp, "w") as f:
            for x in keep:
                f.write(json.dumps(x, ensure_ascii=False) + "\n")
        os.replace(tmp, xc.LOG)
    # 2) merge coins
    buzz = xc.load_buzz()
    hist = [h for h in buzz.get("history", []) if isinstance(h, dict)]
    for c in good:
        hist = [h for h in hist if not (h.get("symbol") == c["symbol"] and h.get("checked_at") == c["checked_at"])]
        hist.append(c)
    cut = t_now - datetime.timedelta(hours=xc.HISTORY_H)
    hist = sorted([h for h in hist if _safe_ts(h.get("checked_at")) and _safe_ts(h["checked_at"]) >= cut], key=lambda h: h["checked_at"])
    coins = {}
    for h in hist:  # latest check per symbol + checks in its trigger episode
        coins[h["symbol"]] = dict(h)
    for s, c in coins.items():
        c["checks_this_trigger"] = sum(1 for h in hist if h["symbol"] == s and h.get("trigger_at") == c.get("trigger_at"))
    day = t_now.astimezone(xc.TZ).strftime("%Y-%m-%d")
    used = xc.calls_on(day)
    import x_buzz_targets as xt  # noqa: E402  (config constants)
    cap = xt.DAILY_TOTAL_CAP
    buzz.update({"version": 1, "updated_at": xc.iso(t_now), "coins": coins, "history": hist,
                 "cap": {"date": day, "daily_total_cap": cap, "calls_today": used,
                         "cap_reached": cap is not None and cap - used < xt.CALLS_PER_TARGET, "updated_at": xc.iso(t_now)},
                 "note": "Written by scripts/x_buzz_write.py from the Grok Bot X routine. Site reads only; 0 X calls."})
    xc.save_buzz(buzz)
    print(json.dumps({"merged": len(good), "rejected": len(errs), "calls_logged": len(calls), "calls_today": used,
                      "cap_reached": buzz["cap"]["cap_reached"]}, ensure_ascii=False))
    for e in errs:
        print("REJECT " + e, file=sys.stderr)
    return 2 if errs else 0


def _safe_ts(s):
    try:
        return xc.parse_ts(s)
    except Exception:  # noqa: BLE001
        return None


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        print(f"not JSON: {e}", file=sys.stderr)
        return 1
    if not isinstance(payload, dict):
        print("payload must be an object", file=sys.stderr)
        return 1
    try:
        return merge(payload)
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
