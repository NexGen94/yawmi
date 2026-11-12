"""In-memory indicator store for tests."""

from datetime import UTC, datetime
from uuid import uuid4

from yawmi.indicators.models import IndicatorIO


class InMemoryIndicatorStore:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], IndicatorIO] = {}

    async def list(self) -> list[IndicatorIO]:
        return [*self.items.values()]

    async def put(self, item: IndicatorIO) -> IndicatorIO:
        key = (item.subject_kind, item.subject_ref)
        existing = self.items.get(key)
        saved = item.model_copy(
            update={"id": existing.id if existing else uuid4(), "updated_at": datetime.now(UTC)}
        )
        self.items[key] = saved
        return saved

    async def delete(self, subject_kind: str, subject_ref: str) -> bool:
        return self.items.pop((subject_kind, subject_ref), None) is not None
