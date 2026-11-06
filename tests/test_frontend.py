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
        assert out["stage"] == "early" and out["score"] >= 70
        assert out["n"] > 0 and 0.025 <= out["stop"] <= 0.06



    def test_radar_defaults_all_and_closest_markup(self):
        """T1a face-only: default All filter + Closest-to-early top10 markup (EN/ZH)."""
        assert 'filter: "all"' in APP
        assert 'filter: "early"' not in APP.split("const S = {", 1)[1].split("};", 1)[0]
        assert 'id="closestList"' in HTML
        assert 'data-t="radar.closest"' in HTML
        assert 'class="on" data-f="all"' in HTML
        i18n = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
        assert '"radar.closest": "Closest to early"' in i18n
        assert '"radar.closest": "最接近早期"' in i18n
        assert '"radar.closestNone"' in i18n


    def test_podium_top3_by_score_any_stage(self):
        """Podium uses top 3 by score across all stages; no Early/Building fill."""
        assert 'return ranked("all").slice(0, 3);' in APP
        assert 'ranked("early")' not in APP.split("function heroCoins()", 1)[1].split("function renderHero()", 1)[0]


    def test_closest_list_uses_paintList_top10(self):
        """Closest strip always shows top10 by score via paintList (patch-in-place)."""
        assert 'const closest = ranked("all").slice(0, 10);' in APP
        assert 'paintList(closestEl, closest,' in APP


    def test_strategy_params_unchanged_from_main_baseline(self):
        """T1a must not alter strategy thresholds/candles (byte-proof is separate; this catches PARAMS drift)."""
        strat = (ROOT / "js/strategy.js").read_text(encoding="utf-8")
        assert "earlyMin: 70" in strat
        assert "earlyMin: 60" not in strat
        assert "if (ret1h <= 0) score = Math.min(score, 35);" in strat
        assert "closedStart" not in strat



if __name__ == "__main__":
    unittest.main()
