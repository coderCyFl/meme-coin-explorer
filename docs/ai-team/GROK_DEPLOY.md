# Grok deploy prompt

Attach `meme-coin-explorer-v2.zip` and paste everything below the line.

---

You have push access to my GitHub repo for Crypto.M (GitHub Pages site). Deploy the attached **Crypto.M v2** front-end.
The zip contains a folder `meme-coin-explorer-main/`. Its contents map to the **root** of my repo.
Read `AGENTS.md` and `docs/DEPLOY.md` inside the zip first.

**Very important:**
- Do **NOT** copy or change anything in `data/` (except adding the new `data/strategy/README.json`) or in `.github/`.
  My GitHub Actions update `data/` every few minutes; the zip has an older copy that would roll my data back.
- Do **NOT** push directly to `main`. Work on a branch and open a Pull Request.
- Upload `img/coins/*.png` as **binary** files (not text), or the coin logos will be broken.

**Steps**
1. Pull the latest `main`. Create branch `v2-ui` from it.
2. Delete these old front-end files from the repo root (the zip keeps copies in `legacy/`):
   `index.html`, `styles.css`, `app.js`, `picks.js`, `live.js`, `market.js`, `coin3d.js`, `tests/test_auth_persist.py`, `tests/test_early_lock_seed.py` (these tests check the old code)
3. Add or replace these files from the zip (same paths at the repo root):
   - `index.html`, `sw.js`, `README.md`, `AGENTS.md`
   - `css/app.css`
   - `js/app.js`, `js/coin3d.js`, `js/data.js`, `js/i18n.js`, `js/strategy.js`
   - `img/coins/` (all 30 PNG files)
   - `tools/backtest.mjs`, `tools/build_demo.py`
   - `tests/test_frontend.py`
   - `docs/DEPLOY.md`, `docs/ai-team/PM.md`, `DEV.md`, `QA.md`, `STRATEGY.md`, `GROK_DEPLOY.md`
   - `legacy/` (all files)
   - `data/strategy/README.json`
   Leave every other file (`scripts/`, `data/`, `.github/`, `icons/`, favicons, `site.webmanifest`, other `tests/`, `docs/*.md`) as it is in `main`.
4. If you can run commands: `python3 -m unittest discover -s tests` must pass (this is what the CI runs), and `node --check tools/backtest.mjs` must succeed.
5. Commit with the message `Crypto.M v2: new UI, 3D coins + mascot, Early Score, All-in tab, AI team docs`.
   Push `v2-ui` and open a Pull Request to `main`. In the PR description list what was added, removed and left untouched.
6. Send me the PR link and a short summary in English and 繁中. **Wait for me to reply "merge"** before merging.
7. After I say "merge": merge the PR, then watch the **Deploy GitHub Pages** action until it finishes.
   Tell me if it passed, and check that the live site loads `js/app.js`, `css/app.css` and `img/coins/WIF.png` without 404s.
   If anything fails, tell me exactly what failed. Don't try risky fixes on `main`; open a new PR instead.
