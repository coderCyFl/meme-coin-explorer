#!/usr/bin/env python3
"""CI guard: a sealed daily scorecard (data/gainer_board/daily_vs_gainers/DATE.json with "sealed": true)
must never change or disappear. Compares every file sealed in BASE (git ref, default origin/main)
against the working tree; exits 1 if any was modified or deleted.

  python3 scripts/check_seals.py [--base origin/main]
"""
import json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REL = "data/gainer_board/daily_vs_gainers"


def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True)


def main(argv):
    base = argv[argv.index("--base") + 1] if "--base" in argv else "origin/main"
    ls = git("ls-tree", "--name-only", f"{base}:{REL}")
    if ls.returncode:
        print(f"check_seals: no {REL} at {base} — nothing to check")
        return 0
    bad = []
    for name in ls.stdout.split():
        if not name.endswith(".json"):
            continue
        old = git("show", f"{base}:{REL}/{name}").stdout
        try:
            sealed = json.loads(old).get("sealed")
        except Exception:  # noqa: BLE001
            continue
        if not sealed:
            continue
        fn = os.path.join(ROOT, REL, name)
        if not os.path.exists(fn):
            bad.append(f"{name}: deleted")
        elif open(fn, encoding="utf-8").read() != old:
            bad.append(f"{name}: modified")
    if bad:
        print("check_seals: FAIL — sealed scorecards changed vs " + base + ":\n  " + "\n  ".join(bad))
        return 1
    print(f"check_seals: OK vs {base}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
