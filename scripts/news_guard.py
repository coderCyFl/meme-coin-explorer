#!/usr/bin/env python3
"""X news pull guard for data/news.json — at most ONE X news pull per Asia/Shanghai clock hour.

Why: on 2026-10-30 the hourly-update routine pulled X news at 09:08:30 (main 7a3f28b) and the
daily self-upgrade routine pulled again at 09:10:01 (branch 0261a39). Neither routine checked
whether news had already been refreshed, and there was no shared lock across worktrees.

news.json is refreshed by agent routines (X search_news tool), not by a cron script, so every
routine MUST wrap its X calls like this:

  1. python3 scripts/news_guard.py begin --job hourly-update      # BEFORE any X call
       -> prints "NEWS_GUARD: GO ..."   (claims the hour; then do the X calls)
       -> prints "NEWS_GUARD: SKIP ..." and exits 0  (do NOT call X; leave news.json alone)
  2. build the candidate JSON ({"fetched_at", "source", "stories": [...]}) somewhere outside data/
  3. git pull --rebase origin main   (or fetch)
  4. python3 scripts/news_guard.py write --job hourly-update --in /tmp/news_candidate.json
       re-checks AFTER the pull: refuses (exit 0, SKIP) if main's news.json was pulled by
       another job this hour, or if the candidate is older / has fewer stories than main's.
       On success writes data/news.json (with x_fetched_at, +08:00) and appends
       data/x_calls_log.jsonl. Commit both files.
  (If the X pull fails after `begin`, run `news_guard.py release --job ...` so the hour is freed.)

`status` prints the current state without claiming. Exit codes: 0 = GO/SKIP/OK (read the
NEWS_GUARD line); 2 = usage / bad input. Add --strict to make SKIP exit 10 instead of 0.

Sources checked for "already pulled":
  * data/news.json  x_fetched_at (falls back to fetched_at)  — local checkout
  * origin/main:data/news.json (git fetch, best-effort)       — other jobs that already pushed
  * data/x_calls_log.jsonl                                    — committed call log
  * <git-common-dir>/x_news_calls.jsonl  (flock'ed)           — shared by ALL worktrees on the box,
    catches a job that has claimed/pulled but not pushed yet.
Rule: the deciding rule is "at most one pull per Asia/Shanghai clock hour" (HH:00–HH:59 +08:00).
On top of that, a pull less than MIN_GAP_MINUTES (10) before `now` also blocks, but only to catch two
jobs straddling an hour boundary (e.g. 16:58 + 17:02). It is deliberately small: the hourly routine
fires once per hour within ±15 min of :00, so consecutive scheduled runs are always >= 30 min apart
and a 10-min gap can never make a scheduled run lose its hour. (The old 55-min gap did: 15:15 pull ->
16:02 run SKIPped, leaving hour 16 empty on 2026-10-30.)
"""
import argparse, datetime as dt, fcntl, json, os, subprocess, sys

TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai (no DST)
MIN_GAP_MINUTES = 10  # boundary-straddle guard only; must stay < 30 (min spacing of ±15-min hourly runs)
MIN_GAP = dt.timedelta(minutes=MIN_GAP_MINUTES)
CLAIM_TTL = dt.timedelta(minutes=30)  # an un-finalised claim blocks for at most 30 min
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def now_sh(args):
    if getattr(args, "now", None):
        return parse_ts(args.now)
    return dt.datetime.now(TZ).replace(microsecond=0)


def parse_ts(s):
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=TZ)
    return t.astimezone(TZ)


def iso(t):
    return t.astimezone(TZ).isoformat(timespec="seconds")


def news_ts(d):
    if not isinstance(d, dict):
        return None
    return parse_ts(d.get("x_fetched_at")) or parse_ts(d.get("fetched_at"))


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def git(*a, cwd=ROOT):
    try:
        return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, timeout=60)
    except Exception:
        return None


def default_lock():
    r = git("rev-parse", "--git-common-dir")
    if r and r.returncode == 0 and r.stdout.strip():
        d = r.stdout.strip()
        d = d if os.path.isabs(d) else os.path.join(ROOT, d)
        return os.path.join(d, "x_news_calls.jsonl")
    return os.path.join(ROOT, "data", "raw", ".x_news_calls.jsonl")


def remote_news(args):
    """origin/main:data/news.json after a best-effort fetch (None if --no-git / offline)."""
    if args.no_git:
        return None
    git("fetch", "-q", "origin", "main")
    r = git("show", "origin/main:data/news.json")
    if not r or r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def same_window(a, b):
    """True if b must be blocked by a: same Asia/Shanghai clock hour, or < MIN_GAP apart."""
    if a is None or b is None:
        return False
    a, b = a.astimezone(TZ), b.astimezone(TZ)
    same_hour = a.replace(minute=0, second=0, microsecond=0) == b.replace(minute=0, second=0, microsecond=0)
    return same_hour or abs(b - a) < MIN_GAP


def last_pulls(args, now, include_remote=True, exclude_claim=None):
    """List of (timestamp, where, job) for every known X news pull / live claim."""
    seen = []
    t = news_ts(load_json(args.news))
    if t:
        seen.append((t, "data/news.json", None))
    if include_remote:
        rn = remote_news(args)
        t = news_ts(rn)
        if t:
            seen.append((t, "origin/main:data/news.json", rn.get("x_job") if isinstance(rn, dict) else None))
    for path, label in ((args.log, "data/x_calls_log.jsonl"), (args.lock, "shared lock")):
        for e in read_jsonl(path):
            t = parse_ts(e.get("at"))
            if not t:
                continue
            kind = e.get("event", "pulled")
            if kind == "released":
                continue
            if kind == "claimed":
                if exclude_claim and e.get("claim_id") == exclude_claim:
                    continue
                if any(x.get("event") == "released" and x.get("claim_id") == e.get("claim_id")
                       for x in read_jsonl(path)):
                    continue
                if now - t > CLAIM_TTL:
                    continue
            seen.append((t, f"{label} ({kind})", e.get("job")))
    return seen


def blocking(args, now, **kw):
    hits = [s for s in last_pulls(args, now, **kw) if same_window(s[0], now) and s[0] <= now + dt.timedelta(minutes=5)]
    return max(hits, key=lambda s: s[0]) if hits else None


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


class Locked:
    def __init__(self, path):
        self.path = path + ".flock"

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.f = open(self.path, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def skip(args, msg):
    print(f"NEWS_GUARD: SKIP — {msg}. Do NOT call X; leave data/news.json as is.")
    return 10 if args.strict else 0


def cmd_status(args):
    now = now_sh(args)
    b = blocking(args, now)
    if b:
        print(f"NEWS_GUARD: SKIP — X news already pulled at {iso(b[0])} ({b[1]}, job={b[2]}) in this hour or <{MIN_GAP_MINUTES} min ago")
    else:
        print(f"NEWS_GUARD: GO — no X news pull in hour {now:%Y-%m-%d %H}:00 +08:00 / last {MIN_GAP_MINUTES} min")
    return 0


def cmd_begin(args):
    now = now_sh(args)
    with Locked(args.lock):
        b = blocking(args, now)
        if b:
            return skip(args, f"X news already pulled/claimed at {iso(b[0])} by job={b[2]} ({b[1]}), same Asia/Shanghai hour or <{MIN_GAP_MINUTES} min")
        claim_id = f"{args.job}@{iso(now)}"
        append_jsonl(args.lock, {"event": "claimed", "at": iso(now), "job": args.job, "claim_id": claim_id})
    print(f"NEWS_GUARD: GO — claimed X news pull for {now:%Y-%m-%d %H}:00 +08:00 (claim_id={claim_id}). "
          f"Run `write --claim-id '{claim_id}'` after git pull.")
    return 0


def cmd_release(args):
    now = now_sh(args)
    with Locked(args.lock):
        for e in read_jsonl(args.lock):
            if e.get("event") == "claimed" and e.get("job") == args.job and (not args.claim_id or e.get("claim_id") == args.claim_id):
                append_jsonl(args.lock, {"event": "released", "at": iso(now), "job": args.job, "claim_id": e.get("claim_id")})
    print(f"NEWS_GUARD: OK — released claims for job={args.job}")
    return 0


def cmd_write(args):
    now = now_sh(args)
    cand = load_json(args.infile)
    if not isinstance(cand, dict) or not isinstance(cand.get("stories"), list):
        print("NEWS_GUARD: ERROR — candidate must be a JSON object with a 'stories' list", file=sys.stderr)
        return 2
    cand_ts = news_ts(cand) or now
    cand["x_fetched_at"] = iso(cand_ts)
    cand.setdefault("fetched_at", cand["x_fetched_at"])
    cand["x_job"] = args.job
    with Locked(args.lock):
        # Re-check AFTER git pull: anything other than our own claim in this hour blocks the write.
        others = [s for s in last_pulls(args, cand_ts, exclude_claim=args.claim_id)
                  if same_window(s[0], cand_ts) and s[0] < cand_ts + dt.timedelta(minutes=5)
                  and not (s[2] == args.job and "claimed" in s[1])]
        if others:
            b = max(others, key=lambda s: s[0])
            return skip(args, f"another X news pull at {iso(b[0])} ({b[1]}, job={b[2]}) landed in the same hour; not overwriting")
        cur_list = [d for d in (load_json(args.news), remote_news(args)) if isinstance(d, dict)]
        for cur in cur_list:
            ct = news_ts(cur)
            n_cur, n_new = len(cur.get("stories") or []), len(cand["stories"])
            if ct and ct > cand_ts:
                return skip(args, f"existing news.json is newer ({iso(ct)} > {iso(cand_ts)}); refusing to overwrite with older data")
            if n_new < n_cur and ct and cand_ts - ct < dt.timedelta(hours=6):
                return skip(args, f"candidate has fewer stories ({n_new} < {n_cur}) than a <6h-old news.json; refusing")
        with open(args.news, "w", encoding="utf-8") as f:
            json.dump(cand, f, ensure_ascii=False, indent=2)
            f.write("\n")
        entry = {"event": "pulled", "at": cand["x_fetched_at"], "job": args.job, "stories": len(cand["stories"]),
                 "x_reads": args.x_reads, "claim_id": args.claim_id}
        append_jsonl(args.log, entry)
        append_jsonl(args.lock, entry)
    print(f"NEWS_GUARD: OK — wrote {os.path.relpath(args.news, ROOT) if args.news.startswith(ROOT) else args.news} "
          f"({len(cand['stories'])} stories, x_fetched_at {cand['x_fetched_at']}); commit data/news.json + data/x_calls_log.jsonl")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("cmd", choices=["status", "begin", "write", "release"])
    p.add_argument("--job", default=os.environ.get("NEWS_GUARD_JOB", "unknown"),
                   help="routine name, e.g. hourly-update / daily-upgrade")
    p.add_argument("--in", dest="infile", help="candidate news JSON (write)")
    p.add_argument("--claim-id")
    p.add_argument("--x-reads", type=int, default=None)
    p.add_argument("--news", default=os.path.join(ROOT, "data", "news.json"))
    p.add_argument("--log", default=os.path.join(ROOT, "data", "x_calls_log.jsonl"))
    p.add_argument("--lock", default=None)
    p.add_argument("--now", help="override clock (ISO), for tests")
    p.add_argument("--no-git", action="store_true", help="skip git fetch of origin/main (tests/offline)")
    p.add_argument("--strict", action="store_true", help="exit 10 on SKIP")
    args = p.parse_args(argv)
    args.lock = args.lock or default_lock()
    if args.cmd == "write" and not args.infile:
        p.error("write needs --in")
    return {"status": cmd_status, "begin": cmd_begin, "write": cmd_write, "release": cmd_release}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
