"""Contract for the v2 front-end (index.html + js/). Replaces the old picks.js auth test."""
import json, shutil, subprocess, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
APP = (ROOT / "js/app.js").read_text(encoding="utf-8")


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
        assert out["score"] >= 60
        assert out["n"] > 0 and 0.025 <= out["stop"] <= 0.06




    def test_opening_candle_alone_cannot_drop_score(self):
        """rvol/buyRatio ignore the forming candle; zeroing its volume must not change score at fixed live price."""
        import shutil, subprocess, json
        node = shutil.which("node")
        if not node:
            return
        js = r"""
          globalThis.window = globalThis; globalThis.location = { search: "" };
          const Strategy = require(process.argv[1] + '/js/strategy.js');
          const n = Strategy.MIN_BARS + 8;
          const rows = [];
          let px = 100;
          for (let i = 0; i < n; i++) {
            const o = px, c = px * (1 + (i % 7 === 0 ? 0.012 : 0.002));
            const h = Math.max(o, c) * 1.004, l = Math.min(o, c) * 0.996;
            const qv = 1000 + (i % 5) * 200, tbq = qv * 0.58;
            rows.push([i * 900000, o, h, l, c, 0, 0, qv, 0, 0, tbq]);
            px = c;
          }
          // Inflate the forming candle volume (old bug would swing rvol); live price held constant.
          rows[n - 1][7] = 1e9;
          rows[n - 1][10] = 1e9;
          const sHot = Strategy.parseKlines(rows);
          const i = sHot.n - 1;
          const live = sHot.c[i];
          const hot = Strategy.scoreAt(sHot, i, null, live);
          rows[n - 1][7] = 1e-12;
          rows[n - 1][10] = 0;
          const sCold = Strategy.parseKlines(rows);
          const cold = Strategy.scoreAt(sCold, i, null, live);
          console.log(JSON.stringify({
            hot: hot && hot.score,
            cold: cold && cold.score,
            earlyMin: Strategy.EARLY_MIN,
            rvolHot: hot && hot.metrics.rvol,
            rvolCold: cold && cold.metrics.rvol,
            buyHot: hot && hot.metrics.buyRatio,
            buyCold: cold && cold.metrics.buyRatio,
          }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js, str(ROOT)], text=True).strip())
        assert out["earlyMin"] == 60
        assert out["hot"] is not None and out["cold"] is not None
        assert out["hot"] == out["cold"], out
        assert abs(out["rvolHot"] - out["rvolCold"]) < 1e-9
        assert abs(out["buyHot"] - out["buyCold"]) < 1e-9

    def test_ret1h_nonpositive_cap_is_50(self):
        import shutil, subprocess, json
        node = shutil.which("node")
        if not node:
            return
        js = r"""
          globalThis.window = globalThis;
          const Strategy = require(process.argv[1] + '/js/strategy.js');
          const n = Strategy.MIN_BARS + 8;
          const rows = [];
          let px = 100;
          for (let i = 0; i < n; i++) {
            // Force flat/down 1h into the last bars while keeping rich volume history.
            const drift = i < n - 5 ? 0.01 : -0.002;
            const o = px, c = px * (1 + drift);
            const h = Math.max(o, c) * 1.01, l = Math.min(o, c) * 0.99;
            const qv = 5000, tbq = qv * 0.7;
            rows.push([i * 900000, o, h, l, c, 0, 0, qv, 0, 0, tbq]);
            px = c;
          }
          const s = Strategy.parseKlines(rows);
          const r = Strategy.scoreAt(s, s.n - 1, null, s.c[s.n - 1]);
          console.log(JSON.stringify({ score: r.score, ret1h: r.metrics.ret1h, parts: r.parts }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js, str(ROOT)], text=True).strip())
        assert out["ret1h"] <= 0
        assert out["score"] <= 50



    def test_radar_defaults_all_and_closest_markup(self):
        assert 'filter: "all"' in APP
        assert 'id="closestList"' in HTML
        assert 'data-t="radar.closest"' in HTML
        i18n = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
        assert '"radar.closest": "Closest to early"' in i18n
        assert '"radar.closest": "最接近早期"' in i18n


if __name__ == "__main__":
    unittest.main()
