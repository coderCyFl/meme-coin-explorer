"""Gainers tab: drop BREAK phantoms (stale MINI closeTime) + bStocks; no CREAM sticky."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_JS = (ROOT / "js/data.js").read_text(encoding="utf-8")
I18N = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
FIX = json.loads((ROOT / "tests/fixtures/gainers_stale_tokenized.json").read_text(encoding="utf-8"))

STABLES = {
    "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "EURI", "AEUR", "XUSD", "USD1", "BFUSD",
    "USDE", "USDEB", "U", "FRAX", "RLUSD", "USDS", "RWUSD", "PYUSD", "PAXG", "XAUT", "WBTC", "WBETH", "BNSOL",
    "KGST",
}

EXTRA_STABLES = ("RLUSD", "RWUSD", "U", "USDS", "KGST", "WBETH", "BNSOL", "FRAX", "XAUT", "PYUSD", "USDEB")


def parse_js_stables(src):
    m = re.search(r"const STABLES = new Set\(\[(.*?)\]\)", src, re.S)
    return set(re.findall(r'"([^"]+)"', m.group(1)))


GAINER_STALE_MS = 2 * 3600 * 1000


def ticker_fresh(t, now):
    ct = float(t.get("closeTime") or 0)
    if not ct:
        return False
    return (now - ct) <= GAINER_STALE_MS


def gainer_eligible(t, tokenized, now):
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
    if not ticker_fresh(t, now):
        return False
    return float(t["lastPrice"]) > 0


def change24(t):
    o = float(t["openPrice"] or 0)
    p = float(t["lastPrice"] or 0)
    return (p / o - 1) if o > 0 else 0


class GainersBinanceSyncTests(unittest.TestCase):
    def test_data_js_wires_stale_and_tokenized(self):
        self.assertIn("GAINER_STALE_MS = 2 * 3600e3", DATA_JS)
        self.assertIn("function tickerFresh(", DATA_JS)
        self.assertIn("closeTime", DATA_JS)
        self.assertIn("data/gainer_board/tokenized_stocks.json", DATA_JS)
        self.assertIn("loadTokenizedBases", DATA_JS)
        self.assertIn("gainerEligible(t, tokenized, now)", DATA_JS)
        self.assertNotIn("CREAM", DATA_JS)  # never hard-code the sticky symbol

    def test_i18n_no_same_universe_overclaim(self):
        self.assertNotIn("same universe as Binance", I18N)
        self.assertNotIn("同 Binance 同一宇宙", I18N)
        self.assertIn("fresh tickers only", I18N)
        self.assertIn("tokenized stocks", I18N)
        self.assertIn("只計有成交嘅票", I18N)
        self.assertIn("代幣化股票", I18N)
        self.assertIn("live USDT spot", I18N)
        self.assertIn("即時 USDT 現貨", I18N)

    def test_fixture_drops_cream_stale_and_bstocks(self):
        now = FIX["now_ms"]
        tok = set(FIX["tokenized_bases"])
        kept = [t for t in FIX["tickers"] if gainer_eligible(t, tok, now)]
        bases = [t["symbol"][:-4] for t in kept]
        self.assertNotIn("CREAM", bases)
        self.assertNotIn("PNT", bases)
        self.assertNotIn("SOXLB", bases)
        self.assertNotIn("AMDB", bases)
        self.assertNotIn("USDC", bases)
        self.assertNotIn("BTCUP", bases)
        ranked = sorted(kept, key=change24, reverse=True)
        self.assertEqual([t["symbol"][:-4] for t in ranked], FIX["expect_bases"])
        self.assertEqual(ranked[0]["symbol"], "INITUSDT")

    def test_strategy_frozen(self):
        sha = subprocess.check_output(
            ["git", "hash-object", str(ROOT / "js/strategy.js")], text=True
        ).strip()
        self.assertEqual(sha, "30b15dc7283d5afc411706e2244e288bf3bd4277")

    def test_frontend_stables_dropped_from_gainers_all(self):
        """tickersAll / gainerEligible drop the aligned stable bases, including PYUSD and USDEB."""
        js_set = parse_js_stables(DATA_JS)
        self.assertTrue(set(EXTRA_STABLES) <= js_set)
        now = 1_800_000_000_000
        fresh = now - 60_000
        rows = [
            {"symbol": b + "USDT", "lastPrice": "1", "quoteVolume": "9e9", "openPrice": "1", "closeTime": fresh}
            for b in list(EXTRA_STABLES) + ["BTC", "SAGA"]
        ]
        # tickersAll is gainerEligible over the MINI list (no volume floor).
        kept = [t for t in rows if gainer_eligible(t, set(), now)]
        bases = {t["symbol"][:-4] for t in kept}
        for b in EXTRA_STABLES:
            self.assertNotIn(b, bases)
        self.assertIn("BTC", bases)
        self.assertIn("SAGA", bases)
        self.assertIn("function tickersAll()", DATA_JS.replace("async ", "function "))
        all_body = DATA_JS.split("async tickersAll() {", 1)[1].split("async tickersCatalog()", 1)[0]
        self.assertIn("gainerEligible(t, tokenized, now)", all_body)
        node = __import__("shutil").which("node")
        if not node:
            return
        js = r"""
          const assert = require("node:assert/strict");
          const fs = require("node:fs"), vm = require("node:vm");
          const context = { window: {}, Date, fetch: async () => { throw new Error("no net"); } };
          vm.createContext(context);
          vm.runInContext(fs.readFileSync("js/data.js", "utf8"), context);
          const { gainerEligible } = context.window.Market;
          const now = Date.now();
          const drop = ["RLUSD","RWUSD","U","USDS","KGST","WBETH","BNSOL","FRAX","XAUT","PYUSD","USDEB"];
          const row = (base) => ({ symbol: base+"USDT", lastPrice: "1", quoteVolume: "9e9", openPrice: "1", closeTime: now });
          const all = [...drop, "BTC", "SAGA"].map(row);
          function tickersAll(list) { return list.filter((t) => gainerEligible(t, new Set(), now)); }
          const kept = tickersAll(all).map((t) => t.symbol.slice(0, -4));
          for (const b of drop) assert.ok(!kept.includes(b), "kept "+b);
          assert.ok(kept.includes("BTC") && kept.includes("SAGA"));
        """
        subprocess.run([node, "-e", js], cwd=ROOT, check=True, capture_output=True, text=True)



if __name__ == "__main__":
    unittest.main()
