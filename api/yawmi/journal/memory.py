"""In-memory `JournalReader` for tests without Postgres."""

from datetime import UTC, date, datetime
from typing import Any

from yawmi.events.memory_store import InMemoryEventStore
from yawmi.journal.store import JournalRow, MoodRow


class InMemoryJournalReader:
    def __init__(
        self,
        *,
        events: InMemoryEventStore | None = None,
        entries: list[JournalRow] | None = None,
        moods: list[MoodRow] | None = None,
    ) -> None:
        self.events = events
        self.entry_rows: list[JournalRow] = list(entries or [])
        self.mood_rows: list[MoodRow] = list(moods or [])

    async def add_entry(self, day: date, part: str, answers: dict[str, Any] | None = None) -> None:
        self.entry_rows.append(
            JournalRow(
                day=day,
                part=part,  # type: ignore[arg-type]
                answers=answers or {},
                logged_at=datetime.now(UTC),
            )
        )

    async def entries(self, first: date, last: date) -> list[JournalRow]:
        by_key: dict[tuple[date, str], JournalRow] = {
            (r.day, r.part): r for r in self.entry_rows if first <= r.day <= last
        }
        if self.events is not None:
            for (day, part), item in self.events.journal_entries.items():
                if first <= day <= last:
                    by_key[(day, part)] = JournalRow(
                        day=item.day,
                        part=item.part,
                        answers=dict(item.answers),
                        logged_at=item.logged_at,
                    )
        return [by_key[k] for k in sorted(by_key)]

    async def moods(self, first: date, last: date) -> list[MoodRow]:
        by_day: dict[date, MoodRow] = {r.day: r for r in self.mood_rows if first <= r.day <= last}
        if self.events is not None:
            for day, item in self.events.mood_logs.items():
                if first <= day <= last:
                    by_day[day] = MoodRow(
                        day=item.day,
                        score=int(item.score),
                        feelings=list(item.feelings),
                        activities=list(item.activities),
                    )
        return [by_day[d] for d in sorted(by_day)]
