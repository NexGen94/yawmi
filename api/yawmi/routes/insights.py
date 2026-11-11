"""AI routes: `POST /v1/day/close`, `POST /v1/ask`, `GET /v1/reviews`.

The client sends the day's aggregates and the citable sources; the grounded `InsightService`
(see `yawmi.ai.service`) produces at most two lines and cites only the sources it was given.

* `day/close` accepts today and the seven days before it (422 `day_out_of_window` otherwise)
  and is idempotent per day: the first closure is stored and every repeat returns it
  without calling the provider again (a concurrent pair keeps one row).
* `ask` answers one question and stores nothing.
* `reviews` lists stored insights, newest first.

Provider failures never reach the client as a 500 and never carry a provider message or key:
a refusal or a withheld raw-health payload is a 422 (`ai_refusal`, `raw_health_not_allowed`), a
reply still invalid after the repair attempt or any provider failure is a 502, a missing key a 503.
`reviews` is open to device tokens only (`service` tokens get 403), stricter than `GET /v1/events`.
This module is discovered automatically (see `yawmi.routes`).
"""

import json
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, field_validator
from pydantic_core import PydanticCustomError

from yawmi.ai.base import (
    PolicyViolation,
    ProviderError,
    ProviderNotConfigured,
    ProviderRefusal,
)
from yawmi.ai.schema import InsightRequest, InsightResponse, Source
from yawmi.ai.service import InsightInvalid, InsightService, build_provider, request_hash
from yawmi.ai.store import (
    CLOSURE_KIND,
    AsyncpgInsightStore,
    InsightStore,
    StoredInsight,
    new_insight,
)
from yawmi.auth.deps import SettingsDep, require_kind
from yawmi.auth.tokens import AccessClaims
from yawmi.db.pool import get_pool
from yawmi.domain.days import day_key
from yawmi.errors import ErrorDetail
from yawmi.events import models as event_models
from yawmi.events.project import MAX_BACKDATE_DAYS
from yawmi.text import check_text

router = APIRouter(prefix="/v1", tags=["insights"])

# `service` tokens revoke devices; they have no day to close or question to ask
SOURCE_KINDS = ("iphone", "watch", "web")
# Caps on what a client may send (all 422 when exceeded):
#   question <= 500 characters; context <= 16 KiB serialised; <= 50 sources, each with
#   id <= 64, kind <= 32 and text <= 500 characters. A day's aggregates fit well inside them.
MAX_SOURCES = 50
MAX_QUESTION = 500
MAX_CONTEXT_BYTES = 16 * 1024
MAX_SOURCE_ID = 64
MAX_SOURCE_KIND = 32
MAX_SOURCE_TEXT = 500
TEXT_INVALID = "text_invalid"

# Every user-visible message of this module (checked for gendered wording by the tests).
MSG_REFUSAL = "تعذّر الرد على هذا الطلب"
MSG_RAW_HEALTH = "لا تُرسل بيانات صحية خام إلى هذا المزوّد"
MSG_INVALID_REPLY = "تعذّر إنتاج ردّ صالح؛ يمكن المحاولة لاحقاً"
MSG_NOT_CONFIGURED = "الخدمة الذكية غير مفعّلة"
MSG_UNAVAILABLE = "تعذّر الاتصال بالخدمة الذكية؛ يمكن المحاولة لاحقاً"
USER_MESSAGES = frozenset(
    {MSG_REFUSAL, MSG_RAW_HEALTH, MSG_INVALID_REPLY, MSG_NOT_CONFIGURED, MSG_UNAVAILABLE}
)


def get_insight_store(request: Request) -> InsightStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: InsightStore | None = getattr(request.app.state, "insights_store", None)
    return injected if injected is not None else AsyncpgInsightStore(get_pool())


def get_insight_service(request: Request, settings: SettingsDep) -> InsightService:
    """A service injected into the app (tests), else the provider the settings select."""
    injected: InsightService | None = getattr(request.app.state, "insights", None)
    if injected is not None:
        return injected
    try:
        return InsightService(build_provider(settings), settings)
    except ProviderNotConfigured:
        return InsightService(_Unconfigured(), settings)


class _Unconfigured:
    """Stands in for a provider without a key, so the route answers 503 rather than failing."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        raise ProviderNotConfigured("no api key")


StoreDep = Annotated[InsightStore, Depends(get_insight_store)]
ServiceDep = Annotated[InsightService, Depends(get_insight_service)]
DeviceDep = Annotated[AccessClaims, Depends(require_kind(*SOURCE_KINDS))]


class ClientSource(Source):
    """A citable fact from the client, with bounded field sizes."""

    id: str = Field(max_length=MAX_SOURCE_ID)
    kind: str = Field(max_length=MAX_SOURCE_KIND)
    text: str = Field(max_length=MAX_SOURCE_TEXT)


def _clean_text(value: Any) -> Any:
    check_text(value, TEXT_INVALID)
    return value


def _bounded_context(value: dict[str, Any]) -> dict[str, Any]:
    _clean_text(value)
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except ValueError:
        raise PydanticCustomError("context_not_finite", "الملخصات تحوي رقماً غير منتهٍ") from None
    if size > MAX_CONTEXT_BYTES:
        raise PydanticCustomError("context_too_large", "الملخصات أكبر من الحد المسموح")
    return value


class _ClientInput(BaseModel):
    """Shared checks for the free text a client sends: storable, encodable, bounded."""

    day: date
    # TODO(#19): context and sources are client-supplied aggregates until the server builds them
    # from stored data (tasks 8b/10b); then client sources are ignored for day/close.
    context: dict[str, Any] = Field(default_factory=dict, description="ملخصات اليوم المجمّعة")
    sources: list[ClientSource] = Field(default_factory=list, max_length=MAX_SOURCES)

    @field_validator("context")
    @classmethod
    def _context_ok(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _bounded_context(value)

    @field_validator("sources")
    @classmethod
    def _sources_ok(cls, value: list[ClientSource]) -> list[ClientSource]:
        _clean_text([s.model_dump() for s in value])
        return value


class DayCloseRequest(_ClientInput):
    pass


class AskRequest(_ClientInput):
    question: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_QUESTION)
    ]

    @field_validator("question")
    @classmethod
    def _question_ok(cls, value: str) -> str:
        return _clean_text(value)


class InsightOut(InsightResponse):
    """A stored insight: the validated reply plus its identity."""

    id: UUID
    kind: str
    day: date
    created_at: datetime


class ReviewList(BaseModel):
    items: list[InsightOut]


def _out(row: StoredInsight) -> InsightOut:
    return InsightOut(
        **row.response.model_dump(),
        id=row.id,
        kind=row.kind,
        day=row.day,
        created_at=row.created_at,
    )


def _check_day(day: date, tz: str) -> None:
    if day > day_key(event_models.server_now(), tz):
        raise RequestValidationError(
            [{"type": "day_in_future", "loc": ("body", "day"), "msg": "future day", "input": None}]
        )


def _check_close_window(day: date, tz: str) -> None:
    """`day/close` reaches back as far as an event may (`MAX_BACKDATE_DAYS`, D-065 §5)."""
    oldest = day_key(event_models.server_now(), tz) - timedelta(days=MAX_BACKDATE_DAYS)
    if day < oldest:
        raise RequestValidationError(
            [{"type": "day_out_of_window", "loc": ("body", "day"), "msg": "too old", "input": None}]
        )


def _problem(status: int, detail: str, code: str) -> JSONResponse:
    """The app's error shape; `code` is ours, never text from a provider."""
    body = {"detail": detail, "errors": [{"loc": ["body"], "type": code}]}
    return JSONResponse(status_code=status, content=body)


async def _generate(service: InsightService, req: InsightRequest) -> InsightResponse | JSONResponse:
    try:
        return await service.generate(req)
    except ProviderRefusal:
        return _problem(422, MSG_REFUSAL, "ai_refusal")
    except PolicyViolation:
        return _problem(422, MSG_RAW_HEALTH, "raw_health_not_allowed")
    except InsightInvalid:
        return _problem(502, MSG_INVALID_REPLY, "ai_invalid_reply")
    except ProviderNotConfigured:
        return _problem(503, MSG_NOT_CONFIGURED, "ai_not_configured")
    except ProviderError:  # includes empty/malformed replies, transport errors, truncation
        return _problem(502, MSG_UNAVAILABLE, "ai_unavailable")


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorDetail, "description": "غير مصرّح"},
    403: {"model": ErrorDetail, "description": "غير مسموح (رمز الخدمة)"},
    422: {"description": "طلب غير صالح، أو امتنع النموذج عن الرد"},
    502: {"description": "تعذّر الحصول على ردّ صالح من المزوّد"},
    503: {"description": "مفتاح المزوّد غير مضبوط"},
}


@router.post(
    "/day/close",
    response_model=InsightOut,
    summary="إغلاق اليوم بملخص من سطرين (متكرر الأثر)",
    description=(
        "يستلم ملخصات اليوم ومصادره، ويعيد ملخصاً من سطرين كحد أقصى لا يستشهد إلا بمصادر الطلب. "
        "يُقبل اليوم الحالي والأيام السبعة قبله فقط (`day_out_of_window` لما قبلها). "
        "أول إغلاق لليوم يُحفظ، وكل تكرار لليوم نفسه يعيده دون استدعاء المزوّد. "
        "الملخصات والمصادر يرسلها العميل حالياً إلى أن يبنيها الخادم (المهمتان 8b و10b)."
    ),
    responses=_ERRORS,
)
async def close_day(
    body: DayCloseRequest, _: DeviceDep, store: StoreDep, service: ServiceDep, settings: SettingsDep
) -> InsightOut | JSONResponse:
    _check_day(body.day, settings.tz)
    _check_close_window(body.day, settings.tz)
    existing = await store.get_closure(body.day)
    if existing is not None:
        return _out(existing)
    req = InsightRequest(
        kind=CLOSURE_KIND, day=body.day, context=body.context, sources=body.sources
    )
    result = await _generate(service, req)
    if isinstance(result, JSONResponse):
        return result
    row = new_insight(
        CLOSURE_KIND,
        body.day,
        settings.ai_provider,
        settings.model_daily,
        request_hash(req.model_dump(mode="json")),
        result,
    )
    return _out(await store.save_closure(row))


@router.post(
    "/ask",
    response_model=InsightResponse,
    summary="سؤال واحد بجواب من سطرين",
    description="الجواب لا يستشهد إلا بمصادر الطلب. لا يُحفظ شيء.",
    responses=_ERRORS,
)
async def ask(
    body: AskRequest, _: DeviceDep, service: ServiceDep, settings: SettingsDep
) -> InsightResponse | JSONResponse:
    _check_day(body.day, settings.tz)
    req = InsightRequest(
        kind="ask", day=body.day, question=body.question, context=body.context, sources=body.sources
    )
    return await _generate(service, req)


@router.get(
    "/reviews",
    summary="المراجعات المحفوظة، الأحدث أولاً",
    description="`kind` إما `weekly` (الافتراضي) أو `evening`؛ و`before` يعيد ما قبل يوم معيّن.",
    responses={401: _ERRORS[401], 403: _ERRORS[403], 422: _ERRORS[422]},
)
async def list_reviews(
    _: DeviceDep,
    store: StoreDep,
    kind: Annotated[str, Query(pattern="^(evening|weekly)$")] = "weekly",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: Annotated[date | None, Query(description="أيام قبل هذا اليوم فقط")] = None,
) -> ReviewList:
    return ReviewList(items=[_out(r) for r in await store.list_reviews(kind, limit, before)])
