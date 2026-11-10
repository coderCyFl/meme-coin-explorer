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
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE",
    "XUSD", "USD1", "PAXG", "WBTC", "BFUSD", "EURI",
}
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


if __name__ == "__main__":
    unittest.main()
