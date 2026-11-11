"""Gainers in-page search over the full tickersAll / gainerEligible list."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from shutil import which

ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "js/app.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
I18N = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
CSS = (ROOT / "css/app.css").read_text(encoding="utf-8")


class GainersSearchTests(unittest.TestCase):
    def test_markup_and_locked_copy(self):
        gainers = HTML.split('data-page="gainers"', 1)[1].split('data-page="aiwatch"', 1)[0]
        self.assertIn('id="gSearch"', gainers)
        self.assertIn('data-tph="g.search"', gainers)
        self.assertNotIn("hidden", gainers.split('id="gSearch"', 1)[1].split(">", 1)[0])
        self.assertIn("#gSearch", CSS)
        self.assertIn('"g.search": "Search coin"', I18N)
        self.assertIn('"g.searchEmpty": "No coins match this search."', I18N)
        self.assertIn('"g.searchEmpty": "冇幣符合呢個搜尋。"', I18N)
        # Locked ZH placeholder is 搵幣 (U+6435), same as Markets — not 搕 / 搜 / 搗 / 搔.
        zh = I18N.split('"g.search": "', 2)[2]
        placeholder = zh.split('"', 1)[0]
        self.assertEqual(placeholder, "搵幣")
        self.assertEqual(ord(placeholder[0]), 0x6435)
        self.assertIn('"m.search": "搵幣"', I18N)
        for bad in ("搕幣", "搜幣", "搗幣", "搔幣"):
            self.assertNotIn(f'"g.search": "{bad}"', I18N)
            self.assertNotIn(f'"m.search": "{bad}"', I18N)

    def test_search_uses_full_list_not_tab_slice(self):
        self.assertIn("coinQueryHit", APP)
        self.assertIn("S.gQ", APP)
        self.assertIn('e.target.id === "gSearch"', APP)
        # Empty query still caps to G_TOP; a typed query must not.
        body = APP.split("function gainerSyms()", 1)[1].split("function ranked", 1)[0]
        # G_TOP slice stays on empty-query Gainers/Losers only — All is unsliced.
        self.assertIn("list.slice(0, G_TOP)", body)
        self.assertIn("coinQueryHit(S.gTicks[s], q)", body)
        self.assertNotIn("slice(0, G_TOP)", body.split("if (q)", 1)[1].split("if (S.gHideLow)", 1)[0])
        self.assertIn('if (S.gMode === "all") return list;', body)
        after_all = body.split('if (S.gMode === "all") return list;', 1)[1]
        self.assertIn("list.slice(0, G_TOP)", after_all)

    def test_empty_list_copy_refreshes_on_language_switch(self):
        # paintGainerList must always write emptyHTML so EN↔ZH updates the body,
        # not only chrome/meta. Skipping when dataset.key is already "empty" leaves
        # "No coins match this search." stuck after a 中 click.
        body = APP.split("function paintGainerList", 1)[1].split("const existing", 1)[0]
        self.assertIn("emptyHTML", body)
        self.assertIn('el.dataset.key = "empty"', body)
        self.assertNotIn('el.dataset.key !== "empty"', body)
        self.assertIn("insertAdjacentHTML", body)

    def test_saga_finds_saga_typo_empty_and_all_intact(self):
        node = which("node")
        if not node:
            self.skipTest("node not installed")
        js = r"""
          const G_TOP = 20, G_VOL_FLOOR = 1e6;
          const gTicks = {};
          // All-tab volume ranking: 25 high-vol names, plus SAGA below the $1M hide floor
          // and outside the top 20, plus a named mid-cap.
          for (let i = 0; i < 25; i++) {
            const base = "BIG" + i;
            const ch = 0.2 - i * 0.001;
            gTicks[base + "USDT"] = { sym: base + "USDT", base, name: "Big " + i, price: 1, open24: 1 / (1 + ch), qv24: 9e6 - i * 1e3 };
          }
          gTicks.SAGAUSDT = { sym: "SAGAUSDT", base: "SAGA", name: "Saga", price: 0.12, open24: 0.12, qv24: 4e5 };
          gTicks.PYTHUSDT = { sym: "PYTHUSDT", base: "PYTH", name: "Pyth Network", price: 0.3, open24: 0.28, qv24: 2e6 };
          function coinQueryHit(tk, q) {
            if (!tk || !q) return !q;
            const sym = String(tk.sym || "").toUpperCase();
            const base = String(tk.base || sym.replace(/USDT$/, "")).toUpperCase();
            const name = String(tk.name || "").toUpperCase();
            return sym.includes(q) || base.includes(q) || name.includes(q);
          }
          function gainerSyms(S) {
            let list = Object.keys(gTicks);
            const q = (S.gQ || "").trim().toUpperCase();
            if (q) {
              list = list.filter((s) => coinQueryHit(gTicks[s], q));
              const exact = (s) => {
                const tk = gTicks[s] || {};
                const base = String(tk.base || s.replace(/USDT$/, "")).toUpperCase();
                return (base === q || s === q || s === q + "USDT") ? 1 : 0;
              };
              list.sort((a, b) => exact(b) - exact(a) || (gTicks[b].qv24 || 0) - (gTicks[a].qv24 || 0));
              return list;
            }
            if (S.gHideLow) list = list.filter((s) => gTicks[s].qv24 >= G_VOL_FLOOR);
            const ch = (s) => { const tk = gTicks[s]; return tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0; };
            if (S.gMode === "losers") list.sort((a, b) => ch(a) - ch(b));
            else if (S.gMode === "all") list.sort((a, b) => gTicks[b].qv24 - gTicks[a].qv24);
            else list.sort((a, b) => ch(b) - ch(a));
            if (S.gMode === "all") return list;
            return list.slice(0, G_TOP);
          }
          const allEmpty = gainerSyms({ gQ: "", gMode: "all", gHideLow: false });
          const allHide = gainerSyms({ gQ: "", gMode: "all", gHideLow: true });
          const gainersEmpty = gainerSyms({ gQ: "", gMode: "gainers", gHideLow: false });
          const losersEmpty = gainerSyms({ gQ: "", gMode: "losers", gHideLow: false });
          const sagaLower = gainerSyms({ gQ: "saga", gMode: "gainers", gHideLow: true });
          const sagaUpper = gainerSyms({ gQ: "SAGA", gMode: "losers", gHideLow: true });
          const sagaName = gainerSyms({ gQ: "Saga", gMode: "gainers", gHideLow: true });
          const typo = gainerSyms({ gQ: "zznotacoin", gMode: "all", gHideLow: false });
          const emptyAgain = gainerSyms({ gQ: "", gMode: "all", gHideLow: false });
          console.log(JSON.stringify({
            allN: allEmpty.length, all0: allEmpty[0], hasSagaInAll: allEmpty.includes("SAGAUSDT"),
            hideN: allHide.length, hideHasSaga: allHide.includes("SAGAUSDT"), hideHasPyth: allHide.includes("PYTHUSDT"),
            gainersN: gainersEmpty.length, gainersHasSaga: gainersEmpty.includes("SAGAUSDT"),
            losersN: losersEmpty.length,
            sagaLower, sagaUpper, sagaName, typo, emptyAgain,
          }));
        """
        out = json.loads(subprocess.check_output([node, "-e", js], text=True).strip())
        # All tab: unsliced full list, includes a non-top name such as SAGA.
        self.assertGreater(out["allN"], 20)
        self.assertEqual(out["allN"], 27)  # 25 BIG + SAGA + PYTH
        self.assertEqual(out["all0"], "BIG0USDT")
        self.assertTrue(out["hasSagaInAll"])
        self.assertGreater(out["hideN"], 20)
        self.assertFalse(out["hideHasSaga"])
        self.assertTrue(out["hideHasPyth"])
        # Empty search on Gainers / Losers still top 20.
        self.assertEqual(out["gainersN"], 20)
        self.assertFalse(out["gainersHasSaga"])
        self.assertEqual(out["losersN"], 20)
        self.assertEqual(out["sagaLower"], ["SAGAUSDT"])
        self.assertEqual(out["sagaUpper"], ["SAGAUSDT"])
        self.assertEqual(out["sagaName"], ["SAGAUSDT"])
        self.assertEqual(out["typo"], [])
        self.assertEqual(out["emptyAgain"], out["allEmpty"] if "allEmpty" in out else out["emptyAgain"])
        self.assertEqual(len(out["emptyAgain"]), 27)
        self.assertEqual(out["emptyAgain"][0], "BIG0USDT")
        self.assertIn("SAGAUSDT", out["emptyAgain"])


if __name__ == "__main__":
    unittest.main()
