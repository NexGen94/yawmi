"""`POST /v1/health/daily`: store a day of watch metrics and return its derived scores.

The device sends the raw values it read from Apple Health for one local day (sleep belongs to
the day of waking). The server scores the day against the valid nights before it (see
`yawmi.health.compute`), stores raw values and scores in one `daily_metrics` row, and returns
the scores. Sending the same day again replaces it. `GET /v1/health/live` lives in `main.py`.

Only native devices post health data (`iphone`, `watch`): the web app has no Apple Health.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Self

from fastapi import APIRouter, Depends, Request
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from yawmi.auth.deps import require_kind
from yawmi.db.pool import get_pool
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.domain.scores import BaselineQuality, DataQuality
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.events import models as event_models
from yawmi.events.project import EARLIEST, Instant
from yawmi.health.compute import Segment, TrimpCoefficients, score_day, window
from yawmi.health.store import AsyncpgHealthStore, DailyRow, HealthStore

router = APIRouter(prefix="/v1/health", tags=["health"])

HEALTH_KINDS = ("iphone", "watch")
MAX_SEGMENTS = 500
DAY_MINUTES = 1440

_DAY_AHEAD = "اليوم يلي اليوم الحالي"
_DAY_TOO_OLD = "اليوم خارج النطاق المعقول"
_SLEEP_ORDER = "نهاية النوم تسبق بدايته"
_SLEEP_FUTURE = "وقت النوم يسبق الوقت الحالي بأكثر من 24 ساعة"
_NEEDS_COEFFICIENTS = "حمل الجهد يحتاج تحديد معاملات TRIMP"


def _bounded(low: float, high: float, *, low_open: bool = False) -> object:
    return Field(gt=low, le=high) if low_open else Field(ge=low, le=high)


Ms = Annotated[float, _bounded(0, 1000)]
Bpm = Annotated[float, _bounded(0, 300, low_open=True)]
Minutes = Annotated[StrictInt, Field(ge=0, le=DAY_MINUTES)]


class ExertionSegment(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")

    minutes: Annotated[float, Field(ge=0, le=DAY_MINUTES)]
    hr_reserve: Annotated[float, Field(ge=0, le=1, description="احتياطي النبض من 0 إلى 1")]


class DailyMetricsIn(BaseModel):
    """One local day of raw metrics. Every metric is optional: a gap is missing, never zero.

    Unknown fields are a 422 (`extra_forbidden`), so a misnamed metric is never silently lost.
    """

    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")

    day: date
    has_watch_night: StrictBool = Field(description="هل لبست الساعة في النوم المنسوب إلى اليوم")
    # required: a default of 0 would turn every worn night into `low`, outside every baseline
    hrv_samples: Annotated[StrictInt, Field(ge=0, le=10_000, description="عدد عيّنات HRV في الليلة")]

    hrv_ms: Ms | None = Field(default=None, description="HRV الليلي (SDNN)")
    hrv_rmssd_ms: Ms | None = None
    rhr_bpm: Bpm | None = None
    sleeping_hr_bpm: Bpm | None = None
    walking_hr_bpm: Bpm | None = None
    resp_rate_bpm: Annotated[float, _bounded(0, 100)] | None = None
    wrist_temp_delta_c: Annotated[float, _bounded(-10, 10)] | None = None
    spo2_pct: Annotated[float, _bounded(0, 100)] | None = None
    sleep_minutes: Minutes | None = None
    sleep_core_minutes: Minutes | None = None
    sleep_deep_minutes: Minutes | None = None
    sleep_rem_minutes: Minutes | None = None
    sleep_awake_minutes: Minutes | None = None
    in_bed_minutes: Minutes | None = None
    sleep_start: Instant | None = None
    sleep_end: Instant | None = None
    steps: Annotated[StrictInt, Field(ge=0, le=1_000_000)] | None = None
    active_kcal: Annotated[float, _bounded(0, 50_000)] | None = None
    exercise_minutes: Minutes | None = None
    mindful_minutes: Minutes | None = None

    exertion: Annotated[list[ExertionSegment], Field(max_length=MAX_SEGMENTS)] = Field(
        default_factory=list, description="مقاطع الجهد لحساب TRIMP؛ تُترك فارغة إن لم يوجد"
    )
    trimp_coefficients: TrimpCoefficients | None = Field(
        default=None,
        description="معاملات Banister (0.64/1.92 أو 0.86/1.67)؛ مطلوبة إن أُرسلت مقاطع جهد",
    )

    @field_validator("day")
    @classmethod
    def _plausible_day(cls, day: date) -> date:
        if day < EARLIEST.date():
            raise PydanticCustomError("day_out_of_range", _DAY_TOO_OLD)
        # the device's local day may run ahead of the server's by its clock drift, not more
        today = day_key(event_models.server_now(), DEFAULT_TZ)
        if day > today + timedelta(days=1):
            raise PydanticCustomError("day_in_future", _DAY_AHEAD)
        return day

    @field_validator("sleep_start", "sleep_end")
    @classmethod
    def _not_far_ahead(cls, value: datetime | None) -> datetime | None:
        if value is not None and value > event_models.server_now() + event_models.MAX_FUTURE:
            raise PydanticCustomError("sleep_in_future", _SLEEP_FUTURE)
        return value

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.sleep_start and self.sleep_end and self.sleep_end < self.sleep_start:
            raise PydanticCustomError("sleep_bounds", _SLEEP_ORDER)
        if self.exertion and self.trimp_coefficients is None:
            raise PydanticCustomError("trimp_coefficients_required", _NEEDS_COEFFICIENTS)
        return self


class BaselineOut(BaseModel):
    quality: BaselineQuality
    nights: int = Field(description="أقل عدد ليالٍ صالحة خلف خطوط الأساس الثلاثة")


class DailyScoresOut(BaseModel):
    day: date
    recovery_score: int | None = Field(description="0–100، أو null إن لم يكتمل خط الأساس")
    strain_score: float | None = Field(description="0–21 بمنزلة عشرية واحدة")
    data_quality: DataQuality
    baseline: BaselineOut | None


def get_health_store(request: Request) -> HealthStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: HealthStore | None = getattr(request.app.state, "health", None)
    return injected if injected is not None else AsyncpgHealthStore(get_pool())


HealthStoreDep = Annotated[HealthStore, Depends(get_health_store)]


def _dec(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(repr(value))


@router.post(
    "/daily",
    summary="رفع مقاييس يوم واحد وحساب درجاته",
    description=(
        "يحسب الخادم التعافي والإجهاد وجودة البيانات بخط أساس شخصي من الليالي الصالحة في الأيام "
        "الـ28 السابقة: لا خط أساس إن قلّت الليالي الصالحة في النافذة عن 7، و«كامل» إن حوى كل "
        "أسبوع من أسابيعها الأربعة 4 ليالٍ صالحة على الأقل، وإلا «أولي». إعادة إرسال "
        "اليوم نفسه تستبدله. عند رفع عدة أيام يُرسل الأقدم أولاً، فاليوم يُقاس بما سبقه مخزناً، "
        "ولا يُعاد حساب الأيام التالية عند وصول يوم أقدم. حقل غير معروف يُرفض. "
        "تقدير، ليس تشخيصاً."
    ),
    dependencies=[Depends(require_kind(*HEALTH_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN, **INVALID},
)
async def post_daily(body: DailyMetricsIn, store: HealthStoreDep) -> DailyScoresOut:
    first, last = window(body.day)
    history = await store.nights(first, last)
    scores = score_day(
        day=body.day,
        hrv_ms=body.hrv_ms,
        rhr_bpm=body.rhr_bpm,
        sleep_minutes=body.sleep_minutes,
        has_watch_night=body.has_watch_night,
        hrv_samples=body.hrv_samples,
        history=history,
        exertion=[Segment(s.minutes, s.hr_reserve) for s in body.exertion],
        coefficients=body.trimp_coefficients,
    )
    await store.save(
        DailyRow(
            day=body.day,
            hrv_ms=_dec(body.hrv_ms),
            hrv_rmssd_ms=_dec(body.hrv_rmssd_ms),
            rhr_bpm=_dec(body.rhr_bpm),
            sleeping_hr_bpm=_dec(body.sleeping_hr_bpm),
            walking_hr_bpm=_dec(body.walking_hr_bpm),
            resp_rate_bpm=_dec(body.resp_rate_bpm),
            wrist_temp_delta_c=_dec(body.wrist_temp_delta_c),
            spo2_pct=_dec(body.spo2_pct),
            sleep_minutes=body.sleep_minutes,
            sleep_core_minutes=body.sleep_core_minutes,
            sleep_deep_minutes=body.sleep_deep_minutes,
            sleep_rem_minutes=body.sleep_rem_minutes,
            sleep_awake_minutes=body.sleep_awake_minutes,
            in_bed_minutes=body.in_bed_minutes,
            sleep_start=body.sleep_start,
            sleep_end=body.sleep_end,
            steps=body.steps,
            active_kcal=_dec(body.active_kcal),
            exercise_minutes=body.exercise_minutes,
            mindful_minutes=body.mindful_minutes,
            recovery_score=scores.recovery_score,
            strain_score=scores.strain_score,
            data_quality=scores.data_quality,
        )
    )
    summary = scores.baseline
    return DailyScoresOut(
        day=body.day,
        recovery_score=scores.recovery_score,
        strain_score=None if scores.strain_score is None else float(scores.strain_score),
        data_quality=scores.data_quality,
        baseline=None
        if summary is None
        else BaselineOut(quality=summary.quality, nights=summary.nights),
    )
