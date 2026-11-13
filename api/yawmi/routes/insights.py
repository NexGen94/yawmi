"""AI routes: `POST /v1/day/close`, `POST /v1/ask`, `GET /v1/reviews`, and
`POST /v1/insights/morning`, `weekly` and `deeper`.

The server builds the grounding (design §10, I-7): the client sends the day (`day/close`) or the
question and the range (`ask`), never a context or sources (422 `extra_forbidden`). The grounded
`InsightService` produces at most `ai_lines` lines and cites only the sources it was given; the
reply comes back with the cards of the cited sources and their days (`GroundedInsight`).

* Every route that calls a provider needs a standing consent for the configured provider
  (`require_consent`): without one it is a 403 `ai_consent_required` and nothing is called.
* `day/close` accepts today and the seven days before it (422 `day_out_of_window` otherwise)
  and is idempotent per day: the first closure is stored and every repeat returns it without
  calling the provider again (a concurrent pair keeps one row). With `regenerate` the provider is
  called only when the sources changed (their `request_hash` differs), and the row is renewed.
* `ask` answers one question over `7d`, `30d` or the current cycle, and stores nothing.
* `insights/morning` is one row per day (seven days ending on the day, up to three priorities);
  `GET /v1/today` shows it. `insights/weekly` is one row per week, its key the week's first day
  (`week_key`), over the whole week with sources up to today, on the weekly model; it is the one
  AI route a `service` token may call (a scheduled review). Unlike `day/close`, both rebuild the
  request on every call and renew the row in place when its fingerprint changed (fix round 1,
  M-5/M-6): a new journal as the week moves on, or a removed lens. `insights/deeper` returns one
  question and up to three alternative questions (the provider's `priorities`, moved to
  `options`) and stores nothing; its question is null only for a fixed line.
* Every request carries the active lenses and saved notes of the visible memory (`ai_memory`) as
  the request's own `memory` block, outside the source cap.
* The two fixed lines of the prompt (out of scope, no data) are valid replies of every kind.
* `reviews` lists stored insights, newest first (no provider call, no consent needed).

Provider failures never reach the client as a 500 and never carry a provider message or key:
a refusal or a withheld raw-health payload is a 422 (`ai_refusal`, `raw_health_not_allowed`), a
reply still invalid after the repair attempt or any provider failure is a 502, a missing key a 503.
`reviews` is open to device tokens only (`service` tokens get 403), stricter than `GET /v1/events`.
This module is discovered automatically (see `yawmi.routes`).
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, field_validator

from yawmi.ai.base import (
    PolicyViolation,
    ProviderError,
    ProviderNotConfigured,
    ProviderRefusal,
)
from yawmi.ai.cards import DeeperOut, GroundedInsight, InsightOut, cards_for, cited_ids, grounded
from yawmi.ai.consent import Consent, ConsentDep, ConsentRoute, problem
from yawmi.ai.grounding import Grounding, Range, build_grounding, span_for
from yawmi.ai.memory import MemoryItem, MemoryStore, MemoryStoreDep
from yawmi.ai.reader import (
    AsyncpgSessionReader,
    GroundingReader,
    SessionReader,
    StoreGroundingReader,
)
from yawmi.ai.schema import InsightKind, InsightRequest, InsightResponse
from yawmi.ai.service import (
    REFUSALS,
    InsightInvalid,
    InsightService,
    build_provider,
    is_fixed_reply,
    request_hash,
)
from yawmi.ai.store import (
    CLOSURE_KIND,
    MORNING_KIND,
    WEEKLY_KIND,
    AsyncpgInsightStore,
    InsightStore,
    StoredInsight,
    insight_out,
    new_insight,
    week_key,
)
from yawmi.auth.deps import SettingsDep, require_kind
from yawmi.auth.tokens import AccessClaims
from yawmi.db.pool import get_pool
from yawmi.domain.days import day_key
from yawmi.errors import ErrorDetail, ValidationErrorBody
from yawmi.events import models as event_models
from yawmi.events.project import MAX_BACKDATE_DAYS
from yawmi.goals.edits_store import AsyncpgEditStore, EditStore
from yawmi.journal.store import AsyncpgJournalReader, JournalReader
from yawmi.prefs.models import SettingsOut
from yawmi.prefs.store import AsyncpgPrefsStore, PrefsStore
from yawmi.settings import Settings
from yawmi.text import check_text
from yawmi.today.reader import AsyncpgTodayReader, TodayReader

router = APIRouter(prefix="/v1", tags=["insights"], route_class=ConsentRoute)

# `service` tokens revoke devices; they have no day to close or question to ask
SOURCE_KINDS = ("iphone", "watch", "web")
MAX_QUESTION = 500  # the question a client asks; the reply's own question is capped at 200
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


def get_prefs(request: Request) -> PrefsStore:
    """The settings store injected into the app (tests), else Postgres."""
    injected: PrefsStore | None = getattr(request.app.state, "prefs", None)
    return injected if injected is not None else AsyncpgPrefsStore(get_pool())


def get_grounding_reader(request: Request) -> GroundingReader:
    """The readers the other routes use (each injected in tests, else Postgres), composed. The
    goal edits are laid over the mirror as in `GET /v1/today`: a test that injects only a mirror
    reader (no edit store) reads the mirror as it is."""
    state = request.app.state
    today: TodayReader | None = getattr(state, "today", None)
    journal: JournalReader | None = getattr(state, "journal", None)
    sessions: SessionReader | None = getattr(state, "sessions", None)
    edits: EditStore | None = getattr(state, "goal_edits", None)
    if edits is None and today is None:
        edits = AsyncpgEditStore(get_pool())
    return StoreGroundingReader(
        today=today if today is not None else AsyncpgTodayReader(get_pool()),
        journal=journal if journal is not None else AsyncpgJournalReader(get_pool()),
        sessions=sessions if sessions is not None else AsyncpgSessionReader(get_pool()),
        edits=edits,
    )


class _Unconfigured:
    """Stands in for a provider without a key, so the route answers 503 rather than failing."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        raise ProviderNotConfigured("no api key")


StoreDep = Annotated[InsightStore, Depends(get_insight_store)]
ServiceDep = Annotated[InsightService, Depends(get_insight_service)]
PrefsDep = Annotated[PrefsStore, Depends(get_prefs)]
ReaderDep = Annotated[GroundingReader, Depends(get_grounding_reader)]
DeviceDep = Annotated[AccessClaims, Depends(require_kind(*SOURCE_KINDS))]
# the weekly review may also be asked for by the scheduler, with a `service` token
WeeklyCallerDep = Annotated[AccessClaims, Depends(require_kind(*SOURCE_KINDS, "service"))]


def _clean_text(value: Any) -> Any:
    check_text(value, TEXT_INVALID)
    return value


class DayCloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day: date
    regenerate: StrictBool = Field(
        default=False,
        description="إعادة التوليد: يُنادى المزوّد فقط إن تغيّرت المصادر عن المخزَّن",
    )


class InsightDayRequest(BaseModel):
    """The day of a stored morning or weekly insight. No context and no sources (I-7)."""

    model_config = ConfigDict(extra="forbid")

    day: date
    regenerate: StrictBool = Field(
        default=False,
        description="إعادة التوليد: يُنادى المزوّد فقط إن تغيّرت المصادر عن المخزَّن",
    )


class DeeperRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day: date


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_QUESTION)
    ]
    range: Range = Field(default="7d", description="المدى: سبعة أيام أو ثلاثون أو الدورة الجارية")

    @field_validator("question")
    @classmethod
    def _question_ok(cls, value: str) -> str:
        return _clean_text(value)


class ReviewList(BaseModel):
    items: list[InsightOut]


def _out(row: StoredInsight) -> InsightOut:
    return insight_out(row)


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


async def _generate(
    service: InsightService, req: InsightRequest, max_lines: int
) -> InsightResponse | JSONResponse:
    try:
        return await service.generate(req, max_lines=max_lines)
    except ProviderRefusal:
        return problem(422, MSG_REFUSAL, "ai_refusal")
    except PolicyViolation:
        return problem(422, MSG_RAW_HEALTH, "raw_health_not_allowed")
    except InsightInvalid:
        return problem(502, MSG_INVALID_REPLY, "ai_invalid_reply")
    except ProviderNotConfigured:
        return problem(503, MSG_NOT_CONFIGURED, "ai_not_configured")
    except ProviderError:  # includes empty/malformed replies, transport errors, truncation
        return problem(502, MSG_UNAVAILABLE, "ai_unavailable")


async def ground(
    kind: InsightKind,
    day: date,
    range_: Range,
    reader: GroundingReader,
    prefs: SettingsOut,
    consent: Consent,
    settings: Settings,
    question: str | None = None,
    memory: Sequence[MemoryItem] = (),
    request_day: date | None = None,
) -> tuple[InsightRequest, Grounding]:
    """The provider request of `kind` for `day` over `range_` (a named range or an explicit
    span), with the active `memory` items (lenses and saved notes) as their own block, and its
    grounding. `request_day` (the weekly key) replaces `day` in the request when given."""
    if isinstance(range_, tuple):
        span = range_
    else:
        span = span_for(range_, day, await reader.cycles())
    grounding = await build_grounding(
        kind, day, span, reader, prefs, consent, week_start=settings.week_start, memory=memory
    )
    req = InsightRequest(
        kind=kind,
        day=request_day or day,
        question=question,
        context=grounding.context,
        sources=grounding.sources,
        memory=grounding.memory,
    )
    return req, grounding


@dataclass(frozen=True)
class _Deps:
    """What a stored insight needs, gathered from one route's dependencies."""

    consent: Consent
    store: InsightStore
    service: InsightService
    settings: Settings
    reader: GroundingReader
    prefs: PrefsStore
    memory: MemoryStore


def _provider_failed(result: JSONResponse) -> bool:
    """A 5xx, or the provider's refusal (`ai_refusal`); not our own raw-health guard."""
    if result.status_code >= 500:
        return True
    errors = json.loads(result.body).get("errors") or [{}]
    return errors[0].get("type") == "ai_refusal"


async def _stored_insight(
    deps: _Deps,
    kind: InsightKind,
    key: date,
    day: date,
    range_: Range | tuple[date, date],
    regenerate: bool,
    renew_on_change: bool = False,
) -> InsightOut | JSONResponse:
    """The stored insight of `kind` under `key` (first writer wins), made for `day` over `range_`
    when none is stored. With `regenerate`, or on every call with `renew_on_change`, the request
    is built again and the provider is called only when it changed (its `request_hash`, which
    covers the sources and the memory block); the row is then renewed in place. A renewal that
    nobody asked for (`renew_on_change` without `regenerate`) whose provider call fails with a
    5xx or a refusal returns the stored row with a 200; with `regenerate` the error stays
    (ruling N-2)."""
    existing = await deps.store.get_for_day(kind, key)
    if existing is not None and not (regenerate or renew_on_change):
        return _out(existing)
    prefs = await deps.prefs.get()
    req, grounding = await ground(
        kind,
        day,
        range_,
        deps.reader,
        prefs,
        deps.consent,
        deps.settings,
        memory=await deps.memory.list(),
        request_day=key,
    )
    digest = request_hash(req.model_dump(mode="json"))
    if existing is not None and existing.request_hash == digest:
        return _out(existing)
    result = await _generate(deps.service, req, prefs.ai_lines)
    if isinstance(result, JSONResponse):
        if existing is not None and renew_on_change and not regenerate and _provider_failed(result):
            # ruling N-2 (and its extension to a refusal): a renewal nobody asked for failed on
            # the provider's side, and the stored row is still a valid reply: it must not be hidden
            return _out(existing)
        return result
    model = deps.settings.model_weekly if kind == WEEKLY_KIND else deps.settings.model_daily
    row = new_insight(
        kind,
        key,
        deps.settings.ai_provider,
        model,
        digest,
        result,
        cards_for(cited_ids(result), grounding),
    )
    if existing is not None:
        return _out(await deps.store.replace(existing.id, row))
    return _out(await deps.store.save_first(row))


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorDetail, "description": "غير مصرّح"},
    403: {
        "model": ValidationErrorBody | ErrorDetail,
        "description": "غير مسموح (رمز الخدمة)، أو لا موافقة سارية (`ai_consent_required`)",
    },
    422: {"description": "طلب غير صالح، أو امتنع النموذج عن الرد"},
    502: {"model": ValidationErrorBody, "description": "تعذّر الحصول على ردّ صالح من المزوّد"},
    503: {"model": ValidationErrorBody, "description": "مفتاح المزوّد غير مضبوط"},
}


@router.post(
    "/day/close",
    response_model=InsightOut,
    summary="إغلاق اليوم بملخص من سطرين (متكرر الأثر)",
    description=(
        "يبني الخادم ملخصات اليوم ومصادره من البيانات المخزّنة (سبعة أيام تنتهي باليوم)، ويعيد "
        "ملخصاً لا يتجاوز `ai_lines` سطراً لا يستشهد إلا بتلك المصادر، مع بطاقاتها وأيامها. "
        "يُقبل اليوم الحالي والأيام السبعة قبله فقط (`day_out_of_window` لما قبلها). "
        "أول إغلاق لليوم يُحفظ، وكل تكرار يعيده دون استدعاء المزوّد. ومع `regenerate` يُستدعى "
        "المزوّد فقط إن تغيّرت المصادر، ويُستبدل الصف. يحتاج موافقة سارية للمزوّد الحالي."
    ),
    responses=_ERRORS,
)
async def close_day(
    body: DayCloseRequest,
    _: DeviceDep,
    consent: ConsentDep,
    store: StoreDep,
    service: ServiceDep,
    settings: SettingsDep,
    reader: ReaderDep,
    prefs_store: PrefsDep,
    memory: MemoryStoreDep,
) -> InsightOut | JSONResponse:
    _check_day(body.day, settings.tz)
    _check_close_window(body.day, settings.tz)
    deps = _Deps(consent, store, service, settings, reader, prefs_store, memory)
    return await _stored_insight(deps, CLOSURE_KIND, body.day, body.day, "7d", body.regenerate)


@router.post(
    "/ask",
    response_model=GroundedInsight,
    summary="سؤال واحد بجواب من سطرين",
    description=(
        "يرسل العميل السؤال والمدى وحدهما (`7d` افتراضاً، أو `30d`، أو `cycle` للدورة الجارية). "
        "يبني الخادم المصادر لذلك المدى، والجواب لا يستشهد إلا بها، ويعود مع بطاقاتها وأيامها. "
        "لا يُحفظ شيء. يحتاج موافقة سارية للمزوّد الحالي."
    ),
    responses=_ERRORS,
)
async def ask(
    body: AskRequest,
    _: DeviceDep,
    consent: ConsentDep,
    service: ServiceDep,
    settings: SettingsDep,
    reader: ReaderDep,
    prefs_store: PrefsDep,
    memory: MemoryStoreDep,
) -> GroundedInsight | JSONResponse:
    day = day_key(event_models.server_now(), settings.tz)
    prefs = await prefs_store.get()
    req, grounding = await ground(
        "ask",
        day,
        body.range,
        reader,
        prefs,
        consent,
        settings,
        question=body.question,
        memory=await memory.list(),
    )
    result = await _generate(service, req, prefs.ai_lines)
    if isinstance(result, JSONResponse):
        return result
    return grounded(result, cards_for(cited_ids(result), grounding))


@router.post(
    "/insights/morning",
    response_model=InsightOut,
    summary="ملخص الصباح: سطران وحتى ثلاث أولويات (متكرر الأثر)",
    description=(
        "يبني الخادم المصادر من البيانات المخزّنة (سبعة أيام تنتهي باليوم) مع العدسات والملاحظات "
        "المفعّلة، ويعيد `ai_lines` سطراً على الأكثر وحتى ثلاث أولويات مقترحة، كل منها من مصدر "
        "معطى، مع بطاقات المصادر المستشهد بها. يُحفظ صف واحد لليوم ويعرضه `GET /v1/today`. كل "
        "طلب يبني المصادر والذاكرة من جديد: إن لم تتغيّر بصمتها يُعاد المخزَّن دون استدعاء "
        "المزوّد، وإن تغيّرت (سجل جديد، أو عدسة حُذفت) يُستدعى المزوّد ويُستبدل الصف في مكانه، "
        "و`regenerate` بالأثر نفسه، لكن إن فشل تجديد لم يُطلب (خطأ من المزوّد أو امتناع) عاد الصف "
        "المخزَّن، ومع `regenerate` يبقى الخطأ. السطر الثابت («خارج النطاق» أو «لا بيانات كافية») رد صالح. "
        "يُقبل اليوم الحالي والأيام السبعة قبله. يحتاج موافقة سارية للمزوّد الحالي، ورمز الخدمة "
        "مرفوض."
    ),
    responses=_ERRORS,
)
async def morning_insight(
    body: InsightDayRequest,
    _: DeviceDep,
    consent: ConsentDep,
    store: StoreDep,
    service: ServiceDep,
    settings: SettingsDep,
    reader: ReaderDep,
    prefs_store: PrefsDep,
    memory: MemoryStoreDep,
) -> InsightOut | JSONResponse:
    _check_day(body.day, settings.tz)
    _check_close_window(body.day, settings.tz)
    deps = _Deps(consent, store, service, settings, reader, prefs_store, memory)
    return await _stored_insight(
        deps, MORNING_KIND, body.day, body.day, "7d", body.regenerate, renew_on_change=True
    )


@router.post(
    "/insights/weekly",
    response_model=InsightOut,
    summary="المراجعة الأسبوعية: الموضوع المتكرر وأيامه (متكرر الأثر لكل أسبوع)",
    description=(
        "مفتاحها أول يوم في الأسبوع الذي يحوي `day`، فأي يوم من الأسبوع يعيد الصف نفسه، و`day` "
        "في الرد هو المفتاح. المدى الأسبوع كله، والمصادر حتى اليوم الحالي، والنموذج الأسبوعي. "
        "سطر يسمّي موضوعاً يتكرر في اليوميات ويستشهد بمصدرين مختلفين من `journal:*` على الأقل "
        "متى وُجدا، وإلا إصلاح واحد ثم 502، والسطر الثابت («خارج النطاق» أو «لا بيانات كافية») "
        "رد صالح. كل طلب يبني المصادر والذاكرة من جديد: بصمة متغيّرة (يوميات جديدة مع تقدّم "
        "الأسبوع) تستدعي المزوّد وتستبدل الصف في مكانه، وإلا يُعاد المخزَّن، و`regenerate` "
        "بالأثر نفسه، لكن إن فشل تجديد لم يُطلب (خطأ من المزوّد أو امتناع) عاد الصف المخزَّن، ومع "
        "`regenerate` يبقى الخطأ. يُقبل اليوم الحالي والأيام السبعة قبله. يقبل رمز الخدمة أيضاً، ويحتاج "
        "موافقة سارية للمزوّد الحالي."
    ),
    responses=_ERRORS,
)
async def weekly_insight(
    body: InsightDayRequest,
    _: WeeklyCallerDep,
    consent: ConsentDep,
    store: StoreDep,
    service: ServiceDep,
    settings: SettingsDep,
    reader: ReaderDep,
    prefs_store: PrefsDep,
    memory: MemoryStoreDep,
) -> InsightOut | JSONResponse:
    _check_day(body.day, settings.tz)
    _check_close_window(body.day, settings.tz)
    key = week_key(body.day, settings.week_start)
    last = key + timedelta(days=6)
    upto = min(last, day_key(event_models.server_now(), settings.tz))
    deps = _Deps(consent, store, service, settings, reader, prefs_store, memory)
    return await _stored_insight(
        deps, WEEKLY_KIND, key, upto, (key, last), body.regenerate, renew_on_change=True
    )


@router.post(
    "/insights/deeper",
    response_model=DeeperOut,
    summary="التعمّق: سؤال واحد وحتى ثلاثة أسئلة بديلة",
    description=(
        "يعيد سؤال تأمل واحداً من مصادر الأيام السبعة المنتهية باليوم، وحتى ثلاثة أسئلة بديلة في "
        "`options` (عنوان كل منها حتى 80 حرفاً، ومصدره من المصادر المعطاة). لا يُحفظ شيء، فكل "
        "طلب يستدعي المزوّد. `question` بـ`null` و`options` فارغة فقط حين يكون الرد أحد السطرين "
        "الثابتين، و`refusal` يسمّيه حينها (`out_of_scope` أو `no_data`). يُقبل اليوم الحالي "
        "والأيام السبعة قبله. يحتاج موافقة سارية للمزوّد الحالي، ورمز الخدمة مرفوض."
    ),
    responses=_ERRORS,
)
async def deeper_insight(
    body: DeeperRequest,
    _: DeviceDep,
    consent: ConsentDep,
    service: ServiceDep,
    settings: SettingsDep,
    reader: ReaderDep,
    prefs_store: PrefsDep,
    memory: MemoryStoreDep,
) -> DeeperOut | JSONResponse:
    _check_day(body.day, settings.tz)
    _check_close_window(body.day, settings.tz)
    prefs = await prefs_store.get()
    req, _grounding = await ground(
        "deeper", body.day, "7d", reader, prefs, consent, settings, memory=await memory.list()
    )
    result = await _generate(service, req, prefs.ai_lines)
    if isinstance(result, JSONResponse):
        return result
    refusal = REFUSALS[result.lines[0]] if is_fixed_reply(result) else None
    return DeeperOut(
        question=result.question,
        options=list(result.priorities),
        source_ids=list(result.source_ids),
        refusal=refusal,  # type: ignore[arg-type]
    )


@router.get(
    "/reviews",
    summary="المراجعات المحفوظة، الأحدث أولاً",
    description="`kind` إما `weekly` (الافتراضي) أو `evening`؛ و`before` يعيد ما قبل يوم معيّن.",
    responses={
        401: _ERRORS[401],
        403: {"model": ErrorDetail, "description": "غير مسموح"},
        422: _ERRORS[422],
    },
)
async def list_reviews(
    _: DeviceDep,
    store: StoreDep,
    kind: Annotated[str, Query(pattern="^(evening|weekly)$")] = "weekly",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: Annotated[date | None, Query(description="أيام قبل هذا اليوم فقط")] = None,
) -> ReviewList:
    return ReviewList(items=[_out(r) for r in await store.list_reviews(kind, limit, before)])
