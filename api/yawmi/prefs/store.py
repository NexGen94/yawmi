"""Settings store protocol and Postgres implementation."""

import json
from typing import Any, Protocol

import asyncpg

from yawmi.prefs.models import SettingsOut, settings_from_stored, validated_changes

SELECT_SETTINGS = "SELECT key, value FROM yawmi.user_settings"
UPSERT_SETTING = """
INSERT INTO yawmi.user_settings (key, value, updated_at)
VALUES ($1, $2::jsonb, now())
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    updated_at = now()
"""


class PrefsStore(Protocol):
    async def get(self) -> SettingsOut: ...
    async def patch(self, changes: dict[str, Any]) -> SettingsOut: ...


class AsyncpgPrefsStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self) -> SettingsOut:
        rows = await self._pool.fetch(SELECT_SETTINGS)
        stored = {
            r["key"]: json.loads(r["value"]) if isinstance(r["value"], str) else r["value"]
            for r in rows
        }
        return settings_from_stored(stored)

    async def patch(self, changes: dict[str, Any]) -> SettingsOut:
        for key, value in validated_changes(changes).items():
            await self._pool.execute(UPSERT_SETTING, key, json.dumps(value))
        return await self.get()
