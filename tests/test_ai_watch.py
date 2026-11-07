"""AI Watch B — secure producer: cap, atomic schema, no client secrets, strategy frozen."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools/ai_watch_producer.mjs"
FIXTURE = ROOT / "tests/fixtures/ai_watch_fixture.json"
WORKFLOW = ROOT / ".github/workflows/ai-watch.yml"
STRATEGY = ROOT / "js/strategy.js"
STRATEGY_SHA = "30b15dc7283d5afc411706e2244e288bf3bd4277"


class AiWatchBTests(unittest.TestCase):
    def test_producer_exists_and_documents_secrets_rule(self):
        src = TOOL.read_text(encoding="utf-8")
        assert "DAILY_CAP = 300" in src
        assert "X_BEARER_TOKEN" in src and "XAI_API_KEY" in src
        assert "never commit" in src.lower() or "Actions only" in src
        assert "atomic" in src.lower() or "renameSync" in src
        assert "ai_watch_history" in src
        assert "HKT" in src or "UTC+8" in src
        assert "no packages" in src.lower() or "built-in fetch" in src

    def test_workflow_schedule_off_secrets_from_actions(self):
        yml = WORKFLOW.read_text(encoding="utf-8")
        assert "workflow_dispatch" in yml
        assert "secrets.X_BEARER_TOKEN" in yml
        assert "secrets.XAI_API_KEY" in yml
        # cron must stay commented until PM activates
        for line in yml.splitlines():
            s = line.strip()
            if s.startswith("- cron:"):
                self.fail("active cron found — 15-min schedule must stay OFF")
        assert "*/15" in yml  # documented but commented
        assert yml.count("#   - cron:") >= 1 or "# schedule:" in yml or "schedule:" in yml and "OFF" in yml

    def test_strategy_js_untouched(self):
        out = subprocess.check_output(["git", "hash-object", str(STRATEGY)], cwd=ROOT, text=True).strip()
        self.assertEqual(out, STRATEGY_SHA)

    def test_no_secrets_in_client_files(self):
        banned = ("X_BEARER_TOKEN=", "XAI_API_KEY=", "Bearer sk-", "xai-")
        for rel in ("js/app.js", "js/data.js", "js/i18n.js", "js/strategy.js", "index.html"):
            txt = (ROOT / rel).read_text(encoding="utf-8", errors="ignore")
            for b in banned:
                self.assertNotIn(b, txt, rel)

    def test_cap_math_and_fixture_run(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            # Isolate writes via cwd copy of minimal tree is heavy; run fixture against repo
            # but use a temp OUT by invoking node -e importing pure helpers.
            js = r"""
import { remainingCap, DAILY_CAP, buildFromFixture, callsOnDay, hktDate } from './tools/ai_watch_producer.mjs';
import { readFileSync } from 'fs';
const fx = JSON.parse(readFileSync('./tests/fixtures/ai_watch_fixture.json','utf8'));
if (remainingCap(0) !== DAILY_CAP) throw new Error('cap0');
if (remainingCap(300) !== 0) throw new Error('capfull');
if (remainingCap(290) !== 10) throw new Error('cap10');
const day = '2099-01-01';
const doc = buildFromFixture(fx, { day, callsToday: 297 });
if (doc.cap.daily_cap !== 300) throw new Error('daily');
if (doc.cap.calls_today !== 300) throw new Error('today '+doc.cap.calls_today);
if (!doc.cap.cap_reached) throw new Error('reached');
if (doc.entries.length !== 1) throw new Error('entries');
if (!doc.source.note.includes('0 client secrets')) throw new Error('note');
const n = callsOnDay([{ts:'2099-01-01T01:00:00+08:00'},{ts:'2099-01-02T01:00:00+08:00'}], '2099-01-01');
if (n !== 1) throw new Error('callsOnDay '+n);
console.log('ok');
"""
            r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("ok", r.stdout)

    def test_fixture_cli_writes_schema(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            # Run producer in-repo but point fixtures; it writes to data/ — restore after
            watch = ROOT / "data/ai_watch.json"
            hist = ROOT / "data/ai_watch_history"
            prev = watch.read_text(encoding="utf-8") if watch.exists() else None
            prev_calls = (hist / "calls.jsonl").read_text(encoding="utf-8") if (hist / "calls.jsonl").exists() else None
            try:
                r = subprocess.run(
                    ["node", str(TOOL), "--fixtures", str(FIXTURE)],
                    cwd=ROOT, capture_output=True, text=True,
                )
                self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
                doc = json.loads(watch.read_text(encoding="utf-8"))
                self.assertEqual(doc["schema_version"], 1)
                self.assertEqual(doc["cap"]["daily_cap"], 300)
                self.assertIn("reset", doc["cap"])
                self.assertTrue(doc["entries"])
                self.assertEqual(doc["entries"][0]["symbol"], "ACTUSDT")
                self.assertIn("x", doc["entries"][0])
                self.assertIn("grok", doc["entries"][0])
                self.assertTrue((hist / "calls.jsonl").exists())
            finally:
                if prev is None and watch.exists():
                    watch.unlink()
                elif prev is not None:
                    watch.write_text(prev, encoding="utf-8")
                calls = hist / "calls.jsonl"
                if prev_calls is None and calls.exists():
                    calls.unlink()
                elif prev_calls is not None:
                    calls.write_text(prev_calls, encoding="utf-8")

    def test_fixture_file_valid(self):
        fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(fx["x_calls"] + fx["grok_calls"], 1)
        self.assertLessEqual(fx["x_calls"] + fx["grok_calls"], 300)
        self.assertTrue(fx["entries"])


if __name__ == "__main__":
    unittest.main()
