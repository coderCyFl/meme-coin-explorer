# Deploying v2 to GitHub Pages

The Pages workflow (`.github/workflows/pages.yml`) deploys automatically on every push to `main`.

**Important:** your GitHub Actions write new files into `data/` every few minutes. The `data/` folder in this
zip is an older copy, so **don't copy `data/` over your repo** (or `.github/`, which is unchanged).

```bash
# 1. start from the latest main
git checkout main && git pull

# 2. new branch
git checkout -b v2-ui

# 3. remove the old front-end files (they now live in legacy/) and the old test
git rm index.html styles.css app.js picks.js live.js market.js coin3d.js tests/test_auth_persist.py tests/test_early_lock_seed.py README.md

# 4. unzip somewhere else, then copy everything EXCEPT data/ and .github/
unzip ~/Downloads/meme-coin-explorer-v2.zip -d /tmp/v2
rsync -a --exclude 'data/' --exclude '.github/' /tmp/v2/meme-coin-explorer-main/ ./

# 5. check, commit, push
python3 -m http.server 8000          # open http://localhost:8000 and click around
python3 -m unittest discover -s tests   # should pass (same as CI)
git add -A && git commit -m "Crypto.M v2 front-end"
git push -u origin v2-ui
```
6. On GitHub, open a Pull Request from `v2-ui` to `main` and merge it. The "Deploy GitHub Pages" action runs (~1 min).
7. Open the site. The status pill should say **Live Binance data**. If you still see the old site, refresh once
   (the new `sw.js` clears the old cache).

To roll back: GitHub → the merged PR → **Revert**.
