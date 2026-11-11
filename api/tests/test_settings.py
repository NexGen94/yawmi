"""Settings and DB pool unit tests: no network, no real database."""

import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr, ValidationError

from yawmi import settings as settings_module
from yawmi.db import pool as pool_module
from yawmi.settings import Settings

FAKE_DSN = "postgresql://yawmi_api@localhost:5432/raqib"
FAKE_JWT = "test-secret"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop any YAWMI_* variables inherited from the shell so tests are hermetic."""
    for key in list(os.environ):
        if key.startswith("YAWMI_"):
            monkeypatch.delenv(key, raising=False)


@pytest.fixture
def required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YAWMI_DATABASE_URL", FAKE_DSN)
    monkeypatch.setenv("YAWMI_JWT_SECRET", FAKE_JWT)


def test_defaults(required_env: None) -> None:
    s = Settings()
    assert s.database_url == FAKE_DSN
    assert isinstance(s.jwt_secret, SecretStr)
    assert s.jwt_secret.get_secret_value() == FAKE_JWT
    assert s.jwt_ttl_seconds == 900
    assert s.ai_provider == "anthropic"
    assert s.anthropic_api_key is None
    assert s.deepseek_api_key is None
    assert s.model_daily == "claude-haiku-5-5"
    assert s.model_weekly == "claude-sonnet-5-5"
    assert s.send_raw_health is False
    assert s.tz == "Asia/Riyadh"
    assert s.week_start == "sun"
    assert s.log_bodies is False
    assert s.cookie_secure is True
    assert s.push_enabled is False
    assert s.vapid_private_key_file is None
    assert s.vapid_subject is None
    assert s.refresh_ttl_days == 90


def test_database_url_and_jwt_secret_are_required() -> None:
    with pytest.raises(ValidationError) as exc:
        Settings()
    missing = {err["loc"][0] for err in exc.value.errors() if err["type"] == "missing"}
    assert missing == {"database_url", "jwt_secret"}


def test_env_overrides(required_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YAWMI_AI_PROVIDER", "deepseek")
    monkeypatch.setenv("YAWMI_WEEK_START", "sat")
    monkeypatch.setenv("YAWMI_COOKIE_SECURE", "false")
    monkeypatch.setenv("YAWMI_PUSH_ENABLED", "true")
    monkeypatch.setenv("YAWMI_VAPID_PRIVATE_KEY_FILE", "/run/secrets/yawmi/vapid.pem")
    monkeypatch.setenv("YAWMI_VAPID_SUBJECT", "mailto:owner@example.com")
    monkeypatch.setenv("YAWMI_REFRESH_TTL_DAYS", "30")
    s = Settings()
    assert s.ai_provider == "deepseek"
    assert s.week_start == "sat"
    assert s.cookie_secure is False
    assert s.push_enabled is True
    assert s.vapid_private_key_file == Path("/run/secrets/yawmi/vapid.pem")
    assert s.vapid_subject == "mailto:owner@example.com"
    assert s.refresh_ttl_days == 30


def test_repr_and_str_do_not_leak_secrets(
    required_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("YAWMI_ANTHROPIC_API_KEY", "fake-anthropic-key")
    monkeypatch.setenv("YAWMI_DEEPSEEK_API_KEY", "fake-deepseek-key")
    s = Settings()
    for text in (repr(s), str(s)):
        assert FAKE_JWT not in text
        assert "fake-anthropic-key" not in text
        assert "fake-deepseek-key" not in text
    assert s.anthropic_api_key is not None
    assert s.anthropic_api_key.get_secret_value() == "fake-anthropic-key"


def test_repr_does_not_leak_database_password(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_password = "fake-db-password"
    dsn = "postgresql://yawmi_api:" + fake_password + "@localhost:5432/raqib"
    monkeypatch.setenv("YAWMI_DATABASE_URL", dsn)
    monkeypatch.setenv("YAWMI_JWT_SECRET", FAKE_JWT)
    s = Settings()
    assert s.database_url == dsn
    for text in (repr(s), str(s)):
        assert fake_password not in text


def test_vapid_subject_must_be_mailto(required_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YAWMI_PUSH_ENABLED", "true")
    monkeypatch.setenv("YAWMI_VAPID_SUBJECT", "https://x")
    with pytest.raises(ValidationError, match="mailto:"):
        Settings()


def test_a_mistyped_vapid_subject_does_not_stop_an_api_with_push_off(
    required_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("YAWMI_VAPID_SUBJECT", "https://x")
    assert Settings().push_enabled is False


def test_vapid_subject_mailto_is_accepted(
    required_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("YAWMI_VAPID_SUBJECT", "mailto:owner@example.com")
    assert Settings().vapid_subject == "mailto:owner@example.com"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("YAWMI_AI_PROVIDER", "openai"),
        ("YAWMI_WEEK_START", "fri"),
    ],
)
def test_literal_fields_reject_unknown_values(
    required_env: None, monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_accessor_is_cached(required_env: None) -> None:
    settings_module.settings.cache_clear()
    first = settings_module.settings()
    assert isinstance(first, Settings)
    assert settings_module.settings() is first
    settings_module.settings.cache_clear()


def test_get_pool_unset_raises_runtime_error() -> None:
    pool_module.set_pool(None)
    with pytest.raises(RuntimeError, match="pool"):
        pool_module.get_pool()


def test_set_pool_then_get_pool_returns_same_object() -> None:
    sentinel = object()
    try:
        pool_module.set_pool(sentinel)  # type: ignore[arg-type]
        assert pool_module.get_pool() is sentinel
    finally:
        pool_module.set_pool(None)


async def test_create_pool_sets_search_path_and_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_pool = object()
    fake_create = AsyncMock(return_value=fake_pool)
    monkeypatch.setattr(pool_module.asyncpg, "create_pool", fake_create)

    result = await pool_module.create_pool(FAKE_DSN, min_size=2, max_size=7)

    assert result is fake_pool
    fake_create.assert_awaited_once()
    args, kwargs = fake_create.await_args
    assert args == (FAKE_DSN,)
    assert kwargs["min_size"] == 2
    assert kwargs["max_size"] == 7
    assert kwargs["server_settings"] == {"search_path": "yawmi", "timezone": "UTC"}


async def test_create_pool_default_sizes(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_create = AsyncMock(return_value=object())
    monkeypatch.setattr(pool_module.asyncpg, "create_pool", fake_create)
    await pool_module.create_pool(FAKE_DSN)
    _, kwargs = fake_create.await_args
    assert (kwargs["min_size"], kwargs["max_size"]) == (1, 4)


def test_default_pool_leaves_a_connection_for_the_cli_and_the_loader() -> None:
    """The role's CONNECTION LIMIT (0002) must exceed the API pool, or `yawmi-admin` and a
    re-run of loader 2 meet `TooManyConnectionsError` while the API is busy (I-4)."""
    import inspect
    import re

    role_sql = (
        Path(__file__).resolve().parents[1] / "db" / "migrations" / "0002_yawmi_role.sql"
    ).read_text(encoding="utf-8")
    limits = {int(n) for n in re.findall(r"CONNECTION LIMIT (\d+)", role_sql)}
    assert len(limits) == 1
    default = inspect.signature(pool_module.create_pool).parameters["max_size"].default
    assert default == 4
    assert default < limits.pop()
