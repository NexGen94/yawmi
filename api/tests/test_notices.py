"""Tests for the notices push provider: day reminders (morning, evening, weekly) and deduplication."""

import json
import os
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo

import asyncpg
import pytest

from yawmi.db.pool import create_pool, set_pool
from yawmi.journal.memory import InMemoryJournalReader
from yawmi.journal.store import AsyncpgJournalReader
from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.prefs.store import AsyncpgPrefsStore
from yawmi.push import notices as notices_module
from yawmi.push.memory_store import InMemoryPushStore
from yawmi.push.notices import Notice, NoticeContext
from yawmi.push.scheduler import tick
from yawmi.push.store import AsyncpgPushStore, Subscription

IN_CI = bool(os.environ.get("CI"))
DSN = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(
    not DSN and not IN_CI, reason="TEST_DATABASE_URL is not set (database tests run in CI)"
)
TZ = "Asia/Riyadh"
RIYADH = ZoneInfo(TZ)


class FakeSender:
    def __init__(self) -> None:
        self.sent: list[tuple[Subscription, dict[str, Any]]] = []

    async def send(self, sub: Subscription, payload: dict[str, Any], *, now: datetime) -> Any:
        self.sent.append((sub, payload))

        class _Res:
            outcome = "sent"
            status = 201
            retry_after = None

        return _Res()


class Backend(Protocol):
    store: Any
    prefs: Any
    journal: Any

    async def setup(self) -> None: ...
    async def cleanup(self) -> None: ...
    async def reopen(self) -> Any: ...
    async def plant(self, key: str, value: Any) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.store = InMemoryPushStore()
        self.prefs = InMemoryPrefsStore()
        self.journal = InMemoryJournalReader()

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        self.store = InMemoryPushStore()
        self.prefs = InMemoryPrefsStore()
        self.journal = InMemoryJournalReader()

    async def plant(self, key: str, value: Any) -> None:
        self.prefs._values[key] = value

    async def reopen(self) -> Any:
        # returns new store sharing the same notice_sends (simulating restart over same db)
        new_store = InMemoryPushStore()
        new_store.subs = self.store.subs
        new_store.notice_sends = self.store.notice_sends
        return new_store


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.store = AsyncpgPushStore(pool)
        self.prefs = AsyncpgPrefsStore(pool)
        self.journal = AsyncpgJournalReader(pool)

    async def setup(self) -> None:
        await self.cleanup()
        dev_id = uuid4()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            dev_id,
            "t10 notices device",
        )
        await self.pool.execute(
            "INSERT INTO yawmi.push_subscriptions (endpoint, device_id, p256dh, auth)"
            " VALUES ($1, $2, 'p256dh', 'auth') ON CONFLICT DO NOTHING",
            "https://push.example.com/sub1",
            dev_id,
        )

    async def cleanup(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.notice_sends")
        await self.pool.execute("DELETE FROM yawmi.journal_entries")
        await self.pool.execute("DELETE FROM yawmi.user_settings")
        await self.pool.execute("DELETE FROM yawmi.push_subscriptions")

    async def plant(self, key: str, value: Any) -> None:
        await self.pool.execute(
            "INSERT INTO yawmi.user_settings (key, value) VALUES ($1, $2::jsonb)"
            " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            key,
            json.dumps(value),
        )

    async def reopen(self) -> Any:
        return AsyncpgPushStore(self.pool)


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        b: Backend = MemoryBackend()
        sub = Subscription(
            endpoint="https://push.example.com/sub1", p256dh="key", auth="auth", device_id=uuid4()
        )
        b.store.subs[sub.endpoint] = sub
        await b.setup()
        yield b
        await b.cleanup()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not")
        pytest.skip("TEST_DATABASE_URL is not set (database tests run in CI)")
    pool = await create_pool(url)
    set_pool(pool)
    try:
        b = PostgresBackend(pool)
        await b.setup()
        yield b
        await b.cleanup()
    finally:
        set_pool(None)
        await pool.close()


@pytest.fixture
def sender() -> FakeSender:
    return FakeSender()


async def test_evening_reminder_notice(backend: Backend, sender: FakeSender) -> None:
    # Configure day_reminders.evening = 21:00
    await backend.prefs.patch(
        {
            "day_reminders": {
                "morning": None,
                "evening": {"time": "21:00", "days_mask": 127},
                "weekly": None,
            }
        }
    )

    # 21:05 Riyadh time (Tuesday 2026-11-10 21:05:00 UTC+3 = 18:05:00 UTC)
    now = datetime(2026, 11, 10, 18, 5, 0, tzinfo=UTC)

    # First tick sends once
    sent = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent == 1
    assert len(sender.sent) == 1
    _sub, payload = sender.sent[0]
    assert payload["notification"]["body"] == "يومية المساء"
    assert payload["notification"]["navigate"] == "/day/evening"

    # Second tick does not send again
    sent_again = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        now + timedelta(minutes=1),
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent_again == 0
    assert len(sender.sent) == 1

    # After a restart (reopened store over same DB/state): does not send
    reopened_store = await backend.reopen()
    sent_restart = await tick(
        reopened_store,
        sender,  # type: ignore[arg-type]
        now + timedelta(minutes=2),
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent_restart == 0
    assert len(sender.sent) == 1


async def test_evening_reminder_not_sent_when_journal_already_saved(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.prefs.patch(
        {
            "day_reminders": {
                "morning": None,
                "evening": {"time": "21:00", "days_mask": 127},
                "weekly": None,
            }
        }
    )

    now = datetime(2026, 11, 10, 18, 5, 0, tzinfo=UTC)
    day = date(2026, 11, 10)

    # Save evening journal entry
    if hasattr(backend.journal, "add_entry"):
        await backend.journal.add_entry(day, "evening", {"one_minute": "تم اليوم"})
    else:
        # PostgresBackend
        await backend.pool.execute(
            "INSERT INTO yawmi.journal_entries (day, part, answers, logged_at) VALUES ($1, 'evening', '{}', now())",
            day,
        )

    sent = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent == 0
    assert len(sender.sent) == 0


async def test_morning_and_weekly_reminders(backend: Backend, sender: FakeSender) -> None:
    # Configure morning and weekly
    await backend.prefs.patch(
        {
            "day_reminders": {
                "morning": {"time": "08:00", "days_mask": 127},
                "evening": None,
                "weekly": {"time": "18:00", "days_mask": 127},
            }
        }
    )

    # Morning tick at 08:05 Riyadh (05:05 UTC)
    morning_now = datetime(2026, 11, 10, 5, 5, 0, tzinfo=UTC)
    sent_morning = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        morning_now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent_morning == 1
    assert sender.sent[-1][1]["notification"]["body"] == "يومية الصباح"
    assert sender.sent[-1][1]["notification"]["navigate"] == "/day/morning"

    # Weekly tick at 18:05 Riyadh (15:05 UTC)
    weekly_now = datetime(2026, 11, 10, 15, 5, 0, tzinfo=UTC)
    sent_weekly = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        weekly_now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent_weekly == 1
    assert sender.sent[-1][1]["notification"]["body"] == "مراجعة الأسبوع"
    assert sender.sent[-1][1]["notification"]["navigate"] == "/review"


async def _tick(backend: Backend, sender: FakeSender, now: datetime) -> int:
    return await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )


def _riyadh(day: int, hour: int, minute: int) -> datetime:
    """A November 2026 instant given as Riyadh wall-clock time."""
    return datetime(2026, 11, day, hour, minute, tzinfo=RIYADH).astimezone(UTC)


async def test_an_evening_reminder_near_midnight_is_sent_once_for_its_day(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.prefs.patch({"day_reminders": {"evening": {"time": "23:55", "days_mask": 127}}})

    # 23:57 on the 10th and 00:02 on the 11th are the same reminder (the 10th's, window 10 min)
    assert await _tick(backend, sender, _riyadh(10, 23, 57)) == 1
    assert await _tick(backend, sender, _riyadh(11, 0, 2)) == 0
    assert len(sender.sent) == 1

    # the 11th's own 23:55 reminder is a new day, and goes out
    assert await _tick(backend, sender, _riyadh(11, 23, 57)) == 1
    assert len(sender.sent) == 2
    assert await _tick(backend, sender, _riyadh(12, 0, 3)) == 0


async def test_a_notice_is_claimed_by_its_own_day_not_by_the_tick_day(
    backend: Backend, sender: FakeSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def provider(ctx: NoticeContext, now: datetime) -> list[Notice]:
        assert now == _riyadh(11, 9, 0)  # the second argument is the tick's instant
        return [Notice("custom", "x", date(2026, 11, 10), "نص", "/")]

    monkeypatch.setattr(notices_module, "PROVIDERS", [provider])
    assert await _tick(backend, sender, _riyadh(11, 9, 0)) == 1
    assert await _tick(backend, sender, _riyadh(11, 9, 0)) == 0  # claimed for the 10th


async def test_a_failing_provider_does_not_stop_the_others(
    backend: Backend, sender: FakeSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(ctx: NoticeContext, now: datetime) -> list[Notice]:
        raise RuntimeError("boom")

    async def fine(ctx: NoticeContext, now: datetime) -> list[Notice]:
        return [Notice("custom", "y", date(2026, 11, 11), "نص", "/")]

    monkeypatch.setattr(notices_module, "PROVIDERS", [broken, fine])
    assert await _tick(backend, sender, _riyadh(11, 9, 0)) == 1


@pytest.mark.parametrize("bad", [None, "x", 5, {"evening": "21:00"}])
async def test_a_stored_bad_day_reminders_row_does_not_stop_the_tick(
    backend: Backend, sender: FakeSender, bad: Any
) -> None:
    await backend.plant("day_reminders", bad)
    await backend.plant("digits", None)
    assert await _tick(backend, sender, _riyadh(10, 21, 5)) == 0  # no reminder is set: no send
    await backend.prefs.patch({"day_reminders": {"evening": {"time": "21:00", "days_mask": 127}}})
    assert await _tick(backend, sender, _riyadh(10, 21, 5)) == 1
