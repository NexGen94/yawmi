"""In-memory settings store for tests."""

from typing import Any

from yawmi.prefs.models import SettingsOut, SettingsPatch


class InMemoryPrefsStore:
    def __init__(self) -> None:
        self._values: dict[str, Any] = {}

    async def get(self) -> SettingsOut:
        data = SettingsOut().model_dump()
        data.update(self._values)
        return SettingsOut.model_validate(data)

    async def patch(self, changes: SettingsPatch | dict[str, Any]) -> SettingsOut:
        if isinstance(changes, dict):
            changes = SettingsPatch.model_validate(changes)
        patch_data = changes.model_dump(exclude_unset=True)
        for k, v in patch_data.items():
            self._values[k] = v
        return await self.get()
