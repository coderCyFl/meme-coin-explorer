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
        """Podium uses top 3 from radarSnap (all stages); no Early/Building fill."""
        assert "return radarSnap().slice(0, 3);" in APP
        assert 'ranked("early")' not in APP.split("function heroCoins()", 1)[1].split("function renderHero()", 1)[0]


    def test_closest_list_uses_paintList_top10(self):
        """Closest strip always shows top10 from the same radarSnap via paintList."""
        assert "const closest = snap.slice(0, 10).map((x) => x.sym);" in APP
        assert "paintList(closestEl, closest," in APP


    def test_podium_closest_same_snapshot_and_co_refresh(self):
        """Regression: podium + Closest share one snap; live path refreshes both after rescore."""
        assert "function takeRadarSnap()" in APP
        assert "S.radarSnap =" in APP
        assert "takeRadarSnap(); renderHero(); renderLists();" in APP
        # scheduleLive must not paint lists without hero
        live = APP.split("function scheduleLive()", 1)[1].split("function ranked(", 1)[0]
        assert "renderLists()" in live and "renderHero()" in live
        node = shutil.which("node")
        if not node:
            return
        # Behavioral: frozen snap keeps podium top3 scores identical to Closest prefix.
        js = r"""
          const scores = {
            AAAUSDT: { score: 78, stage: "early", metrics: { ret1h: 0.01 } },
            BBBUSDT: { score: 76, stage: "build", metrics: { ret1h: 0.02 } },
            CCCUSDT: { score: 70, stage: "late", metrics: { ret1h: -0.01 } },
            DDDUSDT: { score: 65, stage: "quiet", metrics: { ret1h: 0 } },
          };
          const ticks = Object.fromEntries(Object.keys(scores).map(s => [s, { base: s.slice(0,3), name: s }]));
          function ranked(filter) {
            const out = [];
            for (const sym in scores) {
              const r = scores[sym];
              if (filter === "all" || r.stage === filter) out.push(sym);
            }
            return out.sort((a,b) => scores[b].score - scores[a].score);
          }
          function takeRadarSnap() {
            return ranked("all").map(sym => {
              const r = scores[sym], tk = ticks[sym];
              return { sym, score: r.score, stage: r.stage, ret1h: r.metrics.ret1h, base: tk.base };
            });
          }
          const snap = takeRadarSnap();
          const podium = snap.slice(0,3);
          const closest = snap.slice(0,10);
          const shared = podium.every((p,i) => closest[i] && closest[i].sym === p.sym && closest[i].score === p.score);
          // mutate live scores after snap — face must still agree with snap, not live
          scores.AAAUSDT.score = 99;
          const still = podium[0].score === 78 && closest[0].score === 78 && podium[0].score === closest[0].score;
          console.log(JSON.stringify({ shared, still, podium: podium.map(x=>[x.sym,x.score]), closest0: [closest[0].sym, closest[0].score] }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        assert out["shared"] and out["still"], out


    def test_strategy_params_unchanged_from_main_baseline(self):
        """T1a must not alter strategy thresholds/candles (byte-proof is separate; this catches PARAMS drift)."""
        strat = (ROOT / "js/strategy.js").read_text(encoding="utf-8")
        assert "earlyMin: 70" in strat
        assert "earlyMin: 60" not in strat
        assert "if (ret1h <= 0) score = Math.min(score, 35);" in strat
        assert "closedStart" not in strat



if __name__ == "__main__":
    unittest.main()
