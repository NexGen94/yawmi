"""In-memory indicator store for tests."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from yawmi.indicators.models import IndicatorIn, IndicatorIO


class InMemoryIndicatorStore:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], IndicatorIO] = {}

    async def list_all(self) -> list[IndicatorIO]:
        return list(self.items.values())

    async def get(self, subject_kind: str, subject_ref: str) -> IndicatorIO | None:
        return self.items.get((subject_kind, subject_ref))

    async def put(self, item: IndicatorIn, *, id: UUID | None = None) -> IndicatorIO:
        key = (item.subject_kind, item.subject_ref)
        existing = self.items.get(key)
        ind_id = existing.id if existing else (id or uuid4())
        saved = IndicatorIO(
            id=ind_id,
            subject_kind=item.subject_kind,
            subject_ref=item.subject_ref,
            title_ar=item.title_ar,
            source=item.source,
            measure=item.measure,
            target=item.target,
            period=item.period,
            display=item.display,
            reminder=item.reminder,
            updated_at=datetime.now(UTC),
        )
        self.items[key] = saved
        return saved

    async def delete(self, subject_kind: str, subject_ref: str) -> bool:
        key = (subject_kind, subject_ref)
        if key in self.items:
            del self.items[key]
            return True
        return False
