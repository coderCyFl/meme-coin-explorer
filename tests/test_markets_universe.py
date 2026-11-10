"""Markets full list + bStocks dropped before MAX_COINS; no SOXSB Radar leftover."""
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

    def test_markets_shows_full_list_including_quiet(self):
        self.assertNotIn('S.scores[s].stage === "quiet"', APP)
        self.assertIn("isTokenizedSym(s)", APP)
        self.assertIn('"m.empty"', I18N)
        self.assertIn("No coins match this search.", I18N)
        self.assertIn("冇幣符合呢個搜尋。", I18N)
        self.assertIn("No coins in the scanned list yet.", I18N)
        self.assertIn("掃描名單暫時冇幣。", I18N)
        node = __import__("shutil").which("node")
        if not node:
            return
        js = r"""
          const scores = { BTCUSDT: { score: 50, stage: "quiet" }, INITUSDT: { score: 80, stage: "early" } };
          const ticks = { BTCUSDT: { name: "Bitcoin", open24: 1, price: 1, qv24: 1 }, INITUSDT: { name: "Init", open24: 1, price: 1, qv24: 1 } };
          const tokenized = new Set(["SOXSB"]);
          for (let i = 0; i < 58; i++) {
            const s = "Q" + i + "USDT";
            scores[s] = { score: 40, stage: "quiet" };
            ticks[s] = { name: "Quiet" + i, open24: 1, price: 1, qv24: 1 };
          }
          scores.SOXSBUSDT = { score: 90, stage: "late" };
          ticks.SOXSBUSDT = { name: "SOXS", open24: 1, price: 1, qv24: 9e8 };
          function isTokenizedSym(sym) { return tokenized.has(String(sym || "").replace(/USDT$/, "")); }
          function marketList(q) {
            q = (q || "").trim().toUpperCase();
            return Object.keys(scores).filter((s) => {
              if (!ticks[s] || !scores[s]) return false;
              if (s === "BTCUSDT") return false;
              if (isTokenizedSym(s)) return false;
              return !q || s.includes(q) || ticks[s].name.toUpperCase().includes(q);
            });
          }
          const m = marketList("");
          const oldHideQuiet = Object.keys(scores).filter((s) => {
            if (!ticks[s] || !scores[s] || s === "BTCUSDT") return false;
            if (scores[s].stage === "quiet") return false;
            return true;
          });
          console.log(JSON.stringify({
            n: m.length,
            hasInit: m.includes("INITUSDT"),
            hasQuiet: m.includes("Q0USDT"),
            hasSox: m.includes("SOXSBUSDT"),
            hasBtc: m.includes("BTCUSDT"),
            oldN: oldHideQuiet.length,
          }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        self.assertEqual(out["n"], 59)
        self.assertTrue(out["hasInit"] and out["hasQuiet"])
        self.assertFalse(out["hasSox"] or out["hasBtc"])
        self.assertEqual(out["oldN"], 2)  # hide-quiet leaves INIT + leftover SOXSB

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
