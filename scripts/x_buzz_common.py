"""Shared paths / helpers for the X-buzz pipeline (x_buzz_targets.py, x_buzz_write.py, gainer_board scorecard).

The site makes ZERO X calls: it only reads data/gainer_board/x_buzz.json. X is read by the Grok Bot routine
(built-in X tools), which runs x_buzz_targets.py -> checks X -> pipes results into x_buzz_write.py.
"""
import datetime, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
D = os.path.join(ROOT, "data", "gainer_board")
BUZZ = os.path.join(D, "x_buzz.json")
LOG = os.path.join(D, "x_buzz_log.jsonl")
TZ = datetime.timezone(datetime.timedelta(hours=8))  # Asia/Shanghai — "today" for the daily cap
HISTORY_H = 48          # x_buzz.json keeps 48h of checks
LOG_KEEP_D = 7          # x_buzz_log.jsonl keeps 7 days of call lines
VERDICTS = ("熱", "升溫", "冷")


def now():
    return datetime.datetime.now(TZ)


def iso(dt):
    return dt.astimezone(TZ).isoformat(timespec="seconds")


def parse_ts(s):
    """ISO -> aware datetime (naive treated as UTC; trailing Z ok). Raises ValueError."""
    if not isinstance(s, str) or not s:
        raise ValueError("timestamp missing")
    d = datetime.datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d


def load_buzz():
    try:
        with open(BUZZ) as f:
            d = json.load(f)
        if isinstance(d, dict):
            d.setdefault("coins", {}); d.setdefault("history", [])
            return d
    except Exception:  # noqa: BLE001
        pass
    return {"version": 1, "coins": {}, "history": []}


def save_buzz(d):
    os.makedirs(D, exist_ok=True)
    tmp = BUZZ + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BUZZ)


def read_log():
    out = []
    try:
        with open(LOG) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:  # noqa: BLE001
                    pass
    except FileNotFoundError:
        pass
    return out


def calls_on(day, log=None):
    """Number of logged X calls on Shanghai date `day` (YYYY-MM-DD)."""
    n = 0
    for x in (read_log() if log is None else log):
        try:
            if parse_ts(x["ts"]).astimezone(TZ).strftime("%Y-%m-%d") == day:
                n += 1
        except Exception:  # noqa: BLE001
            pass
    return n
