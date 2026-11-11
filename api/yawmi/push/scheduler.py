"""Habit reminders: one idempotent `tick` a minute, and the loop that runs it.

A reminder is due at `now` when, in the plan's zone (`settings.tz`, Asia/Riyadh):

* it is active, `now` lies in `[at_time, at_time + 10 min]` of a local day, and that day's bit is
  set in its `weekday_mask` (bit 0 = Sunday ... bit 6 = Saturday);
* its habit is active on that day and scheduled on it (`is_scheduled`);
* the habit's current period is not reached yet (`period_progress(...).reached` is false), with
  the week start passed explicitly (`settings.week_start`);
* that day is not marked `skip` or `vacation` for the habit (owner's ruling: no nagging on a day
  set aside). Such a habit is not counted in the badge either;
* a yes/no (`boolean`) habit of any period has no `done` log on that day: «لا يُرسل إن تحقق هدف
  اليوم». A weekly yes/no habit done this morning is not reminded tonight, though its week is
  still open; it leaves the badge too. Count and duration habits keep the period rule.

For a due reminder with at least one subscription that is not backing off, the tick inserts
`(reminder_id, day)` into `reminder_sends ... ON CONFLICT DO NOTHING`, and sends only if that row
was new: two ticks, a restart or a second process can never send the same reminder twice in a
day. With no deliverable subscription nothing is claimed, so the reminder can still go out later
in its window. A subscription whose endpoint is no longer an allowed push host is dropped and
never contacted. A failure on one subscription (send or bookkeeping) never stops the others, a
habit row that breaks the rules engine is skipped alone, and the loop logs a failed tick
(exception class only, never a payload or an endpoint) and carries on.
"""

import asyncio
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from yawmi.domain.days import is_valid_tz
from yawmi.domain.habits import HabitLog, HabitSpec, period_progress
from yawmi.domain.periods import WeekStart, is_scheduled, period_bounds, weekday_bit
from yawmi.push.sender import WebPushSender, default_check
from yawmi.push.store import AsyncpgPushStore, PushStore, Reminder, Subscription
from yawmi.today.assemble import habit_spec
from yawmi.today.reader import LogRow

log = logging.getLogger("yawmi.push")

WINDOW = timedelta(minutes=10)
INTERVAL_SECONDS = 60.0
TITLE = "يومي"
NAVIGATE = "/"
_ONE_DAY = timedelta(days=1)
_SET_ASIDE = frozenset({"skip", "vacation"})


def build_payload(body: str, badge: int) -> dict[str, Any]:
    """The declarative push message for one reminder (Arabic, right to left)."""
    return {
        "web_push": 8030,
        "notification": {
            "title": TITLE,
            "body": body,
            "navigate": NAVIGATE,
            "app_badge": badge,
            "lang": "ar",
            "dir": "rtl",
        },
    }


def _due_days(reminder: Reminder, local: datetime) -> list[date]:
    """The local days whose occurrence of `reminder` has its window around `local`."""
    zone = local.tzinfo
    days = []
    for day in (local.date(), local.date() - _ONE_DAY):  # 23:55 is still due at 00:03
        start = datetime.combine(day, reminder.at_time, zone)
        if start <= local <= start + WINDOW and reminder.weekday_mask >> weekday_bit(day) & 1:
            days.append(day)
    return days


def _host(endpoint: str) -> str:
    """The push service's host, the only part of an endpoint that may be logged."""
    try:
        return urlsplit(endpoint).hostname or "?"
    except ValueError:
        return "?"


def _logs_by_code(rows: list[LogRow]) -> dict[str, list[HabitLog]]:
    logs: dict[str, list[HabitLog]] = defaultdict(list)
    for row in rows:
        if row.status is None:
            continue  # no such row is ever written (events always carry a status)
        value = None if row.value is None else float(row.value)
        logs[row.habit_code].append(HabitLog(row.day, value, row.status))  # type: ignore[arg-type]
    return logs


async def _open_habits(
    store: PushStore, day: date, week_start: WeekStart
) -> tuple[dict[str, str], int]:
    """Titles of the habits due on `day`, not set aside that day and not reached yet; their count.

    A habit whose row the rules refuse (a bad schedule, say) is logged by code and left out; the
    others are still reminded.
    """
    rows = {h.code: h for h in await store.active_habits(day)}
    specs: dict[str, HabitSpec] = {}
    for code, row in rows.items():
        try:
            spec = habit_spec(row)
            if is_scheduled(day, spec):
                specs[code] = spec
        except Exception as exc:  # noqa: BLE001  # one bad habit row must not stop the others
            log.warning("habit %s skipped: %s", code, type(exc).__name__)
    if not specs:
        return {}, 0
    first = min(period_bounds(day, spec.period, week_start)[0] for spec in specs.values())
    rows_logs = await store.habit_logs(first, day)
    set_aside = {r.habit_code for r in rows_logs if r.day == day and r.status in _SET_ASIDE}
    done_today = {r.habit_code for r in rows_logs if r.day == day and r.status == "done"}
    logs = _logs_by_code(rows_logs)
    open_: dict[str, str] = {}
    for code, spec in specs.items():
        if code in set_aside:
            continue
        if spec.kind == "boolean" and code in done_today:
            continue  # a yes/no habit is done for the day once it is done
        try:
            reached = period_progress(spec, logs.get(code, []), day, week_start).reached
        except Exception as exc:  # noqa: BLE001  # same: isolate the habit
            log.warning("habit %s skipped: %s", code, type(exc).__name__)
            continue
        if not reached:
            open_[code] = rows[code].title_ar
    return open_, len(open_)


async def _deliver(
    store: PushStore,
    sender: WebPushSender,
    sub: Subscription,
    payload: dict[str, Any],
    now: datetime,
) -> bool:
    host = _host(sub.endpoint)
    # send and bookkeeping alike: one bad subscription (or one failed write) must not stop the rest
    try:
        result = await sender.send(sub, payload, now=now)
        if result.outcome == "sent":
            await store.mark_ok(sub.endpoint, now)
            return True
        if result.outcome == "refused":
            await store.drop(sub.endpoint)
            log.warning("push subscription dropped: host not allowed host=%s", host)
        elif result.outcome == "gone":
            await store.drop(sub.endpoint)
            log.info("push subscription gone (%s) host=%s", result.status, host)
        elif result.outcome == "retry" and result.retry_after is not None:
            await store.set_retry_after(sub.endpoint, result.retry_after)
            log.info("push service busy (%s) host=%s", result.status, host)
        else:
            log.warning("push send failed (%s) host=%s", result.status, host)
    except Exception as exc:  # noqa: BLE001
        log.warning("push send error %s host=%s", type(exc).__name__, host)
    return False


async def tick(
    store: PushStore,
    sender: WebPushSender,
    now: datetime,
    *,
    tz: str,
    week_start: WeekStart,
) -> int:
    """Send the reminders due at `now`; returns how many messages the push services accepted."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    due = await _due_by_day(store, now.astimezone(ZoneInfo(tz)))
    sent = 0
    for day in sorted(due):
        open_, badge = await _open_habits(store, day, week_start)
        for reminder in due[day]:
            title = open_.get(reminder.habit_code)
            if title is not None:
                sent += await _remind(
                    store, sender, reminder, day, build_payload(title, badge), now
                )
    return sent


async def _due_by_day(store: PushStore, local: datetime) -> dict[date, list[Reminder]]:
    """Active reminders whose window holds `local`, by the local day they belong to."""
    due: dict[date, list[Reminder]] = defaultdict(list)
    for reminder in await store.active_reminders():
        for day in _due_days(reminder, local):
            due[day].append(reminder)
    return due


async def _remind(
    store: PushStore,
    sender: WebPushSender,
    reminder: Reminder,
    day: date,
    payload: dict[str, Any],
    now: datetime,
) -> int:
    """Claim `(reminder, day)` and send it to every deliverable subscription; how many accepted.

    Nothing is claimed when no subscription is deliverable (none, or all backing off).
    """
    targets = [
        s for s in await store.subscriptions() if s.retry_after is None or s.retry_after <= now
    ]
    if not targets or not await store.claim_send(reminder.id, day):
        return 0
    sent = 0
    for sub in targets:
        sent += await _deliver(store, sender, sub, payload, now)
    return sent


class ReminderLoop:
    """Runs `tick_once(now)` every `interval` seconds until stopped; a failing tick is logged."""

    def __init__(
        self,
        tick_once: Callable[[datetime], Awaitable[int]],
        *,
        interval: float = INTERVAL_SECONDS,
        on_stop: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._tick = tick_once
        self._interval = interval
        self._on_stop = on_stop
        self.task: asyncio.Task[None] | None = None

    async def _run(self) -> None:
        while True:
            try:
                await self._tick(datetime.now(UTC))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001  # the loop outlives a bad tick
                log.warning("reminder tick failed: %s", type(exc).__name__)
            await asyncio.sleep(self._interval)

    def start(self) -> None:
        self.task = asyncio.create_task(self._run(), name="yawmi-reminders")

    async def stop(self) -> None:
        """Cancel the loop and wait until it has really ended, then run `on_stop`.

        `asyncio.wait` waits for the task without raising its (expected) cancellation, so nothing
        is caught and swallowed here: if the caller of `stop()` is itself cancelled, that
        `CancelledError` propagates as it should, and `on_stop` (closing the HTTP session) still
        runs, in the `finally`.
        """
        try:
            if self.task is not None and not self.task.done():
                self.task.cancel()
                await asyncio.wait([self.task])
        finally:
            if self._on_stop is not None:
                await self._on_stop()


def start_reminders(pool: Any, config: Any) -> ReminderLoop:
    """The production loop: Postgres store over the app's pool, sender from the VAPID settings.

    Raises `RuntimeError` (naming the setting, never the key) when push cannot be configured.
    """
    from yawmi.push.vapid import VapidKeyError, load_private_key

    if config.vapid_private_key_file is None or not config.vapid_subject:
        raise RuntimeError(
            "push_enabled needs YAWMI_VAPID_PRIVATE_KEY_FILE and YAWMI_VAPID_SUBJECT"
        )
    if not is_valid_tz(config.tz):
        raise RuntimeError("push_enabled, but YAWMI_TZ is not a known time zone")
    try:
        key = load_private_key(config.vapid_private_key_file)
    except VapidKeyError as exc:
        raise RuntimeError(f"push_enabled, but {exc}") from None
    sender = WebPushSender(key, config.vapid_subject, check=default_check(config.push_hosts))

    async def tick_once(now: datetime) -> int:
        # the module-level `tick` is looked up on every call, so tests can patch it
        return await tick(
            AsyncpgPushStore(pool), sender, now, tz=config.tz, week_start=config.week_start
        )

    loop = ReminderLoop(tick_once, on_stop=sender.close)
    loop.start()
    return loop
