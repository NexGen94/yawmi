"""`mood_logged` event projection and `GET /v1/mood` on both backends (memory and Postgres)."""

from typing import Any
from uuid import uuid4

import httpx
import pytest
from test_journal import auth, backend, client  # type: ignore[import-not-found]

__all__ = ["backend", "client"]


def mood_event(payload: dict[str, Any], *, at: str = "2026-11-10T18:00:00Z") -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "type": "mood_logged",
        "payload": payload,
        "occurred_at": at,
        "tz": "Asia/Riyadh",
    }


async def test_mood_event_is_returned_by_get_mood_with_numeric_score(
    client: httpx.AsyncClient,
) -> None:
    ev = mood_event(
        {
            "score": 4,
            "feelings": ["calm", "grateful"],
            "activities": ["walk"],
        }
    )
    post_res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert post_res.status_code == 200, post_res.text

    res = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res.status_code == 200, res.text
    logs = res.json()["logs"]
    assert len(logs) == 1
    log = logs[0]
    assert log == {
        "day": "2026-11-10",
        "score": 4,
        "feelings": ["calm", "grateful"],
        "activities": ["walk"],
    }
    assert isinstance(log["score"], int) and not isinstance(log["score"], bool)


async def test_mood_newest_event_wins_per_day(client: httpx.AsyncClient) -> None:
    first = mood_event({"score": 4, "feelings": ["calm"]}, at="2026-11-10T18:00:00Z")
    older = mood_event({"score": 2, "feelings": ["tired"]}, at="2026-11-10T17:00:00Z")
    newer = mood_event({"score": 5, "feelings": ["grateful"]}, at="2026-11-10T19:00:00Z")

    assert (
        await client.post("/v1/events", json={"events": [first]}, headers=auth())
    ).status_code == 200
    assert (
        await client.post("/v1/events", json={"events": [older]}, headers=auth())
    ).status_code == 200
    res1 = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res1.json()["logs"][0]["score"] == 4

    assert (
        await client.post("/v1/events", json={"events": [newer]}, headers=auth())
    ).status_code == 200
    res2 = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res2.json()["logs"][0]["score"] == 5
    assert res2.json()["logs"][0]["feelings"] == ["grateful"]


@pytest.mark.parametrize(
    "payload",
    [
        {"score": 6},
        {"score": 0},
        {"score": 4, "feelings": ["f1", "f2", "f3", "f4", "f5", "f6", "f7"]},
        {"score": 4, "feelings": ["x" * 25]},
        {"score": 4, "activities": [f"a{i}" for i in range(13)]},
    ],
    ids=["score-6", "score-0", "seven-feelings", "feeling-too-long", "thirteen-activities"],
)
async def test_invalid_mood_payloads_are_rejected(
    client: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    ev = mood_event(payload)
    res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert res.status_code == 422
