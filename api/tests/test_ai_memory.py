"""The visible AI memory (design §7.1, §7.6, §10): lenses (`rule`) and saved notes (`note`).

Every active item is attached to every AI request: a lens as a `rule:<id>` source of kind
`standing_rule`, a note as `note:<id>` of kind `memory_note`; an inactive one is not. At most 20
items of up to 300 characters; the 21st is a 422 `memory_full`. One item is deleted for good, and
`DELETE /v1/ai/memory` empties the list. `attached` says whether «رسالتي» and «رؤيتي» go out with
the requests: only with a text and a consent that covers personal text. Every route test runs on
the in-memory store and on Postgres; the deletes are also run as the `yawmi_api` role.
"""

import os
from typing import Any
from uuid import uuid4

import asyncpg
import httpx
import pytest
from ai_harness import DAY, AiBackend, auth
from goals_harness import open_goals_pool

from yawmi.ai.memory import (
    MAX_MEMORY_ITEMS,
    MAX_MEMORY_TEXT,
    AsyncpgMemoryStore,
    InMemoryMemoryStore,
    MemoryFull,
)

LENS = "ذكر الرقم عند مخالفة الكلام للبيانات"
MEMORY = "/v1/ai/memory"


@pytest.fixture
def client(ai_client: httpx.AsyncClient) -> httpx.AsyncClient:
    return ai_client


async def consent(client: httpx.AsyncClient, personal_text: bool = False) -> None:
    body = {"provider": "anthropic", "personal_text": personal_text}
    resp = await client.put("/v1/ai/consent", json=body, headers=auth())
    assert resp.status_code == 200, resp.text


async def add(client: httpx.AsyncClient, text: str, kind: str = "rule") -> httpx.Response:
    return await client.post(MEMORY, json={"kind": kind, "text": text}, headers=auth())


async def items(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    resp = await client.get(MEMORY, headers=auth())
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def ask(client: httpx.AsyncClient) -> httpx.Response:
    return await client.post("/v1/ask", json={"question": "كيف كان الأسبوع؟"}, headers=auth())


# --- lenses and notes reach the provider -------------------------------------------------------


async def test_a_lens_is_a_standing_rule_source_and_a_disabled_one_is_not(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    created = await add(client, LENS)
    assert created.status_code == 201, created.text
    item = created.json()
    assert set(item) == {"id", "kind", "text", "active", "created_at"}
    assert (item["kind"], item["text"], item["active"]) == ("rule", LENS, True)
    await consent(client)
    assert (await ask(client)).status_code == 200
    rule_id = f"rule:{item['id']}"
    assert ai.provider.sources()[rule_id] == {"id": rule_id, "kind": "standing_rule", "text": LENS}

    off = await client.patch(f"{MEMORY}/{item['id']}", json={"active": False}, headers=auth())
    assert off.status_code == 200, off.text
    assert off.json()["active"] is False
    assert (await ask(client)).status_code == 200
    assert rule_id not in ai.provider.sources()
    assert not any(s["kind"] == "standing_rule" for s in ai.provider.payload["sources"])


async def test_a_saved_note_is_a_memory_note_source(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    note = (await add(client, "الاجتماعات الصباحية تأخذ الوقت", kind="note")).json()
    await consent(client)
    assert (await ask(client)).status_code == 200
    note_id = f"note:{note['id']}"
    assert ai.provider.sources()[note_id]["kind"] == "memory_note"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/v1/day/close", {"day": DAY.isoformat()}),
        ("/v1/ask", {"question": "سؤال"}),
        ("/v1/insights/morning", {"day": DAY.isoformat()}),
        ("/v1/insights/weekly", {"day": DAY.isoformat()}),
    ],
)
async def test_the_lens_is_attached_to_every_request(
    ai: AiBackend, client: httpx.AsyncClient, path: str, body: dict[str, Any]
) -> None:
    item = (await add(client, LENS)).json()
    await consent(client)
    resp = await client.post(path, json=body, headers=auth())
    assert resp.status_code == 200, resp.text
    assert f"rule:{item['id']}" in ai.provider.sources()


async def test_the_lens_is_attached_to_go_deeper(ai: AiBackend, client: httpx.AsyncClient) -> None:
    item = (await add(client, LENS)).json()

    def deeper(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "lines": [],
            "question": "ما الذي يستحق التأمل؟",
            "source_ids": [],
            "priorities": [],
        }

    ai.provider.script = [deeper]
    await consent(client)
    resp = await client.post("/v1/insights/deeper", json={"day": DAY.isoformat()}, headers=auth())
    assert resp.status_code == 200, resp.text
    assert f"rule:{item['id']}" in ai.provider.sources()


# --- limits ------------------------------------------------------------------------------------


async def test_a_text_of_301_characters_is_a_422_and_300_is_kept(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    assert MAX_MEMORY_TEXT == 300
    over = await add(client, "س" * 301)
    assert over.status_code == 422
    assert over.json()["errors"][0]["loc"] == ["body", "text"]
    exact = await add(client, "س" * 300)
    assert exact.status_code == 201, exact.text
    long_patch = await client.patch(
        f"{MEMORY}/{exact.json()['id']}", json={"text": "س" * 301}, headers=auth()
    )
    assert long_patch.status_code == 422
    assert [i["text"] for i in await items(client)] == ["س" * 300]


@pytest.mark.parametrize("text", ["", "   ", "\x00نص"])
async def test_an_empty_or_unstorable_text_is_a_422(
    ai: AiBackend, client: httpx.AsyncClient, text: str
) -> None:
    resp = await add(client, text)
    assert resp.status_code == 422
    assert await items(client) == []


async def test_an_unknown_kind_is_a_422(ai: AiBackend, client: httpx.AsyncClient) -> None:
    resp = await add(client, "نص", kind="secret")
    assert resp.status_code == 422


async def test_the_twenty_first_item_is_a_422_memory_full(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    assert MAX_MEMORY_ITEMS == 20
    for n in range(20):
        resp = await add(client, f"عدسة {n}", kind="rule" if n % 2 else "note")
        assert resp.status_code == 201, (n, resp.text)
    full = await add(client, "الحادية والعشرون")
    assert full.status_code == 422
    assert full.json()["errors"] == [{"loc": ["body"], "type": "memory_full"}]
    assert len(await items(client)) == 20
    # an inactive item still counts; deleting one frees a place
    first = (await items(client))[0]
    await client.patch(f"{MEMORY}/{first['id']}", json={"active": False}, headers=auth())
    assert (await add(client, "ما زالت ممتلئة")).status_code == 422
    assert (await client.delete(f"{MEMORY}/{first['id']}", headers=auth())).status_code == 204
    assert (await add(client, "مكان جديد")).status_code == 201


# --- delete, reset, patch ----------------------------------------------------------------------


async def test_deleting_an_item_is_a_204_then_it_is_gone(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    keep = (await add(client, "تبقى")).json()
    gone = (await add(client, "تُحذف", kind="note")).json()
    resp = await client.delete(f"{MEMORY}/{gone['id']}", headers=auth())
    assert resp.status_code == 204
    assert resp.content == b""
    assert [i["id"] for i in await items(client)] == [keep["id"]]
    again = await client.delete(f"{MEMORY}/{gone['id']}", headers=auth())
    assert again.status_code == 404


async def test_deleting_the_collection_empties_the_list(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    for text in ("أولى", "ثانية", "ثالثة"):
        await add(client, text)
    resp = await client.delete(MEMORY, headers=auth())
    assert resp.status_code == 204
    assert await items(client) == []
    assert (await client.delete(MEMORY, headers=auth())).status_code == 204


async def test_the_list_is_in_creation_order(ai: AiBackend, client: httpx.AsyncClient) -> None:
    for text in ("أولى", "ثانية", "ثالثة"):
        await add(client, text)
    assert [i["text"] for i in await items(client)] == ["أولى", "ثانية", "ثالثة"]


async def test_a_patch_edits_the_text_and_keeps_the_rest(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    item = (await add(client, "قديم")).json()
    resp = await client.patch(f"{MEMORY}/{item['id']}", json={"text": "  جديد  "}, headers=auth())
    assert resp.status_code == 200, resp.text
    assert resp.json() == {**item, "text": "جديد"}


async def test_an_empty_patch_is_a_422_and_an_unknown_item_a_404(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    item = (await add(client, "نص")).json()
    empty = await client.patch(f"{MEMORY}/{item['id']}", json={}, headers=auth())
    assert empty.status_code == 422
    assert empty.json()["errors"][0]["type"] == "empty_patch"
    extra = await client.patch(f"{MEMORY}/{item['id']}", json={"kind": "note"}, headers=auth())
    assert extra.status_code == 422
    unknown = await client.patch(f"{MEMORY}/{uuid4()}", json={"active": False}, headers=auth())
    assert unknown.status_code == 404


async def test_a_service_token_cannot_read_or_change_the_memory(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    service = auth("service")
    assert (await client.get(MEMORY, headers=service)).status_code == 403
    assert (
        await client.post(MEMORY, json={"kind": "rule", "text": "x"}, headers=service)
    ).status_code == 403
    assert (await client.delete(MEMORY, headers=service)).status_code == 403
    assert (await client.get(MEMORY)).status_code == 401


# --- attached: «رسالتي» and «رؤيتي» ------------------------------------------------------------


async def attached(client: httpx.AsyncClient) -> dict[str, bool]:
    resp = await client.get(MEMORY, headers=auth())
    assert resp.status_code == 200, resp.text
    return resp.json()["attached"]


async def test_the_mission_is_attached_only_with_a_text_and_personal_text_consent(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    assert await attached(client) == {"mission": False, "vision": False}
    await consent(client, personal_text=True)
    assert await attached(client) == {"mission": False, "vision": False}  # no text yet
    patched = await client.patch("/v1/settings", json={"mission": "رسالة"}, headers=auth())
    assert patched.status_code == 200, patched.text
    assert await attached(client) == {"mission": True, "vision": False}
    await consent(client, personal_text=False)
    assert await attached(client) == {"mission": False, "vision": False}
    await consent(client, personal_text=True)
    revoked = await client.delete("/v1/ai/consent", headers=auth())
    assert revoked.status_code == 200
    assert await attached(client) == {"mission": False, "vision": False}


async def test_the_vision_follows_the_same_rule(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await client.patch("/v1/settings", json={"vision": "رؤية", "mission": "  "}, headers=auth())
    await consent(client, personal_text=True)
    assert await attached(client) == {"mission": False, "vision": True}


# --- the stores --------------------------------------------------------------------------------


async def test_the_in_memory_store_follows_the_protocol() -> None:
    store = InMemoryMemoryStore()
    one = await store.add("rule", "أ")
    two = await store.add("note", "ب")
    assert [i.id for i in await store.list()] == [one.id, two.id]
    patched = await store.patch(one.id, {"active": False})
    assert patched is not None and patched.active is False
    assert await store.patch(uuid4(), {"active": True}) is None
    assert await store.delete(two.id) is True
    assert await store.delete(two.id) is False
    for n in range(MAX_MEMORY_ITEMS - 1):
        await store.add("rule", f"ع{n}")
    with pytest.raises(MemoryFull):
        await store.add("rule", "زائدة")
    await store.reset()
    assert await store.list() == []


async def _as_yawmi_api(conn: asyncpg.Connection) -> None:
    await conn.execute("SET ROLE yawmi_api")


async def test_the_yawmi_api_role_can_add_patch_delete_and_reset() -> None:
    """The store's statements run as `yawmi_api` (0003 grants DELETE on `ai_memory`)."""
    admin = await open_goals_pool()
    try:
        url = os.environ["TEST_DATABASE_URL"]
        pool = await asyncpg.create_pool(
            url,
            min_size=1,
            max_size=2,
            setup=_as_yawmi_api,
            server_settings={"search_path": "yawmi", "timezone": "UTC"},
        )
        try:
            assert await pool.fetchval("SELECT current_user") == "yawmi_api"
            store = AsyncpgMemoryStore(pool)
            await store.reset()
            one = await store.add("rule", LENS)
            two = await store.add("note", "ملاحظة")
            assert (await store.patch(one.id, {"active": False, "text": "معدّلة"})).text == "معدّلة"  # type: ignore[union-attr]
            assert await store.delete(two.id) is True
            assert [i.id for i in await store.list()] == [one.id]
            await store.reset()
            assert await store.list() == []
        finally:
            await pool.close()
    finally:
        await admin.execute("DELETE FROM yawmi.ai_memory")
        await admin.close()


def test_memory_messages_are_gender_neutral() -> None:
    from test_insights_routes import _gendered_hit, _gendered_words

    from yawmi.ai.memory import MSG_EMPTY_PATCH, MSG_ITEM_NOT_FOUND, MSG_MEMORY_FULL

    words = _gendered_words()
    for message in (MSG_MEMORY_FULL, MSG_ITEM_NOT_FOUND, MSG_EMPTY_PATCH):
        assert _gendered_hit(message, words) is None, message
