"""Contract: Early 24h display lock seeds from server latest.active (face retain)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PICKS = (ROOT / "picks.js").read_text(encoding="utf-8")


def test_early_lock_helpers_present():
    for needle in (
        "GB_EARLY_LOCK_KEY",
        "GB_EARLY_LOCK_MS",
        "gbUpsertEarlyLock",
        "gbSeedEarlyLocksFromServer",
        "gbTouchEarlyLocks",
        "gbMergeEarlyRetained",
    ):
        assert needle in PICKS, needle


def test_seed_uses_server_active_early2():
    assert 'e.tier !== "early2"' in PICKS or "e.tier !== 'early2'" in PICKS
    assert "latest.active" in PICKS
    assert "entry_price_usd" in PICKS
    # merge still wired after live early build
    assert "early = gbMergeEarlyRetained(early, res.prices)" in PICKS


def test_first_flag_never_moves_forward():
    # upsert keeps earlier mentioned_at
    assert "tNew >= tPrev" in PICKS
    assert "gbSeedEarlyLocksFromServer(map, gbStatic && gbStatic.latest)" in PICKS
