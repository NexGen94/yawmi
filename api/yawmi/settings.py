"""Service settings, read from `YAWMI_*` environment variables.

Secrets (`jwt_secret`, provider API keys) are `SecretStr` and `database_url` is `repr=False`,
so `repr`/`str` never reveal them.
No `.env` file is read: values come from the container environment or the secrets volume only.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from yawmi.push.hosts import DEFAULT_PUSH_HOSTS, valid_push_host

MIN_JWT_SECRET_LENGTH = 32
_MALFORMED = "?"  # stands for a non-string entry of push_hosts; never a valid host


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YAWMI_", env_file=None)

    # The DSN may embed the role password, so it is kept out of repr/str like the other secrets.
    database_url: str = Field(repr=False)
    # HS256 signs every access token and the service token with it: refuse a short phrase.
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
    # Push services the server may contact (exact host or any subdomain). In the environment a
    # JSON list or a comma-separated list. Empty means the default list, and so does a list that
    # parses to nothing (`,`, `[]`): a stray comma must not drop every subscription.
    push_hosts: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: list(DEFAULT_PUSH_HOSTS)
    )

    @field_validator("vapid_private_key_file", "vapid_subject", mode="before")
    @classmethod
    def _empty_is_unset(cls, value: object) -> object:
        # compose passes `${YAWMI_VAPID_SUBJECT:-}` as an empty string until it is filled in
        return None if value == "" else value

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_secret_is_long_enough(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < MIN_JWT_SECRET_LENGTH:
            # the length rule only: the value itself is never echoed
            raise ValueError(f"jwt_secret must be at least {MIN_JWT_SECRET_LENGTH} characters")
        return value

    @field_validator("push_hosts", mode="before")
    @classmethod
    def _hosts_from_text(cls, value: object) -> object:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    value = json.loads(text)
                except ValueError:
                    return [text]  # kept as one malformed entry: refused below when push is on
            else:
                value = [part.strip() for part in text.split(",") if part.strip()]
        if isinstance(value, list | tuple):
            if not value:
                return list(DEFAULT_PUSH_HOSTS)
            # a non-string element is a malformed entry, like a malformed host name
            return [item if isinstance(item, str) else _MALFORMED for item in value]
        return value

    @model_validator(mode="after")
    def _push_hosts_are_host_names(self) -> Self:
        hosts = [h.strip().lower() for h in self.push_hosts]
        bad = [h for h in hosts if not valid_push_host(h)]
        if bad and self.push_enabled:
            # the count only: an entry is configuration, but nothing here echoes input
            raise ValueError(f"push_hosts has {len(bad)} malformed entr(y/ies)")
        # with push off a malformed entry must not stop the API; it is left out, never matched
        self.push_hosts = [h for h in hosts if valid_push_host(h)]
        return self

    @model_validator(mode="after")
    def _vapid_subject_is_mailto(self) -> Self:
        # Checked only when push is on: a mistyped subject must not stop an API that has push off.
        subject = self.vapid_subject
        if self.push_enabled and subject is not None and not subject.startswith("mailto:"):
            raise ValueError("vapid_subject must start with 'mailto:'")
        return self


@lru_cache
def settings() -> Settings:
    """Process-wide settings, built once on first use."""
    return Settings()  # type: ignore[call-arg]  # required fields come from the environment
