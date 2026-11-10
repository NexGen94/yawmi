"""Web Push: VAPID keys, the sender, the reminder scheduler and the `/v1/push` routes.

No real push service is ever contacted. The sender's HTTP call (pywebpush's async path, which
uses aiohttp, so respx cannot see it) goes to a local aiohttp server on 127.0.0.1 that plays the
push service: it records each request, decrypts its body with the subscription's throwaway keys
and answers with the status the test chose. Every key here is generated inside the test.

Store-backed tests run twice through the `backend` fixture: in memory (always) and against
Postgres (when `TEST_DATABASE_URL` is set; under CI they fail rather than skip without it).
`TEST_DATABASE_URL` must point at a throwaway database: the fixture deletes the rows it seeds.
"""

import asyncio
import base64
import json
import logging
import os
import secrets
import subprocess
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import http_ece
import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from httpx import ASGITransport
from multidict import CIMultiDict
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.main import create_app
from yawmi.push import keygen
from yawmi.push.memory_store import InMemoryPushStore
from yawmi.push.scheduler import ReminderLoop, build_payload, tick
from yawmi.push.sender import (
    MAX_PAYLOAD_BYTES,
    PayloadTooLarge,
    WebPushSender,
    encode_payload,
)
from yawmi.push.store import AsyncpgPushStore, PushStore, Reminder, Subscription
from yawmi.push.vapid import VapidKeyError, load_private_key, public_key_b64url
from yawmi.settings import Settings
from yawmi.today.reader import HabitRow, LogRow

SECRET = "test-secret-" + "x" * 32
SUBJECT = "mailto:push-test@example.com"
TZ = "Asia/Riyadh"
DAY = date(2026, 11, 10)  # a Tuesday
RIYADH = timedelta(hours=3)


def at(hour: int, minute: int, day: date = DAY) -> datetime:
    """The UTC instant of `hour:minute` Riyadh time on `day`."""
    return datetime.combine(day, time(hour, minute), UTC) - RIYADH


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# --- a fake push service ------------------------------------------------------------------------


@dataclass
class Receiver:
    """A browser's subscription keys (throwaway), as the push service's client would hold them."""

    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )
    auth: bytes = field(default_factory=lambda: secrets.token_bytes(16))

    @property
    def p256dh(self) -> str:
        return b64url(
            self.key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        )

    def decrypt(self, body: bytes) -> dict[str, Any]:
        plain = http_ece.decrypt(
            body, private_key=self.key, auth_secret=self.auth, version="aes128gcm"
        )
        return json.loads(plain)


@dataclass
class Hit:
    path: str
    headers: CIMultiDict[str]  # case-insensitive, as HTTP headers are
    body: bytes


class PushService:
    """A local aiohttp server standing in for the push service. `reply[path]` picks the answer."""

    def __init__(self) -> None:
        self.hits: list[Hit] = []
        self.reply: dict[str, tuple[int, dict[str, str]]] = {}
        self.server: TestServer | None = None

    async def _handle(self, request: web.Request) -> web.Response:
        self.hits.append(Hit(request.path, CIMultiDict(request.headers), await request.read()))
        status, headers = self.reply.get(request.path, (201, {}))
        return web.Response(status=status, headers=headers)

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/{tail:.*}", self._handle)
        self.server = TestServer(app, host="127.0.0.1")
        await self.server.start_server()

    async def close(self) -> None:
        if self.server is not None:
            await self.server.close()

    def endpoint(self, name: str) -> str:
        assert self.server is not None
        return str(self.server.make_url(f"/push/{name}"))

    def hits_for(self, name: str) -> list[Hit]:
        return [h for h in self.hits if h.path == f"/push/{name}"]


@pytest.fixture
async def service() -> AsyncIterator[PushService]:
    svc = PushService()
    await svc.start()
    try:
        yield svc
    finally:
        await svc.close()


@pytest.fixture
def vapid_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
async def sender(vapid_key: ec.EllipticCurvePrivateKey) -> AsyncIterator[WebPushSender]:
    s = WebPushSender(vapid_key, SUBJECT)
    try:
        yield s
    finally:
        await s.close()


# --- backends -----------------------------------------------------------------------------------

IN_CI = bool(os.environ.get("CI"))
SCHEMA_SQL = Path(__file__).resolve().parents[1] / "db" / "migrations" / "0001_yawmi_schema.sql"
CODE_PREFIX = "push_test_"


async def ensure_schema(pool: asyncpg.Pool) -> None:
    if await pool.fetchval("SELECT to_regclass('yawmi.reminder_sends') IS NOT NULL"):
        return
    await pool.execute(SCHEMA_SQL.read_text(encoding="utf-8"))


async def clear(pool: asyncpg.Pool) -> None:
    like = CODE_PREFIX + "%"
    await pool.execute(
        "DELETE FROM yawmi.reminder_sends WHERE reminder_id IN "
        "(SELECT id FROM yawmi.habit_reminders WHERE habit_code LIKE $1)",
        like,
    )
    await pool.execute("DELETE FROM yawmi.habit_reminders WHERE habit_code LIKE $1", like)
    await pool.execute("DELETE FROM yawmi.habit_logs WHERE habit_code LIKE $1", like)
    await pool.execute("DELETE FROM yawmi.habits WHERE code LIKE $1", like)
    await pool.execute("DELETE FROM yawmi.push_subscriptions")
    await pool.execute("DELETE FROM yawmi.devices WHERE name LIKE $1", like)


class Backend:
    """Seeds habits, reminders, logs, devices and subscriptions into one store, either kind."""

    def __init__(self, store: PushStore, pool: asyncpg.Pool | None = None, dsn: str | None = None):
        self.store = store
        self.pool = pool
        self.dsn = dsn
        self.extra_pools: list[asyncpg.Pool] = []

    @property
    def memory(self) -> InMemoryPushStore:
        assert isinstance(self.store, InMemoryPushStore)
        return self.store

    async def habit(self, code: str, title: str, **extra: Any) -> HabitRow:
        row = HabitRow(
            code=CODE_PREFIX + code,
            title_ar=title,
            kind=extra.get("kind", "boolean"),
            unit=extra.get("unit"),
            target_per_period=Decimal(str(extra.get("target", 1))),
            period=extra.get("period", "day"),
            schedule_kind=extra.get("schedule_kind", "every_day"),
            weekday_mask=extra.get("weekday_mask"),
            every_n=None,
            anchor_day=None,
            start_day=extra.get("start_day", date(2026, 11, 1)),
            end_day=None,
        )
        active = extra.get("active", True)
        if self.pool is None:
            self.memory.habits.append(row)
            if not active:
                self.memory.inactive.add(row.code)
        else:
            await self.pool.execute(
                "INSERT INTO yawmi.habits (code, title_ar, kind, unit, target_per_period, period,"
                " schedule_kind, weekday_mask, start_day, created_by, active)"
                " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'user', $10)",
                row.code,
                row.title_ar,
                row.kind,
                row.unit,
                row.target_per_period,
                row.period,
                row.schedule_kind,
                row.weekday_mask,
                row.start_day,
                active,
            )
        return row

    async def reminder(
        self, code: str, hour: int, minute: int, *, mask: int = 127, active: bool = True
    ) -> UUID:
        rid = uuid4()
        reminder = Reminder(
            id=rid, habit_code=CODE_PREFIX + code, at_time=time(hour, minute), weekday_mask=mask
        )
        if self.pool is None:
            self.memory.reminders.append(reminder)
            if not active:
                self.memory.inactive_reminders.add(rid)
        else:
            await self.pool.execute(
                "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time, weekday_mask, active)"
                " VALUES ($1, $2, $3, $4, $5)",
                rid,
                reminder.habit_code,
                reminder.at_time,
                mask,
                active,
            )
        return rid

    async def log(self, code: str, day: date, status: str = "done", value: str | None = None):
        row = LogRow(
            habit_code=CODE_PREFIX + code,
            day=day,
            value=None if value is None else Decimal(value),
            status=status,
        )
        if self.pool is None:
            self.memory.logs.append(row)
        else:
            await self.pool.execute(
                "INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source,"
                " logged_at) VALUES ($1, $2, $3, $4, $5, 'web', now())",
                uuid4(),
                row.habit_code,
                row.day,
                row.value,
                row.status,
            )

    async def device(self, kind: str = "web") -> UUID:
        device_id = uuid4()
        if self.pool is not None:
            await self.pool.execute(
                "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, $3, now())",
                device_id,
                CODE_PREFIX + "device",
                kind,
            )
        return device_id

    async def subscribe(self, endpoint: str, receiver: Receiver, device_id: UUID | None = None):
        if device_id is None:
            device_id = await self.device()
        await self.store.upsert_subscription(
            device_id, endpoint, receiver.p256dh, b64url(receiver.auth)
        )
        return device_id

    async def subscription(self, endpoint: str) -> Subscription | None:
        return next((s for s in await self.store.subscriptions() if s.endpoint == endpoint), None)

    async def reopen(self) -> PushStore:
        """The store a restarted service would use: same data, new connection (pool)."""
        if self.pool is None:
            return self.store
        pool = await create_pool(self.dsn)  # type: ignore[arg-type]
        self.extra_pools.append(pool)
        return AsyncpgPushStore(pool)


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield Backend(InMemoryPushStore())
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    await clear(pool)
    set_pool(pool)
    b = Backend(AsyncpgPushStore(pool), pool, url)
    try:
        yield b
    finally:
        set_pool(None)
        await clear(pool)
        for extra in b.extra_pools:
            await extra.close()
        await pool.close()


async def run_tick(backend: Backend, sender: WebPushSender, now: datetime, store=None) -> int:
    return await tick(store or backend.store, sender, now, tz=TZ, week_start="sun")


# --- VAPID --------------------------------------------------------------------------------------


def write_pem(path: Path, key: ec.EllipticCurvePrivateKey) -> Path:
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return path


def test_load_private_key_reads_a_p256_pem(tmp_path: Path, vapid_key) -> None:
    loaded = load_private_key(write_pem(tmp_path / "k.pem", vapid_key))
    assert loaded.private_numbers() == vapid_key.private_numbers()


def test_load_private_key_refuses_another_curve_without_echoing_the_file(tmp_path: Path) -> None:
    path = write_pem(tmp_path / "k.pem", ec.generate_private_key(ec.SECP384R1()))
    with pytest.raises(VapidKeyError) as info:
        load_private_key(path)
    assert "BEGIN" not in str(info.value)  # names settings, never key material


def test_load_private_key_refuses_garbage_and_a_missing_file(tmp_path: Path) -> None:
    (tmp_path / "bad.pem").write_text("not a key", encoding="utf-8")
    with pytest.raises(VapidKeyError):
        load_private_key(tmp_path / "bad.pem")
    with pytest.raises(VapidKeyError):
        load_private_key(tmp_path / "missing.pem")


def test_public_key_is_the_uncompressed_p256_point_in_base64url(vapid_key) -> None:
    text = public_key_b64url(vapid_key)
    assert "=" not in text and "+" not in text and "/" not in text
    raw = unb64url(text)
    assert len(raw) == 65 and raw[0] == 4
    assert raw == vapid_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def test_keygen_creates_the_key_once_and_prints_only_the_public_key(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "vapid_private.pem"
    assert keygen.main([str(path)]) == 0
    first = capsys.readouterr()
    pem = path.read_text(encoding="ascii")
    key = load_private_key(path)
    assert first.out == public_key_b64url(key) + "\n"
    assert pem not in first.out + first.err and "PRIVATE" not in first.out + first.err
    if os.name == "posix":
        assert path.stat().st_mode & 0o077 == 0o040  # group may read, others never

    assert keygen.main([str(path)]) == 0  # a second run keeps the key
    second = capsys.readouterr()
    assert path.read_text(encoding="ascii") == pem
    assert second.out == first.out
    assert "PRIVATE" not in second.out + second.err


def test_keygen_refuses_an_unreadable_existing_file_without_replacing_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "vapid_private.pem"
    path.write_text("damaged", encoding="ascii")
    assert keygen.main([str(path)]) == 1
    out = capsys.readouterr()
    assert path.read_text(encoding="ascii") == "damaged"
    assert "damaged" not in out.out + out.err


# --- the sender ---------------------------------------------------------------------------------


def test_payload_over_the_limit_raises_payload_too_large() -> None:
    with pytest.raises(PayloadTooLarge):
        encode_payload({"web_push": 8030, "notification": {"title": "x", "body": "a" * 5000}})
    # the limit leaves room for the aes128gcm header and tag inside a 4096-byte record
    assert MAX_PAYLOAD_BYTES <= 4096 - 103


def test_payload_is_compact_utf8_json() -> None:
    raw = encode_payload({"notification": {"title": "يومي"}})
    assert raw == '{"notification":{"title":"يومي"}}'.encode()


async def test_sender_posts_an_encrypted_declarative_payload_with_ttl_urgency_and_vapid(
    service: PushService, sender: WebPushSender, vapid_key
) -> None:
    receiver = Receiver()
    sub = Subscription(service.endpoint("a"), receiver.p256dh, b64url(receiver.auth), None, None)
    payload = build_payload("المشي", 2)
    result = await sender.send(sub, payload, now=at(7, 5))
    assert result.outcome == "sent"
    [hit] = service.hits_for("a")
    assert hit.headers["TTL"] == "3600"
    assert hit.headers["Urgency"] == "high"
    assert hit.headers["Content-Encoding"] == "aes128gcm"
    auth = hit.headers["Authorization"]
    assert auth.startswith("vapid t=") and f"k={public_key_b64url(vapid_key)}" in auth
    body = receiver.decrypt(hit.body)
    assert body == {
        "web_push": 8030,
        "notification": {
            "title": "يومي",
            "body": "المشي",
            "navigate": "/",
            "app_badge": 2,
            "lang": "ar",
            "dir": "rtl",
        },
    }


async def test_sender_rejects_a_large_payload_before_any_request(
    service: PushService, sender: WebPushSender
) -> None:
    receiver = Receiver()
    sub = Subscription(service.endpoint("a"), receiver.p256dh, b64url(receiver.auth), None, None)
    with pytest.raises(PayloadTooLarge):
        await sender.send(sub, {"web_push": 8030, "notification": {"body": "a" * 5000}})
    assert service.hits == []


@pytest.mark.parametrize(
    ("status", "headers", "outcome", "delay"),
    [
        (404, {}, "gone", None),
        (410, {}, "gone", None),
        (429, {"Retry-After": "120"}, "retry", timedelta(seconds=120)),
        (503, {"Retry-After": "30"}, "retry", timedelta(seconds=30)),
        (429, {}, "retry", timedelta(minutes=1)),
        (503, {"Retry-After": "Tue, 10 Nov 2026 04:15:00 GMT"}, "retry", timedelta(minutes=10)),
        (429, {"Retry-After": "999999999"}, "retry", timedelta(days=1)),
        (400, {}, "failed", None),
        (413, {}, "failed", None),
        (500, {}, "failed", None),
    ],
)
async def test_sender_classifies_push_service_answers(
    service: PushService,
    sender: WebPushSender,
    status: int,
    headers: dict[str, str],
    outcome: str,
    delay: timedelta | None,
) -> None:
    receiver = Receiver()
    service.reply["/push/a"] = (status, headers)
    sub = Subscription(service.endpoint("a"), receiver.p256dh, b64url(receiver.auth), None, None)
    now = at(7, 5)
    result = await sender.send(sub, build_payload("x", 1), now=now)
    assert (result.outcome, result.status) == (outcome, status)
    assert result.retry_after == (None if delay is None else now + delay)
    assert len(service.hits) == 1  # never an immediate retry


async def test_sender_reports_a_network_failure_as_failed(sender: WebPushSender) -> None:
    receiver = Receiver()
    sub = Subscription(
        "http://127.0.0.1:9/push/closed", receiver.p256dh, b64url(receiver.auth), None, None
    )
    result = await sender.send(sub, build_payload("x", 1), now=at(7, 5))
    assert (result.outcome, result.status, result.retry_after) == ("failed", None, None)


# --- the scheduler ------------------------------------------------------------------------------


async def test_tick_at_0705_sends_a_0700_reminder_once(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    receiver = Receiver()
    await backend.subscribe(service.endpoint("a"), receiver)

    assert await run_tick(backend, sender, at(7, 5)) == 1
    [hit] = service.hits
    assert receiver.decrypt(hit.body)["notification"]["body"] == "المشي"

    assert await run_tick(backend, sender, at(7, 6)) == 0  # the same tick again sends nothing
    assert len(service.hits) == 1
    sub = await backend.subscription(service.endpoint("a"))
    assert sub is not None and sub.last_ok_at == at(7, 5)


async def test_tick_after_a_restart_does_not_send_again(
    backend: Backend, service: PushService, vapid_key
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    await backend.subscribe(service.endpoint("a"), Receiver())

    first = WebPushSender(vapid_key, SUBJECT)
    assert await run_tick(backend, first, at(7, 5)) == 1
    await first.close()

    restarted = WebPushSender(vapid_key, SUBJECT)  # a new process: new sender, new connection
    try:
        assert await run_tick(backend, restarted, at(7, 7), await backend.reopen()) == 0
    finally:
        await restarted.close()
    assert len(service.hits) == 1


@pytest.mark.parametrize(
    ("hour", "minute", "sends"),
    [(6, 59, 0), (7, 0, 1), (7, 10, 1), (7, 11, 0)],
)
async def test_tick_sends_only_inside_the_ten_minute_window(
    backend: Backend, service: PushService, sender: WebPushSender, hour, minute, sends
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(hour, minute)) == sends


async def test_a_reached_habit_is_not_reminded(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    await backend.log("walk", DAY)
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(7, 5)) == 0
    assert service.hits == []


async def test_a_weekly_habit_reached_earlier_in_the_week_is_not_reminded(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("gym", "النادي", kind="count", target=2, period="week")
    await backend.reminder("gym", 7, 0)
    await backend.log("gym", DAY - timedelta(days=1), value="1")  # Monday, same week (sun start)
    await backend.log("gym", DAY - timedelta(days=2), value="1")  # Sunday
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(7, 5)) == 0


async def test_a_skipped_day_still_reminds_but_a_vacation_period_does_not_matter_here(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    # `skip` does not reach the target: reached is still false, so the reminder goes out
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    await backend.log("walk", DAY, status="skip")
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(7, 5)) == 1


async def test_weekday_mask_inactive_reminder_inactive_and_unscheduled_habits_send_nothing(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    tuesday_bit = 1 << 2
    await backend.habit("a", "أ")
    await backend.reminder("a", 7, 0, mask=127 & ~tuesday_bit)  # every day but Tuesday
    await backend.habit("b", "ب")
    await backend.reminder("b", 7, 0, active=False)
    await backend.habit("c", "ج", active=False)
    await backend.reminder("c", 7, 0)
    await backend.habit("d", "د", schedule_kind="weekdays", weekday_mask=1)  # Sundays only
    await backend.reminder("d", 7, 0)
    await backend.habit("e", "هـ", start_day=DAY + timedelta(days=1))  # starts tomorrow
    await backend.reminder("e", 7, 0)
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(7, 5)) == 0
    assert service.hits == []


async def test_badge_counts_the_due_habits_that_are_not_reached(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("a", "أ")
    await backend.habit("b", "ب")
    await backend.habit("c", "ج")
    await backend.habit("d", "د", schedule_kind="weekdays", weekday_mask=1)  # not due today
    await backend.log("c", DAY)
    await backend.reminder("a", 7, 0)
    receiver = Receiver()
    await backend.subscribe(service.endpoint("a"), receiver)
    assert await run_tick(backend, sender, at(7, 5)) == 1
    assert receiver.decrypt(service.hits[0].body)["notification"]["app_badge"] == 2


async def test_a_reminder_late_at_night_is_sent_after_midnight_for_its_own_day(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("read", "القراءة")
    await backend.reminder("read", 23, 55)
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(0, 3, DAY + timedelta(days=1))) == 1
    # and it was claimed for the 10th: the 11th's own reminder at 23:55 is still to come
    assert await run_tick(backend, sender, at(23, 56, DAY + timedelta(days=1))) == 1


async def test_410_deletes_the_subscription_without_a_retry(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    await backend.subscribe(service.endpoint("gone"), Receiver())
    service.reply["/push/gone"] = (410, {})
    assert await run_tick(backend, sender, at(7, 5)) == 0
    assert len(service.hits) == 1
    assert await backend.subscription(service.endpoint("gone")) is None


async def test_429_sets_retry_after_and_the_next_tick_skips_the_subscription(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.habit("read", "القراءة")
    await backend.reminder("walk", 7, 0)
    await backend.reminder("read", 7, 6)
    await backend.subscribe(service.endpoint("busy"), Receiver())
    service.reply["/push/busy"] = (429, {"Retry-After": "120"})

    assert await run_tick(backend, sender, at(7, 5)) == 0
    sub = await backend.subscription(service.endpoint("busy"))
    assert sub is not None and sub.retry_after == at(7, 7)

    assert await run_tick(backend, sender, at(7, 6)) == 0  # backing off: not even tried
    assert len(service.hits) == 1

    service.reply.pop("/push/busy")
    assert await run_tick(backend, sender, at(7, 8)) == 1  # the 07:06 reminder, still in window
    assert len(service.hits) == 2
    sub = await backend.subscription(service.endpoint("busy"))
    assert sub is not None and sub.retry_after is None


async def test_one_failing_subscription_does_not_stop_the_others(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    device = await backend.device()
    await backend.store.upsert_subscription(device, "http://127.0.0.1:9/push/dead", "bad", "bad")
    await backend.subscribe(service.endpoint("broken"), Receiver(), device)
    await backend.subscribe(service.endpoint("ok"), Receiver(), device)
    service.reply["/push/broken"] = (500, {})
    assert await run_tick(backend, sender, at(7, 5)) == 1
    assert len(service.hits_for("ok")) == 1
    assert await backend.subscription(service.endpoint("broken")) is not None  # kept


async def test_no_deliverable_subscription_leaves_the_reminder_unclaimed(
    backend: Backend, service: PushService, sender: WebPushSender
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    assert await run_tick(backend, sender, at(7, 2)) == 0  # nobody subscribed yet
    await backend.subscribe(service.endpoint("a"), Receiver())
    assert await run_tick(backend, sender, at(7, 4)) == 1  # so it still goes out in its window


async def test_tick_logs_no_endpoint_path_or_key(
    backend: Backend, service: PushService, sender: WebPushSender, caplog
) -> None:
    await backend.habit("walk", "المشي")
    await backend.reminder("walk", 7, 0)
    receiver = Receiver()
    await backend.subscribe(service.endpoint("secret-token-path"), receiver)
    service.reply["/push/secret-token-path"] = (500, {})
    with caplog.at_level(logging.DEBUG):
        await run_tick(backend, sender, at(7, 5))
    # everything logged on our side; `aiohttp.access` is the fake push service's own server log
    text = "\n".join(r.getMessage() for r in caplog.records if r.name != "aiohttp.access")
    assert "push send failed (500) host=127.0.0.1" in text
    assert "secret-token-path" not in text
    assert receiver.p256dh not in text and b64url(receiver.auth) not in text
    assert "المشي" not in text


async def test_tick_refuses_a_naive_now(backend: Backend, sender: WebPushSender) -> None:
    with pytest.raises(ValueError):
        await run_tick(backend, sender, datetime(2026, 11, 10, 7, 5))


async def test_loop_survives_a_failing_tick_and_stops_cleanly(caplog) -> None:
    calls: list[datetime] = []

    async def flaky(now: datetime) -> int:
        calls.append(now)
        if len(calls) == 1:
            raise RuntimeError("endpoint https://push.example/secret-path failed")
        return 0

    loop = ReminderLoop(flaky, interval=0.0)
    with caplog.at_level(logging.WARNING):
        loop.start()
        for _ in range(200):
            if len(calls) >= 3:
                break
            await asyncio.sleep(0.01)
        await loop.stop()
    assert len(calls) >= 3
    assert "RuntimeError" in caplog.text
    assert "secret-path" not in caplog.text
    assert loop.task is not None and loop.task.done()


# --- the routes ---------------------------------------------------------------------------------


def settings(**extra: Any) -> Settings:
    return Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
        **extra,
    )


def auth(device_id: UUID, kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(device_id, kind, SECRET, 900)}"}


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    application = create_app(settings=settings(), devices=InMemoryDeviceStore())
    application.state.push_store = backend.store
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def sub_body(endpoint: str = "https://web.push.apple.com/abc", **extra: Any) -> dict[str, Any]:
    receiver = Receiver()
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": receiver.p256dh, "auth": b64url(receiver.auth)},
        **extra,
    }


async def test_subscribe_stores_the_subscription_for_the_calling_device(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    device = await backend.device()
    body = sub_body()
    response = await client.post("/v1/push/subscribe", json=body, headers=auth(device))
    assert response.status_code == 204, response.text
    assert response.content == b""
    sub = await backend.subscription(body["endpoint"])
    assert sub is not None
    assert (sub.device_id, sub.p256dh, sub.auth) == (
        device,
        body["keys"]["p256dh"],
        body["keys"]["auth"],
    )


async def test_subscribe_again_updates_keys_and_clears_the_back_off(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    device = await backend.device()
    body = sub_body()
    await client.post("/v1/push/subscribe", json=body, headers=auth(device))
    await backend.store.set_retry_after(body["endpoint"], at(9, 0))
    again = sub_body(body["endpoint"])
    response = await client.post("/v1/push/subscribe", json=again, headers=auth(device))
    assert response.status_code == 204
    subs = [s for s in await backend.store.subscriptions() if s.endpoint == body["endpoint"]]
    assert len(subs) == 1
    assert subs[0].p256dh == again["keys"]["p256dh"] and subs[0].retry_after is None


@pytest.mark.parametrize(
    ("body", "loc"),
    [
        (sub_body("http://web.push.apple.com/abc"), ["body", "endpoint"]),
        (sub_body("https:///no-host"), ["body", "endpoint"]),
        (sub_body("ftp://x/abc"), ["body", "endpoint"]),
        (sub_body("https://user:pw@push.example/abc"), ["body", "endpoint"]),
        (sub_body("https://push.example/" + "a" * 2100), ["body", "endpoint"]),
        (sub_body("https://push.example/a\u0000b"), ["body", "endpoint"]),
        (
            {**sub_body(), "keys": {"p256dh": "a" * 300, "auth": b64url(b"1" * 16)}},
            ["body", "keys", "p256dh"],
        ),
        (
            {**sub_body(), "keys": {"p256dh": b64url(b"\x04" * 10), "auth": b64url(b"1" * 16)}},
            ["body", "keys", "p256dh"],
        ),
        (
            {**sub_body(), "keys": {"p256dh": Receiver().p256dh, "auth": b64url(b"1" * 8)}},
            ["body", "keys", "auth"],
        ),
        (
            {**sub_body(), "keys": {"p256dh": Receiver().p256dh, "auth": "!!!!"}},
            ["body", "keys", "auth"],
        ),
        (sub_body(extra="x"), ["body", "extra"]),
    ],
)
async def test_subscribe_validates_every_field(
    client: httpx.AsyncClient, backend: Backend, body: dict[str, Any], loc: list[str]
) -> None:
    device = await backend.device()
    response = await client.post("/v1/push/subscribe", json=body, headers=auth(device))
    assert response.status_code == 422, response.text
    data = response.json()
    assert data["detail"] == "طلب غير صالح"
    assert [e["loc"] for e in data["errors"]] == [loc]
    assert set(data["errors"][0]) == {"loc", "type"}
    assert await backend.store.subscriptions() == []


async def test_service_tokens_cannot_subscribe_and_anonymous_calls_are_refused(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    device = await backend.device("service")
    for method in ("POST", "DELETE"):
        response = await client.request(
            method, "/v1/push/subscribe", json=sub_body(), headers=auth(device, "service")
        )
        assert response.status_code == 403
        response = await client.request(method, "/v1/push/subscribe", json=sub_body())
        assert response.status_code == 401
    assert await backend.store.subscriptions() == []


async def test_unsubscribe_removes_only_the_callers_own_subscription(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    mine, other = await backend.device(), await backend.device()
    a, b = sub_body("https://push.example/a"), sub_body("https://push.example/b")
    await client.post("/v1/push/subscribe", json=a, headers=auth(mine))
    await client.post("/v1/push/subscribe", json=b, headers=auth(other))

    response = await client.request(
        "DELETE", "/v1/push/subscribe", json={"endpoint": b["endpoint"]}, headers=auth(mine)
    )
    assert response.status_code == 204  # idempotent: not mine, nothing happens
    assert await backend.subscription(b["endpoint"]) is not None

    response = await client.request(
        "DELETE", "/v1/push/subscribe", json={"endpoint": a["endpoint"]}, headers=auth(mine)
    )
    assert response.status_code == 204
    assert await backend.subscription(a["endpoint"]) is None


async def test_vapid_public_key_is_served_when_push_is_enabled(
    backend: Backend, tmp_path: Path, vapid_key
) -> None:
    path = write_pem(tmp_path / "vapid_private.pem", vapid_key)
    app = create_app(
        settings=settings(push_enabled=True, vapid_private_key_file=path, vapid_subject=SUBJECT),
        devices=InMemoryDeviceStore(),
    )
    app.state.push_store = backend.store
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        response = await c.get("/v1/push/vapid-public-key", headers=auth(uuid4()))
        assert response.status_code == 200
        assert response.json() == {"key": public_key_b64url(vapid_key)}
        assert (await c.get("/v1/push/vapid-public-key")).status_code == 401


async def test_vapid_public_key_is_503_when_push_is_disabled(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/push/vapid-public-key", headers=auth(uuid4()))
    assert response.status_code == 503
    assert response.json() == {"detail": "الإشعارات غير مفعّلة"}


# --- settings and the lifespan ------------------------------------------------------------------


def test_an_empty_vapid_subject_means_none_and_a_non_mailto_one_is_refused() -> None:
    assert settings(vapid_subject="").vapid_subject is None
    with pytest.raises(ValueError):
        settings(vapid_subject="https://example.com")


def test_with_push_disabled_the_app_never_imports_the_push_stack() -> None:
    code = (
        "import sys\n"
        "from pydantic import SecretStr\n"
        "from yawmi.auth.memory_store import InMemoryDeviceStore\n"
        "from yawmi.main import create_app\n"
        "from yawmi.settings import Settings\n"
        "create_app(settings=Settings(database_url='postgresql://x@h/d',"
        " jwt_secret=SecretStr('s' * 40)), devices=InMemoryDeviceStore())\n"
        "print(sorted(m for m in ('pywebpush', 'aiohttp', 'yawmi.push.sender',"
        " 'yawmi.push.scheduler') if m in sys.modules))\n"
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("YAWMI_")}
    env.update({"YAWMI_DATABASE_URL": "postgresql://x@h/d", "YAWMI_JWT_SECRET": "s" * 40})
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


class FakePool:
    closed = False

    async def close(self) -> None:
        self.closed = True


async def test_lifespan_starts_and_stops_the_scheduler_only_when_push_is_enabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, vapid_key
) -> None:
    pool = FakePool()

    async def fake_create_pool(dsn: str, **_: Any) -> FakePool:
        return pool

    monkeypatch.setattr("yawmi.main.create_pool", fake_create_pool)
    ticks: list[datetime] = []

    async def fake_tick(store, sender, now, *, tz, week_start) -> int:
        ticks.append(now)
        assert (tz, week_start) == ("Asia/Riyadh", "sun")
        return 0

    monkeypatch.setattr("yawmi.push.scheduler.tick", fake_tick)
    path = write_pem(tmp_path / "vapid_private.pem", vapid_key)
    config = settings(push_enabled=True, vapid_private_key_file=path, vapid_subject=SUBJECT)
    app = create_app(settings=config)
    async with app.router.lifespan_context(app):
        for _ in range(100):
            if ticks:
                break
            await asyncio.sleep(0.01)
        loop = app.state.reminder_loop
        assert loop.task is not None and not loop.task.done()
    assert loop.task.done()
    assert ticks and pool.closed

    disabled = create_app(settings=settings())
    async with disabled.router.lifespan_context(disabled):
        assert getattr(disabled.state, "reminder_loop", None) is None


@pytest.mark.parametrize(
    "extra",
    [
        {"vapid_subject": SUBJECT},  # no key file
        {"vapid_private_key_file": Path("missing.pem"), "vapid_subject": SUBJECT},
        {"vapid_private_key_file": None},
    ],
)
async def test_lifespan_refuses_to_start_push_without_a_key_and_a_subject(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, vapid_key, extra: dict[str, Any]
) -> None:
    async def fake_create_pool(dsn: str, **_: Any) -> FakePool:
        return FakePool()

    monkeypatch.setattr("yawmi.main.create_pool", fake_create_pool)
    if extra.get("vapid_private_key_file") is None and "vapid_subject" not in extra:
        extra = {"vapid_private_key_file": write_pem(tmp_path / "k.pem", vapid_key)}  # no subject
    app = create_app(settings=settings(push_enabled=True, **extra))
    with pytest.raises(RuntimeError) as info:
        async with app.router.lifespan_context(app):
            pass
    assert "BEGIN" not in str(info.value)  # names settings, never key material
