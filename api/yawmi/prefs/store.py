"""Settings store protocol and Postgres implementation."""

import json
from typing import Any, Protocol

import asyncpg

from yawmi.prefs.models import SettingsOut, SettingsPatch

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
    async def patch(self, changes: SettingsPatch | dict[str, Any]) -> SettingsOut: ...


class AsyncpgPrefsStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self) -> SettingsOut:
        rows = await self._pool.fetch(SELECT_SETTINGS)
        data = SettingsOut().model_dump()
        for r in rows:
            val = json.loads(r["value"]) if isinstance(r["value"], str) else r["value"]
            data[r["key"]] = val
        return SettingsOut.model_validate(data)

    async def patch(self, changes: SettingsPatch | dict[str, Any]) -> SettingsOut:
        if isinstance(changes, dict):
            changes = SettingsPatch.model_validate(changes)
        patch_data = changes.model_dump(exclude_unset=True, mode="json")
        for k, v in patch_data.items():
            await self._pool.execute(UPSERT_SETTING, k, json.dumps(v))
        return await self.get()
