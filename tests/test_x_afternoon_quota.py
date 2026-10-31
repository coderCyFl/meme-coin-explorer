"""Afternoon X-quota reserve + early preference (no network)."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import x_buzz_common as xc  # noqa: E402
import x_buzz_targets as xt  # noqa: E402


def _ts(s):
    return s


class AfternoonQuotaTest(unittest.TestCase):
    def setUp(self):
        self.trig = "2026-10-31T08:00:00+08:00"
        self.pump = {
            "symbol": "AAAUSDT", "base": "AAA", "price": 1.0, "chg24": 12.0,
            "trigger_at": self.trig, "trigger_via": "15m", "site_pool": True,
        }
        self.early_ve = {
            "symbol": "BBBUSDT", "base": "BBB", "price": 1.0, "chg24": 4.0,
            "trigger_at": self.trig, "trigger_via": "x_early_cand", "vr": 2.0, "rank": 40,
        }
        self.early_hi = {
            "symbol": "CCCUSDT", "base": "CCC", "price": 1.0, "chg24": 12.0,
            "trigger_at": self.trig, "trigger_via": "x_early_cand", "vr": 2.0, "rank": 41,
        }

    def _log(self, n, day="2026-10-31"):
        # n call lines on that Shanghai day
        return [{"ts": f"{day}T07:00:00+08:00", "symbol": "ZZZUSDT", "tool": "search"} for _ in range(n)]

    def test_morning_holds_reserve(self):
        # 40 used → remaining 20, but spendable = 60-24-40 = 0 before noon
        buzz = {"coins": {}, "history": []}
        morning = xc.parse_ts("2026-10-31T09:00:00+08:00")
        res = xt.plan([self.pump], buzz, self._log(40), morning, early_cands=[self.early_ve])
        self.assertEqual(res["calls_remaining"], 20)
        self.assertEqual(res["spendable_now"], 0)
        self.assertFalse(res["is_afternoon"])
        self.assertTrue(res["reserve_holding"])
        self.assertFalse(res["cap_reached"])
        self.assertEqual(res["targets"], [])

    def test_afternoon_unlocks_reserve(self):
        buzz = {"coins": {}, "history": []}
        aft = xc.parse_ts("2026-10-31T13:00:00+08:00")
        # Fresh trigger so HOLD_H (4h) still covers 13:00.
        pump = dict(self.pump, trigger_at="2026-10-31T12:05:00+08:00")
        early = dict(self.early_ve, trigger_at="2026-10-31T12:05:00+08:00")
        res = xt.plan([pump], buzz, self._log(40), aft, early_cands=[early])
        self.assertEqual(res["calls_remaining"], 20)
        self.assertEqual(res["spendable_now"], 20)
        self.assertTrue(res["is_afternoon"])
        self.assertFalse(res["reserve_holding"])
        self.assertGreaterEqual(len(res["targets"]), 1)
        self.assertEqual(res["targets"][0]["symbol"], "AAAUSDT")  # first-check pump first

    def test_morning_defers_cold_recheck(self):
        buzz = {
            "coins": {"AAAUSDT": {"verdict": "冷", "trigger_at": self.trig}},
            "history": [{
                "symbol": "AAAUSDT", "trigger_at": self.trig,
                "checked_at": "2026-10-31T08:05:00+08:00", "verdict": "冷",
            }],
        }
        # make recheck due: last check > RECHECK_MIN ago
        buzz["history"][0]["checked_at"] = "2026-10-31T08:00:00+08:00"
        morning = xc.parse_ts("2026-10-31T09:00:00+08:00")
        res = xt.plan([self.pump], buzz, self._log(0), morning, early_cands=[])
        self.assertGreaterEqual(res["deferred_cold_rechecks"], 1)
        self.assertEqual(res["due_pump"], 0)
        self.assertEqual(res["targets"], [])

    def test_very_early_before_higher_early(self):
        buzz = {"coins": {}, "history": []}
        morning = xc.parse_ts("2026-10-31T09:00:00+08:00")
        # no pumps due; both early first-checks — very-early should win
        res = xt.plan([], buzz, self._log(0), morning, early_cands=[self.early_hi, self.early_ve])
        self.assertGreaterEqual(len(res["targets"]), 1)
        self.assertEqual(res["targets"][0]["symbol"], "BBBUSDT")
        self.assertTrue(res["targets"][0]["very_early"])

    def test_hard_cap_still_blocks(self):
        buzz = {"coins": {}, "history": []}
        aft = xc.parse_ts("2026-10-31T15:00:00+08:00")
        res = xt.plan([self.pump], buzz, self._log(60), aft, early_cands=[self.early_ve])
        self.assertTrue(res["cap_reached"])
        self.assertEqual(res["calls_remaining"], 0)
        self.assertEqual(res["targets"], [])


if __name__ == "__main__":
    unittest.main()
