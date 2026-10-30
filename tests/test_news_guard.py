"""Tests for scripts/news_guard.py — one X news pull per Asia/Shanghai hour."""
import contextlib, io, json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import news_guard  # noqa: E402


def stories(n):
    return [{"id": str(i), "title": f"t{i}"} for i in range(n)]


class NewsGuardTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.news = os.path.join(self.d, "news.json")
        self.log = os.path.join(self.d, "x_calls_log.jsonl")
        self.lock = os.path.join(self.d, "lock.jsonl")
        self.write_news({"fetched_at": "2026-10-30T00:44:45+08:00", "stories": stories(18)})

    def write_news(self, d):
        with open(self.news, "w") as f:
            json.dump(d, f)

    def run_guard(self, *a, now):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = news_guard.main([*a, "--news", self.news, "--log", self.log, "--lock", self.lock,
                                  "--no-git", "--now", now])
        return rc, buf.getvalue()

    def cand(self, ts, n):
        p = os.path.join(self.d, f"cand_{n}.json")
        with open(p, "w") as f:
            json.dump({"fetched_at": ts, "source": "X search_news", "stories": stories(n)}, f)
        return p

    def test_first_pull_in_hour_goes(self):
        rc, out = self.run_guard("begin", "--job", "hourly-update", now="2026-10-30T09:08:00+08:00")
        self.assertEqual(rc, 0)
        self.assertIn("NEWS_GUARD: GO", out)

    def test_second_job_same_hour_skips_before_x_call(self):
        """Replays 2026-10-30: hourly claims at 09:08, daily begins at 09:09 -> SKIP."""
        self.run_guard("begin", "--job", "hourly-update", now="2026-10-30T09:08:00+08:00")
        rc, out = self.run_guard("begin", "--job", "daily-upgrade", now="2026-10-30T09:09:30+08:00")
        self.assertEqual(rc, 0)
        self.assertIn("NEWS_GUARD: SKIP", out)
        rc, _ = self.run_guard("begin", "--job", "daily-upgrade", "--strict", now="2026-10-30T09:09:30+08:00")
        self.assertEqual(rc, 10)

    def test_news_json_timestamp_blocks_even_without_log(self):
        self.write_news({"fetched_at": "2026-10-30T09:08:30+08:00", "stories": stories(20)})
        _, out = self.run_guard("begin", "--job", "daily-upgrade", now="2026-10-30T09:10:01+08:00")
        self.assertIn("SKIP", out)

    def test_min_gap_constant_is_small(self):
        # Hourly routine fires within ±15 min of :00 -> consecutive runs >= 30 min apart.
        self.assertLess(news_guard.MIN_GAP_MINUTES, 30)
        self.assertEqual(news_guard.MIN_GAP, news_guard.dt.timedelta(minutes=news_guard.MIN_GAP_MINUTES))

    def _prev_then(self, prev, now):
        self.write_news({"x_fetched_at": prev, "stories": stories(20)})
        _, out = self.run_guard("begin", "--job", "hourly-update", now=now)
        return out

    def test_late_previous_run_does_not_eat_next_hour(self):
        """Replays 2026-10-30: 15:00-hour pull at 15:15, 16:00-hour run at 16:02 must GO."""
        self.assertIn("NEWS_GUARD: GO", self._prev_then("2026-10-30T15:15:00+08:00", "2026-10-30T16:02:00+08:00"))

    def test_same_clock_hour_skips(self):
        self.assertIn("NEWS_GUARD: SKIP", self._prev_then("2026-10-30T16:02:00+08:00", "2026-10-30T16:40:00+08:00"))

    def test_15_min_across_boundary_goes(self):
        """16:50 -> 17:05 is 15 min, > MIN_GAP (10): GO, so hour 17 is not left empty."""
        self.assertIn("NEWS_GUARD: GO", self._prev_then("2026-10-30T16:50:00+08:00", "2026-10-30T17:05:00+08:00"))

    def test_boundary_straddle_within_min_gap_skips(self):
        """Two jobs at 16:55 and 17:02 (7 min) are a double pull, not two hourly pulls."""
        self.assertIn("NEWS_GUARD: SKIP", self._prev_then("2026-10-30T16:55:00+08:00", "2026-10-30T17:02:00+08:00"))
        self.assertIn("NEWS_GUARD: GO", self._prev_then("2026-10-30T16:55:00+08:00", "2026-10-30T17:05:00+08:00"))

    def test_any_hourly_schedule_within_15_min_jitter_never_skips(self):
        """Consecutive scheduled runs (jitter -15..+15 min) in different clock hours -> never blocked."""
        base_prev = news_guard.parse_ts("2026-10-30T16:00:00+08:00")
        base_now = news_guard.parse_ts("2026-10-30T17:00:00+08:00")
        for e_prev in range(-15, 16):
            for e_now in range(-15, 16):
                prev = base_prev + news_guard.dt.timedelta(minutes=e_prev)
                now = base_now + news_guard.dt.timedelta(minutes=e_now)
                if prev.hour == now.hour:
                    continue  # both landed in one clock hour: same-hour SKIP is correct
                self.assertFalse(news_guard.same_window(prev, now), (prev, now))

    def test_write_adds_x_fetched_at_and_logs(self):
        _, out = self.run_guard("begin", "--job", "hourly-update", now="2026-10-30T09:08:00+08:00")
        claim = out.split("claim_id=")[1].split(")")[0]
        rc, out = self.run_guard("write", "--job", "hourly-update", "--claim-id", claim, "--x-reads", "2",
                                 "--in", self.cand("2026-10-30T09:08:30+08:00", 20), now="2026-10-30T09:08:40+08:00")
        self.assertEqual(rc, 0, out)
        self.assertIn("NEWS_GUARD: OK", out)
        d = json.load(open(self.news))
        self.assertEqual(d["x_fetched_at"], "2026-10-30T09:08:30+08:00")
        self.assertEqual(len(d["stories"]), 20)
        log = [json.loads(l) for l in open(self.log)]
        self.assertEqual(log[-1]["event"], "pulled")
        self.assertEqual(log[-1]["job"], "hourly-update")

    def test_write_refuses_overwrite_by_second_pull_same_hour(self):
        """Replays 0261a39: main already has 20 stories @09:08:30; 19 @09:10:01 must not land."""
        self.write_news({"fetched_at": "2026-10-30T09:08:30+08:00", "stories": stories(20)})
        rc, out = self.run_guard("write", "--job", "daily-upgrade",
                                 "--in", self.cand("2026-10-30T09:10:01+08:00", 19), now="2026-10-30T09:10:20+08:00")
        self.assertEqual(rc, 0)
        self.assertIn("SKIP", out)
        self.assertEqual(len(json.load(open(self.news))["stories"]), 20)

    def test_write_refuses_older_or_fewer(self):
        self.write_news({"x_fetched_at": "2026-10-30T07:00:00+08:00", "stories": stories(20)})
        _, out = self.run_guard("write", "--job", "x", "--in", self.cand("2026-10-30T05:00:00+08:00", 25),
                                now="2026-10-30T09:00:00+08:00")
        self.assertIn("newer", out)
        _, out = self.run_guard("write", "--job", "x", "--in", self.cand("2026-10-30T09:00:00+08:00", 12),
                                now="2026-10-30T09:00:10+08:00")
        self.assertIn("fewer stories", out)
        self.assertEqual(json.load(open(self.news))["x_fetched_at"], "2026-10-30T07:00:00+08:00")

    def test_release_frees_hour(self):
        self.run_guard("begin", "--job", "hourly-update", now="2026-10-30T09:08:00+08:00")
        self.run_guard("release", "--job", "hourly-update", now="2026-10-30T09:09:00+08:00")
        _, out = self.run_guard("begin", "--job", "daily-upgrade", now="2026-10-30T09:10:00+08:00")
        self.assertIn("GO", out)


if __name__ == "__main__":
    unittest.main()
