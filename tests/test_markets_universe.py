"""Markets full catalog (no 60-slice, no $3M floor) + Radar stays MAX_COINS; no SOXSB leftover."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_JS = (ROOT / "js/data.js").read_text(encoding="utf-8")
APP = (ROOT / "js/app.js").read_text(encoding="utf-8")
I18N = (ROOT / "js/i18n.js").read_text(encoding="utf-8")

STABLES = {
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE",
    "XUSD", "USD1", "PAXG", "WBTC", "BFUSD", "EURI",
}
MIN_QUOTE_VOL = 3e6
MAX_COINS = 60


def eligible(t, tokenized=None):
    sym = t["symbol"]
    if not sym.endswith("USDT"):
        return False
    base = sym[:-4]
    if not base or base in STABLES:
        return False
    if re.search(r"(UP|DOWN|BULL|BEAR)$", base) and len(base) > 4:
        return False
    if tokenized and base in tokenized:
        return False
    return float(t["quoteVolume"]) >= MIN_QUOTE_VOL and float(t["lastPrice"]) > 0


def slice_universe(tickers, tokenized, drop_before_slice=True):
    if drop_before_slice:
        kept = [t for t in tickers if eligible(t, tokenized)]
        kept.sort(key=lambda t: -float(t["quoteVolume"]))
        return kept[:MAX_COINS]
    kept = [t for t in tickers if eligible(t, None)]
    kept.sort(key=lambda t: -float(t["quoteVolume"]))
    sliced = kept[:MAX_COINS]
    return [t for t in sliced if t["symbol"][:-4] not in tokenized]


def fake_tickers():
    """High-volume bStocks would fill the 60-cap if dropped only after the slice."""
    tokenized = {f"TOK{i}B" for i in range(20)} | {"SOXSB", "NVDAB", "TSLAB", "SOXLB"}
    rows = []
    # Mid-caps that must survive when bStocks are dropped first.
    for i, base in enumerate(["HBAR", "XLM", "FIL"]):
        rows.append({
            "symbol": base + "USDT",
            "lastPrice": "0.2",
            "quoteVolume": str(4e6 + i * 1e5),
        })
    # Majors + filler crypto so the post-drop list still has ~60 names.
    rows.append({"symbol": "BTCUSDT", "lastPrice": "68000", "quoteVolume": "2e9"})
    rows.append({"symbol": "ETHUSDT", "lastPrice": "3400", "quoteVolume": "1e9"})
    rows.append({"symbol": "INITUSDT", "lastPrice": "0.2", "quoteVolume": "1.3e7"})
    # High-volume crypto that fill a slice-first top 60 with bStocks, crowding mid-caps.
    for i in range(33):
        rows.append({
            "symbol": f"COIN{i}USDT",
            "lastPrice": "1",
            "quoteVolume": str(8e6 - i * 1e4),
        })
    # Lower-volume crypto still above the $3M floor — fill the 60-cap after bStocks drop.
    for i in range(30):
        rows.append({
            "symbol": f"LOW{i}USDT",
            "lastPrice": "1",
            "quoteVolume": str(3.2e6 + i * 1e3),
        })
    # Tokenized stocks with huge volume — would crowd mid-caps if sliced first.
    for i, base in enumerate(sorted(tokenized)):
        rows.append({
            "symbol": base + "USDT",
            "lastPrice": "100",
            "quoteVolume": str(5e8 - i * 1e6),
        })
    rows.append({"symbol": "USDCUSDT", "lastPrice": "1", "quoteVolume": "9e9"})
    rows.append({"symbol": "BTCUPUSDT", "lastPrice": "10", "quoteVolume": "1e8"})
    return rows, tokenized


class MarketsUniverseTests(unittest.TestCase):
    def test_data_js_drops_bstocks_before_max_coins_slice(self):
        self.assertIn("const MAX_COINS = 60", DATA_JS)
        self.assertIn("function eligible(t, tokenized)", DATA_JS)
        self.assertIn("tokenized.has(base)", DATA_JS)
        fn = DATA_JS.split("async tickers() {", 1)[1].split("async tickersAll()", 1)[0]
        self.assertIn("loadTokenizedBases()", fn)
        self.assertIn("eligible(t, tokenized)", fn)
        self.assertLess(fn.index("loadTokenizedBases()"), fn.index("slice(0, MAX_COINS)"))
        self.assertLess(fn.index("eligible(t, tokenized)"), fn.index("slice(0, MAX_COINS)"))

    def test_fixture_bstocks_before_slice_keeps_hbar_xlm_fil(self):
        rows, tok = fake_tickers()
        wrong = slice_universe(rows, tok, drop_before_slice=False)
        wrong_bases = [t["symbol"][:-4] for t in wrong]
        self.assertNotIn("HBAR", wrong_bases)
        self.assertNotIn("XLM", wrong_bases)
        self.assertNotIn("FIL", wrong_bases)
        self.assertNotIn("SOXSB", wrong_bases)

        right = slice_universe(rows, tok, drop_before_slice=True)
        bases = [t["symbol"][:-4] for t in right]
        self.assertEqual(len(right), MAX_COINS)
        self.assertIn("HBAR", bases)
        self.assertIn("XLM", bases)
        self.assertIn("FIL", bases)
        self.assertIn("INIT", bases)
        for b in tok:
            self.assertNotIn(b, bases)

    def test_tickers_catalog_has_no_slice_or_volume_floor(self):
        self.assertIn("async tickersCatalog()", DATA_JS)
        radar = DATA_JS.split("async tickers() {", 1)[1].split("async tickersAll()", 1)[0]
        self.assertIn("slice(0, MAX_COINS)", radar)
        self.assertIn("eligible(t, tokenized)", radar)
        cat = DATA_JS.split("async tickersCatalog() {", 1)[1].split("async klines", 1)[0]
        # first (live) tickersCatalog body — before demo's copy
        cat = DATA_JS.split("/** Full Markets catalog", 1)[1].split("async klines", 1)[0]
        self.assertIn("gainerEligible(t, tokenized, now)", cat)
        self.assertNotIn("slice(0, MAX_COINS)", cat)
        self.assertNotIn("MIN_QUOTE_VOL", cat)
        self.assertNotIn("eligible(t, tokenized)", cat)
        self.assertIn("loadCatalog()", APP)
        self.assertIn("paintMarketList", APP)
        self.assertIn("mTicks", APP)
        self.assertIn("tickersCatalog()", APP)
        self.assertIn("No coins in the market list yet.", I18N)
        self.assertIn("市場名單暫時冇幣。", I18N)
        self.assertIn("No coins match this search.", I18N)
        self.assertIn("搵幣", I18N)
        self.assertIn("Search coin", I18N)

    def test_markets_catalog_includes_thin_and_outside_radar60(self):
        """Catalog: no $3M floor, no 60-cap; Radar tickers stay 60 with the floor."""
        now = 1_800_000_000_000
        fresh = now - 60_000
        stale = now - 3 * 3600_000
        tokenized = {"SOXSB", "NVDAB", "TSLAB"}
        rows = []
        # High-volume majors that fill the Radar 60 with the $3M floor.
        for i in range(60):
            rows.append({
                "symbol": f"BIG{i}USDT",
                "lastPrice": "1",
                "quoteVolume": str(9e6 - i * 1e3),
                "closeTime": fresh,
            })
        # Outside the score universe: thin (< $3M) mid-cap that search must still find.
        rows.append({
            "symbol": "HBARUSDT",
            "lastPrice": "0.2",
            "quoteVolume": "500000",  # below $3M floor
            "closeTime": fresh,
        })
        # Named coin also below the floor, for name-search.
        rows.append({
            "symbol": "PEPEUSDT",
            "lastPrice": "0.00001",
            "quoteVolume": "100000",
            "closeTime": fresh,
            "name": "Pepe",
        })
        rows.append({"symbol": "SOXSBUSDT", "lastPrice": "100", "quoteVolume": "9e8", "closeTime": fresh})
        rows.append({"symbol": "USDCUSDT", "lastPrice": "1", "quoteVolume": "9e9", "closeTime": fresh})
        rows.append({"symbol": "BTCUPUSDT", "lastPrice": "10", "quoteVolume": "1e8", "closeTime": fresh})
        rows.append({"symbol": "CREAMUSDT", "lastPrice": "1", "quoteVolume": "8e6", "closeTime": stale})
        rows.append({"symbol": "ETHUSDT", "lastPrice": "0", "quoteVolume": "8e6", "closeTime": fresh})

        def gainer_eligible(t, tok):
            sym = t["symbol"]
            if not sym.endswith("USDT"):
                return False
            base = sym[:-4]
            if not base or base in STABLES:
                return False
            if re.search(r"(UP|DOWN|BULL|BEAR)$", base) and len(base) > 4:
                return False
            if tok and base in tok:
                return False
            if now - int(t["closeTime"]) > 2 * 3600_000:
                return False
            return float(t["lastPrice"]) > 0

        radar = slice_universe(rows, tokenized, drop_before_slice=True)
        radar_bases = [t["symbol"][:-4] for t in radar]
        catalog = [t for t in rows if gainer_eligible(t, tokenized)]
        catalog.sort(key=lambda t: -float(t["quoteVolume"]))
        cat_syms = [t["symbol"] for t in catalog]
        self.assertEqual(len(radar), MAX_COINS)
        self.assertNotIn("HBAR", radar_bases)
        self.assertNotIn("PEPE", radar_bases)
        self.assertGreater(len(catalog), MAX_COINS)
        self.assertIn("HBARUSDT", cat_syms)
        self.assertIn("PEPEUSDT", cat_syms)
        self.assertNotIn("SOXSBUSDT", cat_syms)
        self.assertNotIn("USDCUSDT", cat_syms)
        self.assertNotIn("BTCUPUSDT", cat_syms)
        self.assertNotIn("CREAMUSDT", cat_syms)

        node = __import__("shutil").which("node")
        if not node:
            return
        js = r"""
          const tokenized = new Set(["SOXSB"]);
          function isTokenizedSym(sym) { return tokenized.has(String(sym || "").replace(/USDT$/, "")); }
          const mTicks = {};
          const scores = {};
          for (let i = 0; i < 60; i++) {
            const s = "BIG" + i + "USDT";
            mTicks[s] = { base: "BIG" + i, name: "Big" + i, open24: 1, price: 1, qv24: 9e6 - i * 1e3 };
            scores[s] = { score: 50, stage: "quiet" };
          }
          mTicks.HBARUSDT = { base: "HBAR", name: "Hedera", open24: 1, price: 0.2, qv24: 5e5 };
          mTicks.PEPEUSDT = { base: "PEPE", name: "Pepe", open24: 1, price: 0.00001, qv24: 1e5 };
          mTicks.SOXSBUSDT = { base: "SOXSB", name: "SOXS", open24: 1, price: 100, qv24: 9e8 };
          function marketList(q) {
            q = (q || "").trim().toUpperCase();
            return Object.keys(mTicks).filter((s) => {
              const tk = mTicks[s];
              if (!tk || isTokenizedSym(s)) return false;
              if (!q) return true;
              const base = (tk.base || s.replace(/USDT$/, "")).toUpperCase();
              const name = (tk.name || "").toUpperCase();
              return s.includes(q) || base.includes(q) || name.includes(q);
            });
          }
          const all = marketList("");
          const hbar = marketList("HBAR");
          const hedera = marketList("hedera");
          const pepe = marketList("pepe");
          const miss = marketList("ZZZZNOTACOIN");
          console.log(JSON.stringify({
            n: all.length,
            hasHbar: all.includes("HBARUSDT"),
            hasPepe: all.includes("PEPEUSDT"),
            hasSox: all.includes("SOXSBUSDT"),
            hbar, hedera, pepe, miss,
            radarN: Object.keys(scores).length,
          }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        self.assertGreater(out["n"], 60)
        self.assertTrue(out["hasHbar"] and out["hasPepe"])
        self.assertFalse(out["hasSox"])
        self.assertEqual(out["hbar"], ["HBARUSDT"])
        self.assertEqual(out["hedera"], ["HBARUSDT"])
        self.assertEqual(out["pepe"], ["PEPEUSDT"])
        self.assertEqual(out["miss"], [])
        self.assertEqual(out["radarN"], 60)

    def test_radar_drops_soxsB_leftover(self):
        self.assertIn("S.scores = {}", APP)
        self.assertIn("isTokenizedSym(S.selected)", APP)
        self.assertIn("if (!S.ticks[sym] || isTokenizedSym(sym)) continue", APP)
        self.assertIn("isTokenizedSym(sym)", APP.split("function ensureTick", 1)[1].split("function closePart", 1)[0])
        node = __import__("shutil").which("node")
        if not node:
            return
        js = r"""
          const tokenized = new Set(["SOXSB"]);
          function isTokenizedSym(sym) { return tokenized.has(String(sym || "").replace(/USDT$/, "")); }
          const scores = {
            SOXSBUSDT: { score: 99, stage: "late" },
            INITUSDT: { score: 80, stage: "early" },
            BTCUSDT: { score: 50, stage: "quiet" },
          };
          const ticks = {
            INITUSDT: { base: "INIT" },
            BTCUSDT: { base: "BTC" },
          };
          function ranked(filter) {
            const out = [];
            for (const sym in scores) {
              const r = scores[sym];
              if (!r || !r.stage) continue;
              if (!ticks[sym] || isTokenizedSym(sym)) continue;
              if (sym === "BTCUSDT" && filter !== "all") continue;
              if (filter === "all" || r.stage === filter) out.push(sym);
            }
            return out.sort((a, b) => (scores[b].score || 0) - (scores[a].score || 0));
          }
          const all = ranked("all");
          console.log(JSON.stringify({ all, hasSox: all.includes("SOXSBUSDT"), hasInit: all.includes("INITUSDT") }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        self.assertFalse(out["hasSox"])
        self.assertTrue(out["hasInit"])
        self.assertNotIn("SOXSBUSDT", out["all"])

    def test_strategy_frozen(self):
        sha = subprocess.check_output(
            ["git", "hash-object", str(ROOT / "js/strategy.js")], text=True
        ).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")


if __name__ == "__main__":
    unittest.main()
