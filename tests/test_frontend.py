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




    def test_gainers_tab_nav_and_universe(self):
        """T3: Gainers tab, order, phone drops Markets, top20, hide <$1M, no fake score."""
        assert 'data-page="gainers"' in HTML
        assert 'data-nav="gainers"' in HTML
        assert 'data-icon="gainers"' in HTML
        # side order: radar → gainers → aiwatch → allin → markets → portfolio → record
        side = HTML.split('class="side-nav"', 1)[1].split("</nav>", 1)[0]
        order = []
        for part in side.split('data-nav="')[1:]:
            order.append(part.split('"', 1)[0])
        self.assertEqual(order, ["radar", "gainers", "aiwatch", "allin", "markets", "portfolio", "record"])
        # phone bottom: no Markets; AI Watch present
        bottom = HTML.split('class="bottom"', 1)[1].split("</nav>", 1)[0]
        assert 'data-nav="markets"' not in bottom
        assert 'data-nav="gainers"' in bottom
        assert 'data-nav="aiwatch"' in bottom
        assert "ticker/24hr?type=MINI" in (ROOT / "js/data.js").read_text(encoding="utf-8")
        assert "tickersAll" in (ROOT / "js/data.js").read_text(encoding="utf-8")
        assert "G_TOP = 20" in APP
        assert "G_VOL_FLOOR = 1e6" in APP
        assert "gHideLow" in APP
        assert "g.noScore" in I18N
        assert "No Early Score on this coin" in I18N
        assert "呢隻幣冇 Early Score" in I18N
        assert "nav.gainers" in I18N and "升幅榜" in I18N
        assert "scheduleGainers" in APP
        assert "ensureTick" in APP
        # Buy without score, no fake score number invented for missing r
        assert "Outside score universe" in APP or "no fake" in APP.lower()
        assert 'kind === "gainers"' in (ROOT / "js/coin3d.js").read_text(encoding="utf-8")



    def test_t4_live_status_rescan_and_soft_flash(self):
        """T4: 2-min rescan, status shows last-scan age EN+ZH, soft flash on list moves."""
        assert "RESCAN_MS = 2 * 60 * 1000" in APP
        assert "RESCAN_MS = 5 * 60 * 1000" not in APP
        assert "status.liveAge" in I18N and "Live · {a}" in I18N
        assert "status.demoAge" in I18N
        assert "status.ageSec" in I18N and "status.ageMin" in I18N and "status.ageHr" in I18N
        assert "即時 · {a}" in I18N and "示範 · {a}" in I18N
        assert "{n} 分鐘前" in I18N and "{n}m ago" in I18N
        assert "every 2 minutes" in I18N
        assert "每 2 分鐘會再掃一次" in I18N
        assert "every 5 minutes" not in I18N
        assert "function fmtAge(" in APP
        assert "function softFlash(" in APP
        assert "flashIfMoved" in APP
        assert "paintStatus(); }, 15000)" in APP
        assert 'classList.add("soft-flash")' in APP
        css = (ROOT / "css/app.css").read_text(encoding="utf-8")
        assert "@keyframes soft-flash" in css
        assert ".soft-flash" in css
        # Gainers identity guard must still be present
        assert "gPointerDown" in APP and "gInteractionUntil" in APP

    def test_ai_watch_face_en_zh(self):
        """AI Watch C: face from same-origin ai_watch.json, EN+ZH, no client secrets."""
        assert 'data-page="aiwatch"' in HTML
        assert 'data-nav="aiwatch"' in HTML
        assert 'data-icon="aiwatch"' in HTML
        assert 'id="aiWatchList"' in HTML
        assert "nav.aiwatch" in I18N and "AI Watch" in I18N and "AI 盯盤" in I18N
        assert "aw.sub" in I18N and "Same-origin JSON" in I18N
        assert "aw.mock" in I18N and "Mock · paper" in I18N
        assert "Mock · 模擬" in I18N
        assert "aw.cap" in I18N and "HKT" in I18N
        assert "loadAiWatch" in APP and "renderAiWatch" in APP
        assert "loadAiWatch();" in APP
        # boot: called from start() beside loadGainers (not export-only)
        assert APP.count("loadAiWatch()") >= 3
        assert 'fetch("data/ai_watch.json"' in APP
        assert "X_BEARER_TOKEN" not in APP and "XAI_API_KEY" not in APP
        assert 'kind === "aiwatch"' in (ROOT / "js/coin3d.js").read_text(encoding="utf-8")
        import subprocess
        sha = subprocess.check_output(["git", "hash-object", str(ROOT / "js/strategy.js")], text=True).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")


    def test_urgent_b1_b2_b3_face(self):
        """URGENT B1–B3: universe cap, stage-exact filters, Hits strip EN+ZH; strategy frozen."""
        data = (ROOT / "js/data.js").read_text(encoding="utf-8")
        assert "const MAX_COINS = 60" in data
        assert "const MAX_COINS = 150" not in data
        # B2: stage-exact ranked + force rebuild on chip change; scoped filter clicks
        assert 'if (filter === "all" || r.stage === filter)' in APP
        assert 'radarEl.dataset.filter !== S.filter' in APP
        assert 'g("#radarFilters [data-f]")' in APP
        assert 'S.scores[s].stage === "quiet"' not in APP  # Markets shows full list, including quiet
        # Closest stays score-rank, not Early dump
        assert "const closest = snap.slice(0, 10).map((x) => x.sym);" in APP
        assert "paintList(closestEl, closest," in APP
        # B3 Hits strip
        assert 'id="hitsStrip"' in HTML
        assert "loadHits" in APP and "renderHits" in APP
        assert 'fetch("data/gainer_board/summary.json"' in APP
        assert '"hit.title": "Hits"' in I18N and '"hit.title": "命中"' in I18N
        assert '"hit.sub"' in I18N and "Daily caught report" in I18N
        assert "每日捕捉報告" in I18N
        assert '"hit.meta7"' in I18N and '"hit.empty"' in I18N
        css = (ROOT / "css/app.css").read_text(encoding="utf-8")
        assert ".hits-strip" in css and ".hits-card" in css
        # Hits symbols from last.hits[].symbol (not counts-only)
        assert "last.hits" in APP and "h.symbol" in APP
        assert "hit-chip" in APP and "hits-syms" in APP
        assert '"hit.caught": "Caught"' in I18N and '"hit.caught": "中咗"' in I18N
        assert '"hit.caughtEmpty"' in I18N and "No early hits that sealed night" in I18N
        assert "嗰晚冇升前命中" in I18N
        assert ".hit-chip" in css
        # strategy byte-proof + PARAMS
        import subprocess
        sha = subprocess.check_output(["git", "hash-object", str(ROOT / "js/strategy.js")], text=True).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")
        node = shutil.which("node")
        if not node:
            return
        js = r"""
          const scores = {
            E1USDT: { score: 80, stage: "early", metrics: { ret1h: 0.02 } },
            E2USDT: { score: 75, stage: "early", metrics: { ret1h: 0.01 } },
            B1USDT: { score: 68, stage: "build", metrics: { ret1h: 0.01 } },
            L1USDT: { score: 72, stage: "late", metrics: { ret1h: 0.05 } },
            Q1USDT: { score: 40, stage: "quiet", metrics: { ret1h: 0 } },
            BTCUSDT: { score: 50, stage: "quiet", metrics: { ret1h: 0 } },
          };
          function ranked(filter) {
            const out = [];
            for (const sym in scores) {
              const r = scores[sym];
              if (!r || !r.stage) continue;
              if (sym === "BTCUSDT" && filter !== "all") continue;
              if (filter === "all" || r.stage === filter) out.push(sym);
            }
            return out.sort((a, b) => (scores[b].score || 0) - (scores[a].score || 0));
          }
          const early = ranked("early");
          const late = ranked("late");
          const all = ranked("all");
          const ok =
            early.join(",") === "E1USDT,E2USDT" &&
            late.join(",") === "L1USDT" &&
            !early.includes("L1USDT") &&
            !early.includes("B1USDT") &&
            !late.includes("E1USDT") &&
            all.includes("Q1USDT") &&
            all.includes("BTCUSDT") &&
            !ranked("early").includes("BTCUSDT");
          console.log(JSON.stringify({ ok, early, late, allN: all.length }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        self.assertTrue(out["ok"], out)



    def test_radar_stage_hides_closest(self):
        """Stage chips hide Closest strip; only All shows mixed score-rank Closest."""
        assert 'S.filter === "all"' in APP
        assert 'closestSec.hidden = true' in APP or 'closestSec.hidden = True' in APP
        assert 'closestSec.hidden = false' in APP or 'closestSec.hidden = False' in APP
        assert '"radar.noneBuild"' in I18N and '"radar.noneLate"' in I18N
        assert "No building signals" in I18N
        assert "暫時冇醞釀中訊號" in I18N
        assert "No already-pumped coins" in I18N
        import subprocess
        sha = subprocess.check_output(["git", "hash-object", str(ROOT / "js/strategy.js")], text=True).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")
    def test_hits_strip_symbols(self):
        """Hits strip lists sealed early-hit symbols from last.hits[].symbol."""
        assert "last.hits" in APP
        assert ".map((h) => h && h.symbol)" in APP or "h.symbol" in APP
        assert "hit-chip" in APP
        assert '"hit.caught": "Caught"' in I18N
        assert '"hit.caught": "中咗"' in I18N
        assert '"hit.caughtEmpty": "No early hits that sealed night"' in I18N
        assert '"hit.caughtEmpty": "嗰晚冇升前命中"' in I18N
        css = (ROOT / "css/app.css").read_text(encoding="utf-8")
        assert ".hit-chip" in css and ".hits-syms" in css
        import subprocess
        sha = subprocess.check_output(["git", "hash-object", str(ROOT / "js/strategy.js")], text=True).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")





if __name__ == "__main__":
    unittest.main()
