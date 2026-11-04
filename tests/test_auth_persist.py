"""Contract: mock auth persists via localStorage with round-trip proof (no silent fail)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PICKS = (ROOT / "picks.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")


def test_auth_save_verifies_readback():
    assert "back !== raw" in PICKS
    assert 'auth.err.persist' in PICKS
    assert "Could not save on this device" in PICKS
    assert "呢部機存唔到" in PICKS


def test_register_login_require_persist():
    assert "if (!authSave(_auth))" in PICKS
    assert "if (authUser() !== u) return { ok: false, err: tr(\"auth.err.persist\") }" in PICKS
    assert 'AUTH_KEY = "mce:auth:v1"' in PICKS


def test_auth_form_not_method_dialog():
    assert 'id="authForm"' in HTML
    assert "method=\"dialog\" id=\"authForm\"" not in HTML
    assert 'method="post" action="#" id="authForm"' in HTML
