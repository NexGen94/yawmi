"""Tests for the notices push provider: day reminders (morning, evening, weekly) and deduplication."""

import json
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo

import asyncpg
import pytest
from api_harness import open_pool
from goals_harness import GoalsBackend, MemoryGoals, PostgresGoals, ensure_schema

from yawmi.journal.memory import InMemoryJournalReader
from yawmi.journal.store import AsyncpgJournalReader
from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.prefs.store import AsyncpgPrefsStore
from yawmi.push import notices as notices_module
from yawmi.push.memory_store import InMemoryPushStore
from yawmi.push.notices import Notice, NoticeContext, count_items_ar
from yawmi.push.scheduler import tick
from yawmi.push.store import AsyncpgPushStore, Subscription

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
    goals: GoalsBackend

    async def setup(self) -> None: ...
    async def cleanup(self) -> None: ...
    async def reopen(self) -> Any: ...
    async def drop_subscriptions(self) -> None: ...
    async def notice_rows(self) -> int: ...
    async def plant(self, key: str, value: Any) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.store = InMemoryPushStore()
        self.prefs = InMemoryPrefsStore()
        self.journal = InMemoryJournalReader()
        self.goals = MemoryGoals()

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        self.store = InMemoryPushStore()
        self.prefs = InMemoryPrefsStore()
        self.journal = InMemoryJournalReader()
        self.goals = MemoryGoals()

    async def plant(self, key: str, value: Any) -> None:
        self.prefs._values[key] = value

    async def drop_subscriptions(self) -> None:
        self.store.subs.clear()

    async def notice_rows(self) -> int:
        return len(self.store.notice_sends)

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
        self.goals = PostgresGoals(pool)

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
        await self.goals.cleanup()  # its own rows, and the habits it paused are put back
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

    async def drop_subscriptions(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.push_subscriptions")

    async def notice_rows(self) -> int:
        return int(await self.pool.fetchval("SELECT count(*) FROM yawmi.notice_sends"))


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
    async with open_pool() as pool:
        await ensure_schema(pool)
        b = PostgresBackend(pool)
        await b.setup()
        yield b
        await b.cleanup()


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
        goal_sources=backend.goals.sources(),
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


# --- the goal indicator reminder ---------------------------------------------------------------

DAY = date(2026, 11, 10)  # a Tuesday


async def goal_with_tasks(backend: Backend, ref: str = "O1", done: int = 2, total: int = 5) -> None:
    await backend.goals.outcome(ref, title="الصحة البدنية")
    for i in range(total):
        await backend.goals.task(ref, f"مهمة {i}", done=i < done)


async def remind(backend: Backend, ref: str = "O1", at: str = "20:00", **extra: Any) -> None:
    await backend.goals.put_indicator(
        subject_ref=ref, reminder={"time": at, "days_mask": 127}, **extra
    )


async def restarted_tick(backend: Backend, sender: FakeSender, now: datetime) -> int:
    """A tick of a restarted process: a new store over the same sends."""
    return await tick(
        await backend.reopen(),
        sender,  # type: ignore[arg-type]
        now,
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
        goal_sources=backend.goals.sources(),
    )


async def test_a_goal_indicator_reminder_is_sent_once_a_day(
    backend: Backend, sender: FakeSender
) -> None:
    await goal_with_tasks(backend)  # 2 of 5: completion 0.4
    await remind(backend, title_ar="هدف الصحة")

    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    notification = sender.sent[0][1]["notification"]
    assert notification["body"] == "هدف الصحة: 2 من 5"
    assert notification["navigate"] == "/goals/O1"

    assert await _tick(backend, sender, _riyadh(10, 20, 4)) == 0  # the same day
    assert await restarted_tick(backend, sender, _riyadh(10, 20, 5)) == 0
    assert await _tick(backend, sender, _riyadh(11, 20, 3)) == 1  # the next day goes out again
    assert len(sender.sent) == 2


async def test_without_a_title_the_goal_title_is_quoted(
    backend: Backend, sender: FakeSender
) -> None:
    await goal_with_tasks(backend)
    await remind(backend)
    await _tick(backend, sender, _riyadh(10, 20, 3))
    assert sender.sent[0][1]["notification"]["body"] == "الصحة البدنية: 2 من 5"


async def test_a_card_indicator_reminder_goes_to_the_card(
    backend: Backend, sender: FakeSender
) -> None:
    card = await backend.goals.card("c1", title="بطاقة الاختبار")
    await backend.goals.task(card, "أ", done=True)
    await backend.goals.task(card, "ب")
    await remind(backend, ref=card)
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    notification = sender.sent[0][1]["notification"]
    assert notification["body"] == "بطاقة الاختبار: 1 من 2"
    assert notification["navigate"] == f"/goals/{card}"


async def test_a_goal_indicator_without_a_mirror_row_is_measured_by_its_tasks(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.task("O2", "وحيدة")  # the mirror is empty: no outcome row
    await remind(backend, ref="O2")
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    assert sender.sent[0][1]["notification"]["body"] == "O2: 0 من 1"


async def test_a_finished_goal_is_not_reminded(backend: Backend, sender: FakeSender) -> None:
    await goal_with_tasks(backend, done=5, total=5)  # completion 1
    await remind(backend)
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0
    assert await backend.notice_rows() == 0


async def test_a_goal_with_nothing_to_measure_is_not_reminded(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.outcome("O1")  # no milestone, habit or task: completion is None
    await remind(backend)
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0


async def test_a_goal_reminder_respects_its_days_and_its_window(
    backend: Backend, sender: FakeSender
) -> None:
    await goal_with_tasks(backend)
    await backend.goals.put_indicator(
        subject_ref="O1",
        reminder={"time": "20:00", "days_mask": 1},  # Sundays only
    )
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0  # Tuesday
    assert await _tick(backend, sender, _riyadh(15, 20, 3)) == 1  # Sunday
    assert await _tick(backend, sender, _riyadh(15, 21, 30)) == 0  # outside the window


async def test_a_goal_reminder_near_midnight_is_sent_once_for_its_day(
    backend: Backend, sender: FakeSender
) -> None:
    await goal_with_tasks(backend)
    await remind(backend, at="23:55")
    assert await _tick(backend, sender, _riyadh(10, 23, 57)) == 1
    assert await _tick(backend, sender, _riyadh(11, 0, 2)) == 0
    assert await _tick(backend, sender, _riyadh(11, 23, 57)) == 1


async def test_a_goal_reminder_is_not_claimed_without_a_subscription(
    backend: Backend, sender: FakeSender
) -> None:
    await goal_with_tasks(backend)
    await remind(backend)
    await backend.drop_subscriptions()
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0
    assert await backend.notice_rows() == 0


async def test_a_habit_indicator_has_no_goal_reminder(backend: Backend, sender: FakeSender) -> None:
    await backend.goals.put_indicator(
        subject_kind="habit", subject_ref="reading", source="habit_logs"
    )
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0


# --- the daily late summary --------------------------------------------------------------------


async def three_late_items(backend: Backend) -> None:
    """An open milestone past its day and two habits that are late: three items."""
    await backend.goals.pause_other_habits()
    await backend.goals.outcome("O1")
    await backend.goals.milestone("blood", "O1", title="فحص الدم السنوي", due=date(2026, 11, 1))
    await backend.goals.habit("a", title="عادة أ")
    await backend.goals.habit("b", title="عادة ب")
    await backend.goals.habit("ok", title="عادة منجزة")
    await backend.goals.log("ok", date(2026, 11, 9), None)  # yesterday done: not late


async def test_the_late_summary_is_sent_once_a_day_at_the_set_time(
    backend: Backend, sender: FakeSender
) -> None:
    await three_late_items(backend)
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    notification = sender.sent[0][1]["notification"]
    assert notification["body"] == "متأخر اليوم: 3 بنود. أولها: فحص الدم السنوي."
    assert notification["navigate"] == "/"

    assert await _tick(backend, sender, _riyadh(10, 20, 4)) == 0
    assert await restarted_tick(backend, sender, _riyadh(10, 20, 6)) == 0
    assert len(sender.sent) == 1
    assert await _tick(backend, sender, _riyadh(11, 20, 3)) == 1  # tomorrow is another day


async def test_the_late_summary_names_the_first_late_habit_when_no_milestone_is_late(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.habit("b", title="عادة ب")
    await backend.goals.habit("a", title="عادة أ")
    await backend.goals.outcome("O1")
    await backend.goals.milestone("future", "O1", due=date(2026, 12, 1))  # not late
    await backend.goals.milestone("done", "O1", due=date(2026, 11, 1), done=True)  # not open
    await backend.goals.milestone("today", "O1", due=DAY)  # due today is not late yet
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    body = sender.sent[0][1]["notification"]["body"]
    assert body == "متأخر اليوم: بندان. أولها: عادة أ."  # by code: a before b


async def test_the_oldest_overdue_milestone_comes_first(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.outcome("O1")
    await backend.goals.milestone("new", "O1", title="أحدث", due=date(2026, 11, 8))
    await backend.goals.milestone("old", "O1", title="أقدم", due=date(2026, 11, 2))
    await _tick(backend, sender, _riyadh(10, 20, 3))
    assert sender.sent[0][1]["notification"]["body"] == "متأخر اليوم: بندان. أولها: أقدم."


async def test_a_week_habit_below_its_pace_counts_as_late(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.habit("w", title="المشي", period="week", target=5, kind="count")
    # Tuesday of a week that began on Sunday the 8th: nothing logged, behind the pace
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 1
    assert sender.sent[0][1]["notification"]["body"] == "متأخر اليوم: بند واحد. أولها: المشي."


async def test_nothing_late_is_not_sent(backend: Backend, sender: FakeSender) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.habit("ok", title="منجزة")
    await backend.goals.log("ok", date(2026, 11, 9), None)
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0
    assert await backend.notice_rows() == 0


async def test_the_late_summary_can_be_switched_off(backend: Backend, sender: FakeSender) -> None:
    await three_late_items(backend)
    await backend.prefs.patch({"late_notice_enabled": False})
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0
    assert await backend.notice_rows() == 0


async def test_the_late_summary_goes_out_at_the_time_from_the_settings(
    backend: Backend, sender: FakeSender
) -> None:
    await three_late_items(backend)
    await backend.prefs.patch({"late_notice_time": "07:30"})
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0  # the default time is not used
    assert await _tick(backend, sender, _riyadh(10, 7, 32)) == 1


async def test_the_late_summary_is_not_claimed_without_a_subscription(
    backend: Backend, sender: FakeSender
) -> None:
    await three_late_items(backend)
    await backend.drop_subscriptions()
    assert await _tick(backend, sender, _riyadh(10, 20, 3)) == 0
    assert await backend.notice_rows() == 0


async def test_without_goal_sources_the_new_providers_say_nothing(
    backend: Backend, sender: FakeSender
) -> None:
    await three_late_items(backend)
    sent = await tick(
        backend.store,
        sender,  # type: ignore[arg-type]
        _riyadh(10, 20, 3),
        tz=TZ,
        week_start="sun",
        prefs=backend.prefs,
        journal=backend.journal,
    )
    assert sent == 0


@pytest.mark.parametrize(
    ("n", "text"),
    [
        (1, "بند واحد"),
        (2, "بندان"),
        (3, "3 بنود"),
        (10, "10 بنود"),
        (11, "11 بنداً"),
        (12, "12 بنداً"),
        (100, "100 بنداً"),
    ],
)
def test_count_items_in_arabic(n: int, text: str) -> None:
    assert count_items_ar(n) == text


async def test_a_goal_reminder_claimed_for_a_day_is_valued_for_that_day(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.outcome("O1", title="الصحة البدنية")
    await backend.goals.habit("walk", outcome="O1", title="المشي")
    await backend.goals.log("walk", DAY, None)  # the 10th: done, so the goal's habits are complete
    await remind(backend, at="23:55", source="linked_habits")
    # 00:02 on the 11th belongs to the 10th's reminder: valued for the 10th (complete: no send),
    # not for the 11th (nothing logged yet: it would be sent as 0 of 100)
    assert await _tick(backend, sender, _riyadh(11, 0, 2)) == 0
    assert await backend.notice_rows() == 0


async def test_a_goal_reminder_after_midnight_quotes_the_value_of_its_own_day(
    backend: Backend, sender: FakeSender
) -> None:
    await backend.goals.pause_other_habits()
    await backend.goals.outcome("O1", title="الصحة البدنية")
    await backend.goals.habit("walk", outcome="O1", title="المشي")
    await backend.goals.log("walk", date(2026, 11, 11), None)  # done on the 11th only
    await remind(backend, at="23:55", source="linked_habits")
    assert await _tick(backend, sender, _riyadh(11, 0, 2)) == 1  # the 10th: 0 of 100
    assert sender.sent[0][1]["notification"]["body"] == "الصحة البدنية: 0 من 100"
