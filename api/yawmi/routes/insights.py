"""AI routes: `POST /v1/day/close`, `POST /v1/ask`, `GET /v1/reviews`.

The client sends the day's aggregates and the citable sources; the grounded `InsightService`
(see `yawmi.ai.service`) produces at most two lines and cites only the sources it was given.

* `day/close` is idempotent per day: the first closure is stored and every repeat returns it
  without calling the provider again (a concurrent pair keeps one row).
* `ask` answers one question and stores nothing.
* `reviews` lists stored insights, newest first.

Provider failures never reach the client as a 500 and never carry a provider message or key:
a refusal or a withheld raw-health payload is a 422 (`ai_refusal`, `raw_health_not_allowed`), a
reply still invalid after the repair attempt or any provider failure is a 502, a missing key a 503.
This module is discovered automatically (see `yawmi.routes`).
"""

from datetime import date, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

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
from yawmi.events import models as event_models
from yawmi.routes.devices import ErrorDetail

router = APIRouter(prefix="/v1", tags=["insights"])

# `service` tokens revoke devices; they have no day to close or question to ask
SOURCE_KINDS = ("iphone", "watch", "web")
MAX_SOURCES = 50
MAX_QUESTION = 500
RIYADH_OFFSET = timedelta(hours=3)  # UTC+3, no daylight saving


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


class DayCloseRequest(BaseModel):
    day: date
    context: dict[str, Any] = Field(default_factory=dict, description="ملخصات اليوم المجمّعة")
    sources: list[Source] = Field(default_factory=list, max_length=MAX_SOURCES)


class AskRequest(BaseModel):
    day: date
    question: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_QUESTION)
    ]
    context: dict[str, Any] = Field(default_factory=dict)
    sources: list[Source] = Field(default_factory=list, max_length=MAX_SOURCES)


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


def _riyadh_today() -> date:
    return (event_models.server_now() + RIYADH_OFFSET).date()


def _check_day(day: date) -> None:
    if day > _riyadh_today():
        raise RequestValidationError(
            [{"type": "day_in_future", "loc": ("body", "day"), "msg": "future day", "input": None}]
        )


def _problem(status: int, detail: str, code: str) -> JSONResponse:
    """The app's error shape; `code` is ours, never text from a provider."""
    body = {"detail": detail, "errors": [{"loc": ["body"], "type": code}]}
    return JSONResponse(status_code=status, content=body)


async def _generate(service: InsightService, req: InsightRequest) -> InsightResponse | JSONResponse:
    try:
        return await service.generate(req)
    except ProviderRefusal:
        return _problem(422, "تعذّر الرد على هذا الطلب", "ai_refusal")
    except PolicyViolation:
        return _problem(422, "لا تُرسل بيانات صحية خام إلى هذا المزوّد", "raw_health_not_allowed")
    except InsightInvalid:
        return _problem(502, "تعذّر إنتاج ردّ صالح، حاول لاحقاً", "ai_invalid_reply")
    except ProviderNotConfigured:
        return _problem(503, "الخدمة الذكية غير مفعّلة", "ai_not_configured")
    except ProviderError:  # includes empty/malformed replies, transport errors, truncation
        return _problem(502, "تعذّر الاتصال بالخدمة الذكية، حاول لاحقاً", "ai_unavailable")


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
        "أول إغلاق لليوم يُحفظ، وكل تكرار لليوم نفسه يعيده دون استدعاء المزوّد."
    ),
    responses=_ERRORS,
)
async def close_day(
    body: DayCloseRequest, _: DeviceDep, store: StoreDep, service: ServiceDep, settings: SettingsDep
) -> InsightOut | JSONResponse:
    _check_day(body.day)
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
    body: AskRequest, _: DeviceDep, service: ServiceDep
) -> InsightResponse | JSONResponse:
    _check_day(body.day)
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
