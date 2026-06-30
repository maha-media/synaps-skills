"""Global test guardrails.

Phase 2.3: the reflection loop spawns a real detached subprocess via
Popen by default. In CI/tests we never want that — every test that wants
to verify reflection mechanics either injects a fake `spawn_reflection`
into LoopDeps or sets XCAL_REFLECT=1 explicitly. So default it OFF here.
"""
import os
import pytest


@pytest.fixture(autouse=True)
def _no_reflect_spawn(monkeypatch, tmp_path_factory):
    monkeypatch.setenv("XCAL_REFLECT", "0")
    # Isolate auth: never read the real ~/.synaps-cli/auth.json in tests.
    # Point at a guaranteed-nonexistent path; tests that need OAuth set it.
    fake = tmp_path_factory.mktemp("noauth") / "auth.json"
    monkeypatch.setenv("XCAL_AUTH_JSON", str(fake))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # Isolate shadow journal: never write to real ~/.config/xcal during tests.
    fake_journal = tmp_path_factory.mktemp("shadow") / "verdicts.jsonl"
    monkeypatch.setenv("XCAL_JOURNAL", str(fake_journal))
    yield
