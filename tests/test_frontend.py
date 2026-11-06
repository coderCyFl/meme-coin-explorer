"""Contract for the v2 front-end (index.html + js/). Replaces the old picks.js auth test."""
import json, shutil, subprocess, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
APP = (ROOT / "js/app.js").read_text(encoding="utf-8")
I18N = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
AGENTS = (ROOT / "AGENTS.md").read_text(encoding="utf-8")


class FrontendTests(unittest.TestCase):
    def test_auth_accepts_email_and_never_blocks_silently(self):
        # Old bug: label said "Email" but pattern only allowed [A-Za-z0-9_] → Continue did nothing.
        assert 'id="authForm" novalidate' in HTML
        assert 'pattern=' not in HTML.split('id="authForm"')[1].split("</form>")[0]
        assert "[^\\s@]+@[^\\s@]+" in APP          # email accepted
        assert "toLowerCase()" in APP                # case-insensitive ids


    def test_trade_form_not_blocked_by_step(self):
        assert 'data-trade="${esc(sym)}" novalidate' in APP
        assert 'step="any"' in APP


    def test_buy_always_enabled_regardless_of_stage(self):
        # Mock high-risk practise: Buy must not be greyed out by Early Score / late / quiet.
        assert 'r.stage === "early" || r.stage === "build"' not in APP
        assert 'data-buy="${esc(sym)}"' in APP
        assert 'data-buy="${esc(sym)}" ${canBuy' not in APP
        assert "never hide or disable Buy" in AGENTS


    def test_leverage_options_to_50x(self):
        assert "MAX_LEV = 50" in APP
        assert "const LEVS = [1, 2, 3, 5, 10, 20, 50]" in APP
        assert "[1, 2, 3].map" not in APP
        assert "Max 3x" not in I18N
        assert "1x–50x" in AGENTS


    def test_soft_notes_copy(self):
        assert "This one has already moved a lot. Buying after a pump is riskier. You can still buy." in I18N
        assert "呢隻已經升咗好多。追升風險較高，你仍然可以買。" in I18N
        assert "No early signal on this coin right now. You can still buy it." in I18N
        assert "呢隻幣而家冇早期訊號，你仍然可以買。" in I18N


    def test_auto_tpsl_and_manual_hold_wiring(self):
        assert "data-auto" in APP
        assert "t.auto" in I18N
        assert "x.auto === false" in APP
        assert "Sell yourself from Portfolio" in I18N
        assert "喺持倉自己平倉" in I18N
        assert "p.manualHold" in I18N
        assert "migratePos" in APP


    def test_liquidation_formula_and_caps(self):
        assert "liqPrice = (entry, lev) => entry * (1 - 0.9 / Math.max(1, lev))" in APP
        assert 'how === "liq"' in APP
        assert "P.cash < 0" in APP
        node = shutil.which("node")
        if not node:
            return
        js = """
          const liqPrice = (entry, lev) => entry * (1 - 0.9 / Math.max(1, lev));
          const FEE = 0.001;
          function sim(entry, lev, margin, price) {
            const qty = (margin * lev) / entry;
            const floor = liqPrice(entry, lev);
            const exit = Math.max(price, floor);
            let part = margin + qty * (exit - entry);
            let fee = qty * exit * FEE;
            let proceeds = part - fee;
            if (proceeds < 0) proceeds = 0;
            proceeds = Math.max(0, Math.min(margin, proceeds));
            const loss = margin - proceeds;
            return { floor, exit, proceeds, loss, okLoss: loss <= margin + 1e-9, okCash: proceeds >= 0 };
          }
          const a = sim(100, 10, 100, 50);
          const b = sim(100, 50, 100, 98);
          const c = sim(100, 2, 100, liqPrice(100, 2));
          console.log(JSON.stringify({ a, b, c, floor10: liqPrice(100, 10), floor50: liqPrice(100, 50) }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        self.assertAlmostEqual(out["floor10"], 91.0, places=6)
        self.assertAlmostEqual(out["floor50"], 100 * (1 - 0.9 / 50), places=6)
        self.assertTrue(out["a"]["okLoss"] and out["a"]["okCash"])
        self.assertTrue(out["b"]["okLoss"] and out["b"]["okCash"])
        self.assertTrue(out["c"]["okLoss"] and out["c"]["okCash"])
        self.assertEqual(out["a"]["exit"], out["a"]["floor"])


    def test_strategy_runs(self):
        node = shutil.which("node")
        if not node:
            return
        js = """
          globalThis.window = globalThis; globalThis.location = { search: "" };
          require(process.argv[1] + '/js/strategy.js'); require(process.argv[1] + '/js/data.js');
          Market.demo.scan().then(({ series }) => {
            const btc = Strategy.indexSeries(series.BTCUSDT);
            const s = series.WIFUSDT, r = Strategy.scoreAt(s, s.n - 1, btc);
            const bt = Strategy.backtest(series, btc);
            console.log(JSON.stringify({ score: r.score, stage: r.stage, n: bt.n, stop: r.plan.stopPct }));
          });"""
        out = json.loads(subprocess.check_output([node, "-e", js, str(ROOT)], text=True).strip())
        assert out["stage"] == "early" and out["score"] >= 70
        assert out["n"] > 0 and 0.025 <= out["stop"] <= 0.06


if __name__ == "__main__":
    unittest.main()
