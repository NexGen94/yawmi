"""In-memory settings store for tests."""

from typing import Any

from yawmi.prefs.models import SettingsOut, settings_from_stored, validated_changes


class InMemoryPrefsStore:
    def __init__(self) -> None:
        self._values: dict[str, Any] = {}

    async def get(self) -> SettingsOut:
        return settings_from_stored(self._values)

    async def patch(self, changes: dict[str, Any]) -> SettingsOut:
        self._values.update(validated_changes(changes))
        return await self.get()
