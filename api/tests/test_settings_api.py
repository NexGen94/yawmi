"""Tests for `GET /v1/settings` and `PATCH /v1/settings` (memory and Postgres backends)."""

import json
from collections.abc import AsyncIterator
from typing import Any, Protocol
from uuid import UUID

import asyncpg
import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client, open_backend
from fastapi import FastAPI

from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.prefs.models import SettingsOut
from yawmi.prefs.store import AsyncpgPrefsStore, PrefsStore

DEVICE_ID = UUID("00000000-0000-7000-8000-000000000401")


class Backend(Protocol):
    prefs: PrefsStore

    def install(self, app: FastAPI) -> None: ...
    async def setup(self) -> None: ...
    async def cleanup(self) -> None: ...
    async def plant(self, key: str, value: Any) -> None:
        """Write a raw value under `key`, bypassing validation (a row from an older version)."""
        ...


class MemoryBackend:
    def __init__(self) -> None:
        self.prefs = InMemoryPrefsStore()

    def install(self, app: FastAPI) -> None:
        app.state.prefs = self.prefs

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        self.prefs = InMemoryPrefsStore()

    async def plant(self, key: str, value: Any) -> None:
        self.prefs._values[key] = value


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.prefs = AsyncpgPrefsStore(pool)

    def install(self, app: FastAPI) -> None:
        app.state.prefs = self.prefs

    async def setup(self) -> None:
        await self.cleanup()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            DEVICE_ID,
            "t10 settings test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.user_settings")

    async def plant(self, key: str, value: Any) -> None:
        await self.pool.execute(
            "INSERT INTO yawmi.user_settings (key, value) VALUES ($1, $2::jsonb)"
            " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            key,
            json.dumps(value),
        )


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    async with open_backend(request.param, MemoryBackend, PostgresBackend) as b:
        yield b


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    return build_app(backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def auth_header() -> dict[str, str]:
    return bearer(DEVICE_ID)


async def test_initial_settings_returns_defaults(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    resp = await client.get("/v1/settings", headers=auth_header())
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["mission"] == ""
    assert data["vision"] == ""
    assert data["digits"] == "latn"
    assert data["ai_lines"] == 2
    assert data["ai_tone"] == "direct"
    assert data["ai_checkin"] == "evening"
    assert data["day_reminders"] == {"morning": None, "evening": None, "weekly": None}
    assert data["late_notice_enabled"] is True
    assert data["late_notice_time"] == "20:00"
    assert data["goal_columns"]["outcomes"] == [
        "code",
        "title",
        "completion",
        "next_milestone",
        "target_date",
    ]
    assert data["goal_columns"]["milestones"] == [
        "title",
        "outcome_code",
        "due_date",
        "done",
        "cycle_no",
    ]
    assert data["goal_columns"]["cards"] == [
        "title",
        "status",
        "outcome_codes",
        "target_date",
        "next_step",
        "milestones_done",
    ]
    assert data["focus_daily_target_min"] is None
    assert data["breath_weekly_target_min"] is None
    assert data["breath_prefs"] is None


async def test_patch_settings_persists_and_preserves_other_keys(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    patch_resp = await client.patch(
        "/v1/settings",
        json={"mission": "نص رسالتي في الحياة"},
        headers=auth_header(),
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["mission"] == "نص رسالتي في الحياة"
    assert patch_resp.json()["digits"] == "latn"

    get_resp = await client.get("/v1/settings", headers=auth_header())
    assert get_resp.status_code == 200
    assert get_resp.json()["mission"] == "نص رسالتي في الحياة"
    assert get_resp.json()["digits"] == "latn"
    assert get_resp.json()["ai_lines"] == 2


async def test_settings_validation_errors(client: httpx.AsyncClient, backend: Backend) -> None:
    # 601 characters for mission
    resp = await client.patch("/v1/settings", json={"mission": "أ" * 601}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # ai_lines: 3
    resp = await client.patch("/v1/settings", json={"ai_lines": 3}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # digits: "x"
    resp = await client.patch("/v1/settings", json={"digits": "x"}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # check_text on text field (e.g. control character)
    resp = await client.patch("/v1/settings", json={"mission": "نص\x00خبيث"}, headers=auth_header())
    assert resp.status_code == 422, resp.text


async def test_breath_prefs_validation(client: httpx.AsyncClient, backend: Backend) -> None:
    # Valid
    valid_prefs = {"rate": 6.0, "pattern": "calm", "minutes": 5, "sound": True}
    resp = await client.patch(
        "/v1/settings", json={"breath_prefs": valid_prefs}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["breath_prefs"] == valid_prefs

    # rate: 4
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 4.0, "pattern": "calm", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # rate: 8
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 8.0, "pattern": "calm", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # minutes: 11
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 6.0, "pattern": "calm", "minutes": 11, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # pattern: "box"
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 6.0, "pattern": "box", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text


NON_NULLABLE_KEYS = (
    "mission",
    "vision",
    "digits",
    "ai_lines",
    "ai_tone",
    "ai_checkin",
    "day_reminders",
    "late_notice_enabled",
    "late_notice_time",
    "goal_columns",
)
NULLABLE_KEYS = ("focus_daily_target_min", "breath_weekly_target_min", "breath_prefs")


@pytest.mark.parametrize("key", NON_NULLABLE_KEYS)
async def test_null_for_a_key_that_cannot_be_empty_is_a_422_and_stores_nothing(
    client: httpx.AsyncClient, backend: Backend, key: str
) -> None:
    resp = await client.patch("/v1/settings", json={key: None}, headers=auth_header())
    assert resp.status_code == 422, resp.text
    # nothing was stored: the settings still read, and a later patch still works
    got = await client.get("/v1/settings", headers=auth_header())
    assert got.status_code == 200, got.text
    again = await client.patch("/v1/settings", json={"ai_lines": 1}, headers=auth_header())
    assert again.status_code == 200, again.text


@pytest.mark.parametrize("key", NULLABLE_KEYS)
async def test_null_clears_a_key_that_may_be_empty(
    client: httpx.AsyncClient, backend: Backend, key: str
) -> None:
    resp = await client.patch("/v1/settings", json={key: None}, headers=auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json()[key] is None


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("digits", 5),
        ("digits", ["latn"]),
        ("ai_lines", "2"),
        ("ai_lines", True),
        ("ai_lines", 2.5),
        ("late_notice_enabled", "yes"),
        ("late_notice_enabled", 1),
        ("late_notice_time", 2000),
        ("mission", 7),
        ("day_reminders", "soon"),
        ("goal_columns", []),
        ("focus_daily_target_min", "10"),
        ("breath_prefs", "calm"),
    ],
)
async def test_a_value_of_the_wrong_type_is_a_422(
    client: httpx.AsyncClient, backend: Backend, key: str, value: Any
) -> None:
    resp = await client.patch("/v1/settings", json={key: value}, headers=auth_header())
    assert resp.status_code == 422, resp.text
    assert (await client.get("/v1/settings", headers=auth_header())).status_code == 200


@pytest.mark.parametrize(
    ("key", "bad"),
    [
        ("digits", None),
        ("digits", "x"),
        ("ai_lines", 3),
        ("late_notice_time", "25:00"),
        ("late_notice_enabled", "maybe"),
        ("day_reminders", {"evening": "21:00"}),
        ("goal_columns", {"outcomes": 5}),
        ("mission", None),
        ("focus_daily_target_min", 1),
        ("breath_prefs", {"rate": 4, "pattern": "calm", "minutes": 5, "sound": True}),
        ("not_a_key", 1),
    ],
)
async def test_a_stored_bad_value_never_breaks_get_or_patch(
    client: httpx.AsyncClient, backend: Backend, key: str, bad: Any
) -> None:
    await backend.plant(key, bad)
    resp = await client.get("/v1/settings", headers=auth_header())
    assert resp.status_code == 200, resp.text
    default = SettingsOut().model_dump(mode="json")
    if key in default:
        assert resp.json()[key] == default[key]
    # the other keys keep working around the bad row
    patched = await client.patch(
        "/v1/settings", json={"ai_tone": "explained"}, headers=auth_header()
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["ai_tone"] == "explained"


async def test_one_bad_row_does_not_reset_the_good_ones(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await client.patch("/v1/settings", json={"mission": "نص"}, headers=auth_header())
    await backend.plant("digits", None)
    data = (await client.get("/v1/settings", headers=auth_header())).json()
    assert data["mission"] == "نص"
    assert data["digits"] == "latn"


async def test_an_unknown_key_is_a_422(client: httpx.AsyncClient, backend: Backend) -> None:
    resp = await client.patch("/v1/settings", json={"theme": "dark"}, headers=auth_header())
    assert resp.status_code == 422, resp.text
    resp = await client.patch("/v1/settings", json={"week_start": "sun"}, headers=auth_header())
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize(
    "body",
    [
        {"day_reminders": {"noon": {"time": "12:00", "days_mask": 127}}},
        {"day_reminders": {"evening": {"time": "21:00", "days_mask": 127, "x": 1}}},
        {"goal_columns": {"outcomes": ["code"], "extra": []}},
        {"breath_prefs": {"rate": 6, "pattern": "calm", "minutes": 5, "sound": True, "x": 1}},
    ],
)
async def test_nested_objects_refuse_unknown_keys(
    client: httpx.AsyncClient, backend: Backend, body: dict[str, Any]
) -> None:
    resp = await client.patch("/v1/settings", json=body, headers=auth_header())
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize(
    "columns",
    [
        {"outcomes": ["not_a_column"]},
        {"milestones": ["code"]},  # an outcome column, not a milestone one
        {"cards": ["title", "nope"]},
        {"outcomes": ["code\x00"]},
        {"outcomes": ["code"] * 40},
    ],
)
async def test_goal_columns_come_from_the_closed_sets(
    client: httpx.AsyncClient, backend: Backend, columns: dict[str, Any]
) -> None:
    resp = await client.patch("/v1/settings", json={"goal_columns": columns}, headers=auth_header())
    assert resp.status_code == 422, resp.text


async def test_goal_columns_accept_every_column_of_the_models(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    columns = {
        "outcomes": ["code", "title", "track", "target_date", "acceptance", "status"]
        + ["milestones_total", "milestones_done", "milestones_due", "completion"]
        + ["next_milestone", "habits", "indicator", "kpis"],
        "milestones": ["page_id", "title", "outcome_code", "card_page_ids", "cycle_no"]
        + ["due_date", "done", "criterion", "evidence", "notion_edited_at", "overdue_days"]
        + ["pending"],
        "cards": ["page_id", "title", "status", "outcome_codes", "target_date", "next_step"]
        + ["notion_edited_at", "habits", "habits_adherence_avg", "milestones_total"]
        + ["milestones_done", "tasks_total", "tasks_done", "indicator", "pending"],
    }
    resp = await client.patch("/v1/settings", json={"goal_columns": columns}, headers=auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json()["goal_columns"] == columns


async def test_text_with_a_lone_surrogate_is_a_422(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    resp = await client.patch(
        "/v1/settings",
        content=b'{"vision": "\\ud800"}',
        headers=auth_header() | {"Content-Type": "application/json"},
    )
    assert resp.status_code == 422, resp.text
