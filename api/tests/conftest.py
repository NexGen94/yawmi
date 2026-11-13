"""Shared fixtures."""

from datetime import UTC, datetime

import pytest
from ai_harness import ai, ai_client  # noqa: F401  (the fixtures of the AI tests)
from goals_harness import goals_backend  # noqa: F401  (the fixture of the goals tests)

# The server's "now" for event validation. Fixed so that tests which date events in November
# 2026 do not depend on the day they run; a test that needs another "now" patches it again.
SERVER_NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def server_now(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """Pin `yawmi.events.models.server_now` (the clock behind the 24 h future limit)."""
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: SERVER_NOW)
    return SERVER_NOW
