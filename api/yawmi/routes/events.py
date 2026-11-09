"""Event ingestion and pull.

`POST /v1/events` takes a batch of up to 500 events and is idempotent per event id, so a client
that lost the response can resend the whole batch: nothing is stored twice and nothing is
rejected. `GET /v1/events` pages by server receipt time. This module is discovered
automatically (see `yawmi.routes`).

Errors: a malformed event, an unknown type, a naive `occurred_at`, a back-dated `day` older
than 7 days, or a batch over 500 events is a 422 in the app's usual shape
(`{"detail": "طلب غير صالح", "errors": [{"loc": [...], "type": "<code>"}]}`), where `loc` names
the offending event. A batch is accepted or rejected as a whole.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import AwareDatetime

from yawmi.auth.deps import current_device, require_kind
from yawmi.auth.tokens import AccessClaims
from yawmi.db.pool import get_pool
from yawmi.events.models import (
    MAX_BATCH,
    BatchResult,
    EventBatch,
    PullResult,
    clamp_instant,
)
from yawmi.events.project import plan
from yawmi.events.store import AsyncpgEventStore, EventStore, UnknownHabits
from yawmi.routes.devices import ErrorDetail

router = APIRouter(prefix="/v1", tags=["events"])

# `service` tokens revoke devices; they do not log habits, so they cannot post events
SOURCE_KINDS = ("iphone", "watch", "web")
PULL_LIMIT = 500


def get_event_store(request: Request) -> EventStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: EventStore | None = getattr(request.app.state, "events", None)
    return injected if injected is not None else AsyncpgEventStore(get_pool())


EventStoreDep = Annotated[EventStore, Depends(get_event_store)]


@router.post(
    "/events",
    summary="استقبال دفعة أحداث (متكررة الأثر)",
    description=(
        f"حتى {MAX_BATCH} حدثاً في الدفعة. معرّف الحدث هو مفتاح التكرار: إعادة إرسال الدفعة نفسها "
        "لا تضاعف شيئاً ولا تُرفض. `habit_logged` و`habit_skipped` و`habit_vacation` و`focus_ended` "
        "و`breath_ended` تُسقَط أيضاً إلى جداولها؛ بقية الأنواع تُحفظ في الأحداث فقط."
    ),
    responses={
        401: {"model": ErrorDetail, "description": "غير مصرّح"},
        403: {"model": ErrorDetail, "description": "غير مسموح (رمز الخدمة لا يسجّل أحداثاً)"},
        422: {"description": "طلب غير صالح: الدفعة تُرفض كاملة"},
    },
)
async def post_events(
    body: EventBatch,
    claims: Annotated[AccessClaims, Depends(require_kind(*SOURCE_KINDS))],
    store: EventStoreDep,
) -> BatchResult:
    # `device_id` and the habit-log `source` come from the token, never from the body
    planned = plan(body.events, claims.kind)
    try:
        return await store.ingest(claims.sub, planned)
    except UnknownHabits as exc:
        raise RequestValidationError(
            [
                {
                    "type": "unknown_habit",
                    "loc": ("body", "events", index, "payload", "habit_code"),
                    "msg": "unknown habit",
                    "input": None,
                }
                for index in exc.indexes
            ]
        ) from None


@router.get(
    "/events",
    summary="سحب الأحداث بمؤشر زمني",
    description=(
        "مرتبة بوقت الاستلام في الخادم. `next_since` هو وقت استلام آخر حدث مُعاد (أو قيمة `since` "
        "نفسها إن لم يوجد جديد)، فيُمرَّر في الطلب التالي. لا تنقسم الصفحة داخل مجموعة أحداث "
        "تشترك في وقت الاستلام نفسه، فقد تزيد على `limit`. يجب ترميز `+` في `since` بـ`%2B` "
        "أو استعمال `Z`."
    ),
    dependencies=[Depends(current_device)],
    responses={
        401: {"model": ErrorDetail, "description": "غير مصرّح"},
        422: {"description": "طلب غير صالح"},
    },
)
async def pull_events(
    store: EventStoreDep,
    since: Annotated[
        AwareDatetime | None,
        Query(description="أحداث استُلمت بعد هذا الوقت (ISO 8601 بمنطقة زمنية)"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=PULL_LIMIT)] = PULL_LIMIT,
) -> PullResult:
    # a cursor outside 2000..2099 matches nothing or everything: clamp it instead of failing
    events = await store.pull(None if since is None else clamp_instant(since), limit)
    return PullResult(events=events, next_since=events[-1].received_at if events else since)
