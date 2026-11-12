"""`GET /v1/journal` and `GET /v1/mood`: journal entries and mood logs in a bounded range."""

from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from yawmi.auth.deps import require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.journal import check_date_range
from yawmi.journal.store import AsyncpgJournalReader, JournalReader

READER_KINDS = ("iphone", "watch", "web")

router = APIRouter(
    prefix="/v1",
    tags=["journal"],
    dependencies=[Depends(require_kind(*READER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_journal_reader(request: Request) -> JournalReader:
    """The reader injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: JournalReader | None = getattr(request.app.state, "journal", None)
    return injected if injected is not None else AsyncpgJournalReader(get_pool())


JournalReaderDep = Annotated[JournalReader, Depends(get_journal_reader)]


class JournalEntryOut(BaseModel):
    day: date
    part: Literal["morning", "evening"]
    answers: dict[str, Any]
    logged_at: datetime


class JournalList(BaseModel):
    entries: list[JournalEntryOut]


class MoodLogOut(BaseModel):
    day: date
    score: int
    feelings: list[str]
    activities: list[str]


class MoodList(BaseModel):
    logs: list[MoodLogOut]


@router.get(
    "/journal",
    summary="يوميات الصباح والمساء في مدى زمني",
    description="الصفوف المسقطة من أحداث `journal_saved` بين `from` و`to` (400 يوم على الأكثر).",
    responses={**INVALID},
)
async def list_journal(
    reader: JournalReaderDep,
    first: Annotated[date, Query(alias="from", description="أول يوم في المدى")],
    last: Annotated[date, Query(alias="to", description="آخر يوم في المدى")],
) -> JournalList:
    check_date_range(first, last)
    rows = await reader.entries(first, last)
    return JournalList(
        entries=[
            JournalEntryOut(
                day=r.day,
                part=r.part,
                answers=r.answers,
                logged_at=r.logged_at,
            )
            for r in rows
        ]
    )


@router.get(
    "/mood",
    summary="سجلات المزاج في مدى زمني",
    description="الصفوف المسقطة من أحداث `mood_logged` بين `from` و`to` (400 يوم على الأكثر).",
    responses={**INVALID},
)
async def list_mood(
    reader: JournalReaderDep,
    first: Annotated[date, Query(alias="from", description="أول يوم في المدى")],
    last: Annotated[date, Query(alias="to", description="آخر يوم في المدى")],
) -> MoodList:
    check_date_range(first, last)
    rows = await reader.moods(first, last)
    return MoodList(
        logs=[
            MoodLogOut(
                day=r.day,
                score=r.score,
                feelings=r.feelings,
                activities=r.activities,
            )
            for r in rows
        ]
    )
