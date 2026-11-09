"""Service settings, read from `YAWMI_*` environment variables.

Secrets (`jwt_secret`, provider API keys) are `SecretStr` and `database_url` is `repr=False`,
so `repr`/`str` never reveal them.
No `.env` file is read: values come from the container environment or the secrets volume only.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YAWMI_", env_file=None)

    # The DSN may embed the role password, so it is kept out of repr/str like the other secrets.
    database_url: str = Field(repr=False)
    jwt_secret: SecretStr
    jwt_ttl_seconds: int = 900
    refresh_ttl_days: int = 90

    ai_provider: Literal["anthropic", "deepseek"] = "anthropic"
    anthropic_api_key: SecretStr | None = None
    deepseek_api_key: SecretStr | None = None
    model_daily: str = "claude-haiku-5-5"
    model_weekly: str = "claude-sonnet-5-5"
    send_raw_health: bool = False

    tz: str = "Asia/Riyadh"
    week_start: Literal["sat", "sun", "mon"] = "sun"

    log_bodies: bool = False
    cookie_secure: bool = True

    push_enabled: bool = False
    vapid_private_key_file: Path | None = None
    vapid_subject: str | None = None

    @field_validator("vapid_subject")
    @classmethod
    def _vapid_subject_is_mailto(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith("mailto:"):
            raise ValueError("vapid_subject must start with 'mailto:'")
        return value


@lru_cache
def settings() -> Settings:
    """Process-wide settings, built once on first use."""
    return Settings()  # type: ignore[call-arg]  # required fields come from the environment
