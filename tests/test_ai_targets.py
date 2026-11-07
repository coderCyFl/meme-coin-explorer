"""AI Watch A — targets union ≤25, meme list, top_coins tool."""
import json, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEME = ROOT / "data/meme_coins.json"
TOOL = ROOT / "tools/top_coins.mjs"


class AiTargetsTests(unittest.TestCase):
    def test_meme_coins_verified_schema(self):
        doc = json.loads(MEME.read_text(encoding="utf-8"))
        assert "Binance" in doc["source"] and "Meme" in doc["source"]
        assert doc.get("source_url")
        assert doc.get("fetched_at")
        assert "PM maintains" in doc.get("note", "")
        coins = doc["coins"]
        assert len(coins) >= 10
        seen = set()
        for c in coins:
            assert c["symbol"].endswith("USDT")
            assert c["base"]
            assert c["symbol"] not in seen
            seen.add(c["symbol"])
            assert "Meme" in c.get("tags", [])

    def test_top_coins_tool_exists_no_packages(self):
        src = TOOL.read_text(encoding="utf-8")
        assert "mergeTargets" in src
        assert "PER_BUCKET = 10" in src or "perBucket = 10" in src or "per_bucket" in src
        assert "CAP = 25" in src or "cap = 25" in src
        assert "early" in src and "gainer" in src and "meme_volume" in src
        assert "no packages" in src.lower() or "built-in fetch" in src
        assert "js/strategy.js" in src
        assert "data/meme_coins.json" in src
        assert "data/ai_targets.json" in src

    def test_union_dedupe_cap_and_reasons(self):
        """30 candidate slots → unique merge → ≤25 with truncation disclosure."""
        buckets = {
            "per_bucket": 10,
            "cap": 25,
            "buckets": {
                "early": [{"symbol": f"E{i:02d}USDT", "base": f"E{i:02d}", "score": 90 - i, "change_24h": 0.01, "volume_24h": 1e7} for i in range(10)],
                "gainer": (
                    [{"symbol": "E00USDT", "base": "E00", "score": None, "change_24h": 0.5, "volume_24h": 2e7}]
                    + [{"symbol": f"G{i:02d}USDT", "base": f"G{i:02d}", "score": None, "change_24h": 0.4 - i * 0.01, "volume_24h": 1e7} for i in range(9)]
                ),
                "meme_volume": (
                    [{"symbol": "E00USDT", "base": "E00", "score": None, "change_24h": 0.01, "volume_24h": 9e8}]
                    + [{"symbol": f"M{i:02d}USDT", "base": f"M{i:02d}", "score": None, "change_24h": 0.02, "volume_24h": 8e8 - i * 1e7} for i in range(9)]
                ),
            },
        }
        with tempfile.TemporaryDirectory() as td:
            fx = Path(td) / "fx.json"
            out = Path(td) / "out.json"
            fx.write_text(json.dumps(buckets), encoding="utf-8")
            subprocess.check_call(["node", str(TOOL), "--fixtures", str(fx), "--out", str(out)], cwd=str(ROOT))
            doc = json.loads(out.read_text(encoding="utf-8"))
        assert len(doc["entries"]) == 25
        assert doc["policy"]["unique_before_cap"] == 28  # 10+9+9 unique after overlap on E00
        assert doc["policy"]["truncation"] is not None
        assert len(doc["policy"]["truncation"]["dropped"]) == 3
        e0 = next(e for e in doc["entries"] if e["symbol"] == "E00USDT")
        assert e0["reason"] == ["early", "gainer", "meme_volume"]
        for e in doc["entries"]:
            assert set(e["reason"]) <= {"early", "gainer", "meme_volume"}
            assert e["symbol"].endswith("USDT")
            assert "base" in e and "change_24h" in e and "volume_24h" in e

    def test_strategy_untouched_blob(self):
        h = subprocess.check_output(["git", "hash-object", str(ROOT / "js/strategy.js")], text=True).strip()
        # Must stay the known baseline tip-era frozen blob.
        self.assertEqual(h, "30b15dc7283d5afc411706e2244e288bf3bd4277")


if __name__ == "__main__":
    unittest.main()
