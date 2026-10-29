"""Seal guard + determinism tests for scripts/gainer_board.py (offline; no network).

  python3 -m unittest discover -s tests -v
"""
import copy, datetime, json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import gainer_board as gb  # noqa: E402

TZ = gb.TZ


def T(s):
    return datetime.datetime.fromisoformat(s)


def fake_allt():
    rows = [{"pair": f"C{i:02d}USDT", "price": 1.0, "chg24": 50 - i, "qv": 5e6, "high": 1.1} for i in range(30)]
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    return rows


def fake_day(date):
    def ent(pair, at, tier="early2", rk=None, c24=3.0):
        return {"symbol": pair[:-4], "pair": pair, "tier": tier, "picked_at": at, "rank_24h_at_pick": rk,
                "change_24h_at_pick": c24, "entry_price_usd": 1.0, "outcomes": {}}
    return {"date": date, "batches": [
        {"batch": "b1", "picked_at": f"{date}T10:00:00+08:00", "entries": [
            ent("C01USDT", f"{date}T09:50:00+08:00"),                 # early hit
            ent("C02USDT", f"{date}T09:55:00+08:00", rk=5, c24=20),   # late hit
            ent("C29USDT", f"{date}T09:55:00+08:00")]},               # early miss
        {"batch": "b2", "picked_at": f"{date}T23:50:00+08:00", "entries": [
            ent("C03USDT", f"{date}T23:56:00+08:00")]},               # after cutoff → ignored
        {"batch": "b3", "picked_at": f"{date}T23:58:00+08:00", "entries": [
            ent("C04USDT", f"{date}T23:40:00+08:00")]},               # batch taken after cutoff → ignored
    ]}


class SealTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.orig = (gb.CARD, gb.SNAP, gb.D, gb.gainers_at, gb.main_picks_on, gb.g.klines)
        gb.D = self.tmp
        gb.CARD = os.path.join(self.tmp, "daily_vs_gainers")
        gb.SNAP = os.path.join(self.tmp, "snapshots")
        os.makedirs(gb.CARD); os.makedirs(gb.SNAP)
        for d in ("2026-10-29", "2026-10-30"):
            json.dump(fake_day(d), open(os.path.join(gb.SNAP, d + ".json"), "w"))
        self.calls = []
        gb.gainers_at = lambda cutoff, pairs=None: (self.calls.append(cutoff), fake_allt())[1]
        gb.main_picks_on = lambda date, cutoff=None: []
        gb.g.klines = lambda *a, **k: [[0, 1, 1.2, 1, 1.1, 1]]

    def tearDown(self):
        gb.CARD, gb.SNAP, gb.D, gb.gainers_at, gb.main_picks_on, gb.g.klines = self.orig
        shutil.rmtree(self.tmp)

    def read(self, d):
        return json.load(open(gb.card_path(d)))

    def test_rewrite_sealed_fails(self):
        self.assertTrue(gb.scorecard("2026-10-29", T("2026-10-29T23:56:30+08:00")))
        before = open(gb.card_path("2026-10-29")).read()
        with self.assertRaises(gb.SealedError):
            gb.jsave(gb.card_path("2026-10-29"), {"date": "2026-10-29", "recall_top20_pct": 0})
        self.assertFalse(gb.scorecard("2026-10-29", T("2026-10-30T04:47:00+08:00")))
        self.assertEqual(before, open(gb.card_path("2026-10-29")).read())

    def test_0447_run_does_not_touch_sealed_previous_day(self):
        gb.scorecard("2026-10-29", T("2026-10-29T23:56:00+08:00"))
        before = open(gb.card_path("2026-10-29")).read()
        self.calls.clear()
        # 04:47 Asia/Shanghai == 20:47Z on 10/29 (the delayed 15:55Z cron that caused the incident)
        t = datetime.datetime(2026, 10, 29, 20, 47, tzinfo=datetime.timezone.utc)
        self.assertEqual(gb.scheduled_date(t), "2026-10-29")   # Shanghai date logic, not UTC
        self.assertFalse(gb.scorecard(None, t))
        self.assertEqual(gb.seal_due(t), 0)
        self.assertEqual(before, open(gb.card_path("2026-10-29")).read())
        self.assertEqual(self.calls, [])                       # did not even fetch a live/kline top-20
        self.assertFalse(os.path.exists(gb.card_path("2026-10-30")))  # 10/30 not sealed before its 23:55

    def test_deterministic_across_run_times(self):
        gb.scorecard("2026-10-30", T("2026-10-30T23:56:00+08:00"))
        a = self.read("2026-10-30")
        os.remove(gb.card_path("2026-10-30"))
        gb.scorecard("2026-10-30", T("2026-10-31T09:30:00+08:00"))  # catch-up run 9.5h later
        b = self.read("2026-10-30")
        for c in (a, b):
            self.assertTrue(c["sealed"])
            c.pop("sealed_at"); c.pop("seal_note")
        self.assertEqual(a, b)
        self.assertEqual(a["taken_at"], "2026-10-30T23:55:00+08:00")
        self.assertEqual(self.calls[0], self.calls[1])
        self.assertEqual(self.calls[0], T("2026-10-30T23:55:00+08:00"))

    def test_cutoff_and_scoring(self):
        gb.scorecard("2026-10-30", T("2026-10-30T23:57:00+08:00"))
        c = self.read("2026-10-30")
        self.assertEqual([h["symbol"] for h in c["hits"]], ["C01"])
        self.assertEqual([h["symbol"] for h in c["late"]], ["C02"])
        self.assertEqual(c["early_flagged"], 2)
        self.assertEqual(c["recall_top20_pct"], 5.0)
        self.assertEqual(c["precision_pct"], 50.0)
        self.assertNotIn("C03", [f["symbol"] for f in c["flags"]])
        self.assertNotIn("C04", [f["symbol"] for f in c["flags"]])

    def test_too_early_does_not_seal(self):
        self.assertFalse(gb.scorecard("2026-10-30", T("2026-10-30T23:54:00+08:00")))
        self.assertFalse(os.path.exists(gb.card_path("2026-10-30")))

    def test_catchup_seals_missed_day(self):
        # 23:55 cron missed entirely; next 15-min hourly run at 00:20 seals 10/30
        n = gb.seal_due(T("2026-10-31T00:20:00+08:00"))
        self.assertEqual(n, 1)
        self.assertTrue(self.read("2026-10-30")["sealed"])
        self.assertEqual(gb.seal_due(T("2026-10-31T00:35:00+08:00")), 0)  # idempotent


class RepoSealTests(unittest.TestCase):
    def test_repo_cards_sealed_flag_shape(self):
        d = os.path.join(HERE, "..", "data", "gainer_board", "daily_vs_gainers")
        for fn in sorted(os.listdir(d)):
            c = json.load(open(os.path.join(d, fn)))
            if c.get("sealed"):
                self.assertTrue(c.get("sealed_at"), fn)


if __name__ == "__main__":
    unittest.main()
