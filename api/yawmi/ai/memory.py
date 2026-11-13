"""The visible AI memory (design §7.1, §7.6, §10): what is attached to every AI request.

`yawmi.ai_memory` holds two kinds of item, both written by the user and both shown as text:
a lens (`rule`), a standing instruction on how to read the data, and a note (`note`), a line saved
from an answer. Every active item goes out with every AI request (`yawmi.ai.grounding`); an
inactive one stays listed but is not sent. At most `MAX_MEMORY_ITEMS` items (active or not) of
1 to `MAX_MEMORY_TEXT` characters; adding past the limit raises `MemoryFull`. Deletion is real
(«حذف بنقرة»), and `reset` empties the table.

`MemoryStore` is the seam: Postgres in production (SQL as named constants, planned as
`yawmi_api` by `test_migrations`), `InMemoryMemoryStore` in tests. Adding takes a transaction
advisory lock, so two concurrent adds cannot pass the limit together.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID, uuid4

import asyncpg
from fastapi import Depends, Request
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StringConstraints

from yawmi.db.pool import get_pool
from yawmi.text import check_text

MAX_MEMORY_ITEMS = 20
MAX_MEMORY_TEXT = 300
MEMORY_FULL = "memory_full"
# Every user-visible message of this module (checked for gendered wording by the tests).
MSG_MEMORY_FULL = "الذاكرة ممتلئة: 20 بنداً حدها"
MSG_ITEM_NOT_FOUND = "البند غير موجود"
MSG_EMPTY_PATCH = "لا حقل للتعديل"

MemoryKind = Literal["rule", "note"]


def _storable(value: str) -> str:
    check_text(value, "text_invalid")
    return value


MemoryText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_MEMORY_TEXT),
    AfterValidator(_storable),
]


class MemoryItem(BaseModel):
    id: UUID
    kind: MemoryKind = Field(description="`rule` عدسة يكتبها المستخدم، و`note` ملاحظة حفظها")
    text: str = Field(description="النص كما يُرفق بالطلبات")
    active: bool = Field(description="يُرفق بالطلبات ما دام مفعّلاً")
    created_at: datetime


class MemoryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: MemoryKind = Field(description="`rule` عدسة، أو `note` ملاحظة")
    text: MemoryText = Field(description="من 1 إلى 300 حرف")


class MemoryPatch(BaseModel):
    """At least one field. `active: false` keeps the item listed but stops sending it."""

    model_config = ConfigDict(extra="forbid")

    active: StrictBool = None  # type: ignore[assignment]
    text: MemoryText = None  # type: ignore[assignment]


class MemoryAttached(BaseModel):
    mission: bool = Field(description="«رسالتي» تُرفق بالطلبات: لها نص وموافقة النص الشخصي")
    vision: bool = Field(description="«رؤيتي» تُرفق بالطلبات: لها نص وموافقة النص الشخصي")


class MemoryList(BaseModel):
    items: list[MemoryItem] = Field(description="كل البنود بترتيب إنشائها")
    attached: MemoryAttached


class MemoryFull(Exception):
    """The memory already holds `MAX_MEMORY_ITEMS` items."""


class MemoryStore(Protocol):
    async def list(self) -> list[MemoryItem]:
        """Every item, oldest first."""
        ...

    async def add(self, kind: str, text: str) -> MemoryItem:
        """A new active item; `MemoryFull` when the limit is reached."""
        ...

    async def patch(self, item_id: UUID, changes: dict[str, Any]) -> MemoryItem | None:
        """Apply `active` and/or `text`; `None` when the item does not exist."""
        ...

    async def delete(self, item_id: UUID) -> bool:
        """Delete for good; whether the item existed."""
        ...

    async def reset(self) -> None:
        """Delete every item."""
        ...


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class InMemoryMemoryStore:
    rows: list[MemoryItem] = field(default_factory=list)

    async def list(self) -> list[MemoryItem]:
        return sorted(self.rows, key=lambda r: (r.created_at, str(r.id)))

    async def add(self, kind: str, text: str) -> MemoryItem:
        if len(self.rows) >= MAX_MEMORY_ITEMS:
            raise MemoryFull
        item = MemoryItem(id=uuid4(), kind=kind, text=text, active=True, created_at=_now())  # type: ignore[arg-type]
        self.rows.append(item)
        return item

    async def patch(self, item_id: UUID, changes: dict[str, Any]) -> MemoryItem | None:
        for n, row in enumerate(self.rows):
            if row.id == item_id:
                allowed = {k: v for k, v in changes.items() if k in ("active", "text")}
                self.rows[n] = row.model_copy(update=allowed)
                return self.rows[n]
        return None

    async def delete(self, item_id: UUID) -> bool:
        before = len(self.rows)
        self.rows = [r for r in self.rows if r.id != item_id]
        return len(self.rows) < before

    async def reset(self) -> None:
        self.rows.clear()


_COLUMNS = "id, kind, text, active, created_at"
# two-key advisory lock (the keys spell "YWMI" and 3): serialises adds against the limit
MEMORY_LOCK_KEYS = (0x59574D49, 3)
LOCK_MEMORY = "SELECT pg_advisory_xact_lock($1, $2)"
LIST_MEMORY = f"SELECT {_COLUMNS} FROM yawmi.ai_memory ORDER BY created_at, id"
COUNT_MEMORY = "SELECT count(*) FROM yawmi.ai_memory"
INSERT_MEMORY = (
    "INSERT INTO yawmi.ai_memory (id, kind, text, active, created_at)"
    f" VALUES ($1, $2, $3, TRUE, $4) RETURNING {_COLUMNS}"
)
PATCH_MEMORY = (
    "UPDATE yawmi.ai_memory SET active = coalesce($2, active), text = coalesce($3, text)"
    f" WHERE id = $1 RETURNING {_COLUMNS}"
)
DELETE_MEMORY = "DELETE FROM yawmi.ai_memory WHERE id = $1 RETURNING id"
RESET_MEMORY = "DELETE FROM yawmi.ai_memory"


def _item(row: asyncpg.Record) -> MemoryItem:
    return MemoryItem(
        id=row["id"],
        kind=row["kind"],
        text=row["text"],
        active=row["active"],
        created_at=row["created_at"],
    )


class AsyncpgMemoryStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(self) -> list[MemoryItem]:
        return [_item(r) for r in await self._pool.fetch(LIST_MEMORY)]

    async def add(self, kind: str, text: str) -> MemoryItem:
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(LOCK_MEMORY, *MEMORY_LOCK_KEYS)
            if await conn.fetchval(COUNT_MEMORY) >= MAX_MEMORY_ITEMS:
                raise MemoryFull
            row = await conn.fetchrow(INSERT_MEMORY, uuid4(), kind, text, _now())
        assert row is not None
        return _item(row)

    async def patch(self, item_id: UUID, changes: dict[str, Any]) -> MemoryItem | None:
        row = await self._pool.fetchrow(
            PATCH_MEMORY, item_id, changes.get("active"), changes.get("text")
        )
        return None if row is None else _item(row)

    async def delete(self, item_id: UUID) -> bool:
        return await self._pool.fetchval(DELETE_MEMORY, item_id) is not None

    async def reset(self) -> None:
        await self._pool.execute(RESET_MEMORY)


def get_memory_store(request: Request) -> MemoryStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: MemoryStore | None = getattr(request.app.state, "ai_memory", None)
    return injected if injected is not None else AsyncpgMemoryStore(get_pool())


MemoryStoreDep = Annotated[MemoryStore, Depends(get_memory_store)]


def active_items(items: list[MemoryItem]) -> list[MemoryItem]:
    return [i for i in items if i.active]
