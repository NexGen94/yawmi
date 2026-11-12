"""المدخلات المختارة يدوياً لمتجهات النطاق المشتركة `contracts/domain-vectors/v1`.

هنا المدخلات والمعرّفات والمصادر فقط؛ أما `expect` فيحسبه `gen_domain_vectors.py` من التنفيذ
المرجعي (`yawmi.domain`). قواعد الثبات:

- المعرّف `<fn>-NNN` لا يتغيّر ولا يُحذف بعد التزامه، ومدخلاته لا تتغيّر. حالة جديدة تأخذ رقماً جديداً.
  والاستثناء الوحيد حالات الامتناع العشرون (`rulesVersion` 2): `<fn>-abstain-<حالة>` بأسماء جدول
  التصميم §9.6.
- أي تغيير في `expect` لمعرّف ملتزَم يرفع `RULES_VERSION` هنا، وإلا رفض المولّد الكتابة.
- `RULES_VERSION` 2 أضاف عادة الامتناع (`habit.polarity = "abstain"`) دون تغيير أي توقع من الـ312
  الملتزَمة في الإصدار 1 (يثبته `test_rules_v2_keeps_every_v1_expectation`).
- `pin`: قيمة معلنة في المواصفة أو المهمة 8 (مع هامشها) يتحقق المولّد والاختبار أن الناتج يطابقها،
  ولا تُكتب في الملف. `tol` يُكتب في الملف ويخفف مقارنة المستهلكين لهذه الحالة وحدها.

المدخلات بدائيات JSON وحدها: تواريخ `YYYY-MM-DD`، ولحظات ISO بـ`Z`، وأعداد، ونصوص تعداد،
ومصفوفات وكائنات منها بمفاتيح `snake_case`. `habit` بحقول `HabitSpec` العشرة كلها (ولو `null`)،
وحقل حادي عشر `polarity` في حالات الامتناع وحدها (غيابه يعني `build`)،
و`logs` مصفوفة `{day, value, status}`، و`week_start` في كل حالة تمرّ به للدالة. و`baseline`
بـ`nights` مصفوفة `{day, value}` (ليالٍ صالحة مؤرخة بيوم الاستيقاظ) و`day` اليوم المقيَّم و`log`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

RULES_VERSION = 2

FUNCTIONS: tuple[str, ...] = (
    "day_key",
    "period_bounds",
    "is_scheduled",
    "end_day",
    "period_progress",
    "strength",
    "streak",
    "challenge_progress",
    "adherence",
    "goal_prefill",
    "baseline",
    "recovery",
    "trimp",
    "strain",
)


@dataclass(frozen=True, slots=True)
class Case:
    id: str
    input: dict[str, Any]
    source: str
    tol: float | None = None
    pin: tuple[Any, float] | None = None


# ---------------------------------------------------------------- أدوات بناء المدخلات

START = date(2026, 11, 9)  # الاثنين؛ أسبوع الأحد 11-08 .. 11-14
THURSDAY = date(2026, 11, 12)
WEEK1 = date(2026, 11, 1)  # الأحد
LEAP = date(2028, 2, 29)  # الثلاثاء
SUN, MON, TUE, WED, THU, FRI, SAT = range(7)  # بتّات القناع: 0 = الأحد ... 6 = السبت


def iso(day: date) -> str:
    return day.isoformat()


def d(offset: int, base: date = START) -> str:
    return iso(base + timedelta(days=offset))


def mask(*weekdays: int) -> int:
    return sum(1 << w for w in weekdays)


def habit(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "boolean",
        "unit": None,
        "target_per_period": 1.0,
        "period": "day",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "start_day": iso(START),
        "end_day": None,
    }
    base.update(kw)
    return base


def count(target: float, period: str, **kw: Any) -> dict[str, Any]:
    return habit(kind="count", unit="session", target_per_period=target, period=period, **kw)


def duration(target: float, period: str = "day", unit: str = "min", **kw: Any) -> dict[str, Any]:
    return habit(kind="duration", unit=unit, target_per_period=target, period=period, **kw)


def weekly_bool(**kw: Any) -> dict[str, Any]:
    return habit(kind="boolean", target_per_period=5.0, period="week", **kw)


def done(day: str, value: float | None = 1.0) -> dict[str, Any]:
    return {"day": day, "value": value, "status": "done"}


def status(day: str, st: str) -> dict[str, Any]:
    return {"day": day, "value": None, "status": st}


def daily_done(first: date, n: int, value: float = 1.0) -> list[dict[str, Any]]:
    return [done(d(i, first), value) for i in range(n)]


def week_done(week_start: date, n: int = 3) -> list[dict[str, Any]]:
    return [done(d(i, week_start)) for i in range(n)]


def week_status(week_start: date, st: str, n: int = 7) -> list[dict[str, Any]]:
    return [status(d(i, week_start), st) for i in range(n)]


def rules(
    spec: dict[str, Any], logs: list[dict[str, Any]], today: str, week_start: str = "sun"
) -> dict[str, Any]:
    return {"habit": spec, "logs": logs, "today": today, "week_start": week_start}


def _numbered(fn: str, rows: list[tuple[Any, ...]]) -> list[Case]:
    """صفوف `(رقم, مدخلات, مصدر[, tol[, pin]])` إلى حالات بمعرّفات `<fn>-NNN`؛ الأرقام فريدة وصريحة."""
    cases: list[Case] = []
    for row in rows:
        n, inp, source = row[:3]
        tol = row[3] if len(row) > 3 else None
        pin = row[4] if len(row) > 4 else None
        cases.append(Case(id=f"{fn}-{n:03d}", input=inp, source=source, tol=tol, pin=pin))
    ids = [c.id for c in cases]
    if len(ids) != len(set(ids)):
        raise ValueError(f"معرّفات مكررة في {fn}")
    return cases


RIYADH = "Asia/Riyadh"

# ---------------------------------------------------------------- day_key

DAY_KEY = _numbered(
    "day_key",
    [
        (1, {"instant": "2026-11-09T20:59:59Z", "tz": RIYADH}, "آخر ثانية في يوم الرياض 11-09"),
        (2, {"instant": "2026-11-09T21:00:00Z", "tz": RIYADH}, "أول ثانية في يوم الرياض 11-10"),
        (3, {"instant": "2026-11-09T23:30:00Z", "tz": RIYADH}, "محور المراجعة 4: يُنسب إلى 11-10"),
        (4, {"instant": "2026-11-09T12:00:00Z", "tz": RIYADH}, "منتصف النهار بالتوقيت العالمي"),
        (
            5,
            {"instant": "2026-11-09T00:00:00Z", "tz": RIYADH},
            "منتصف الليل عالمياً = 03:00 بالرياض",
        ),
        (6, {"instant": "2026-11-09T20:59:59.999Z", "tz": RIYADH}, "أجزاء الثانية قبل الحد"),
        (7, {"instant": "2028-02-28T21:00:00Z", "tz": RIYADH}, "بداية يوم الكبيسة 2028-02-29"),
        (8, {"instant": "2028-02-29T20:59:59Z", "tz": RIYADH}, "آخر ثانية في يوم الكبيسة"),
        (9, {"instant": "2028-02-29T21:00:00Z", "tz": RIYADH}, "ما بعد الكبيسة: 2028-03-01"),
        (10, {"instant": "2026-12-31T21:00:00Z", "tz": RIYADH}, "حد السنة: أول ثانية في 2027"),
        (11, {"instant": "2026-11-30T20:59:59Z", "tz": RIYADH}, "نهاية شهر من 30 يوماً"),
        (12, {"instant": "2026-10-31T21:00:00Z", "tz": RIYADH}, "نهاية شهر من 31 يوماً إلى 11-01"),
        (
            13,
            {"instant": "2026-11-09T23:30:00+03:00", "tz": RIYADH},
            "لحظة بإزاحة صريحة: اليوم يتبع اللحظة لا الإزاحة المكتوبة",
        ),
        (14, {"instant": "2026-11-10T02:59:59Z", "tz": RIYADH}, "ساعات الليل الأولى تبقى في 11-10"),
    ],
)

# ---------------------------------------------------------------- period_bounds


def _pb(day: str, period: str, week_start: str) -> dict[str, Any]:
    return {"day": day, "period": period, "week_start": week_start}


PERIOD_BOUNDS = _numbered(
    "period_bounds",
    [
        (1, _pb("2026-11-09", "day", "sun"), "فترة اليوم: اليوم نفسه"),
        (2, _pb("2028-02-29", "day", "sat"), "فترة اليوم في يوم الكبيسة وبداية أسبوع لا تؤثر"),
        (3, _pb("2026-11-09", "week", "sun"), "الاثنين في أسبوع الأحد"),
        (4, _pb("2026-11-09", "week", "sat"), "الاثنين في أسبوع السبت"),
        (5, _pb("2026-11-09", "week", "mon"), "الاثنين هو بداية أسبوع الاثنين"),
        (6, _pb("2026-11-08", "week", "sun"), "يوم بداية الأسبوع نفسه"),
        (7, _pb("2026-11-14", "week", "sun"), "آخر يوم في الأسبوع"),
        (8, _pb("2026-11-15", "week", "sun"), "أول يوم في الأسبوع التالي"),
        (9, _pb("2027-01-01", "week", "sun"), "أسبوع يعبر حد السنة"),
        (10, _pb("2028-02-29", "week", "sun"), "أسبوع يحوي يوم الكبيسة (أحد)"),
        (11, _pb("2028-02-29", "week", "sat"), "أسبوع يحوي يوم الكبيسة (سبت)"),
        (12, _pb("2028-02-29", "week", "mon"), "أسبوع يحوي يوم الكبيسة (اثنين)"),
        (13, _pb("2026-11-07", "week", "sat"), "السبت هو بداية أسبوع السبت"),
        (14, _pb("2026-11-07", "week", "sun"), "السبت هو آخر يوم في أسبوع الأحد"),
        (15, _pb("2026-11-07", "week", "mon"), "السبت في أسبوع الاثنين 11-02 .. 11-08"),
        (16, _pb("2026-11-09", "month", "sun"), "شهر من 30 يوماً"),
        (17, _pb("2026-11-01", "month", "sun"), "أول يوم في الشهر"),
        (18, _pb("2026-12-31", "month", "sun"), "آخر يوم في شهر من 31 يوماً"),
        (19, _pb("2028-02-29", "month", "sun"), "فبراير الكبيسة 29 يوماً"),
        (20, _pb("2027-02-15", "month", "sun"), "فبراير العادية 28 يوماً"),
        (21, _pb("2100-02-10", "month", "mon"), "2100 ليست كبيسة (قابلة للقسمة على 100 لا 400)"),
        (22, _pb("2000-02-10", "month", "sat"), "2000 كبيسة (قابلة للقسمة على 400)"),
        (23, _pb("2026-11-30", "month", "sun"), "آخر يوم في شهر من 30 يوماً"),
    ],
)

# ---------------------------------------------------------------- is_scheduled


def _sched(day: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {"day": day, "habit": spec}


_WINDOWED = habit(end_day=d(29))
_SUN_SAT = habit(schedule_kind="weekdays", weekday_mask=mask(SUN, SAT), start_day=iso(WEEK1))
_ALL_DAYS_SHORT = habit(schedule_kind="weekdays", weekday_mask=127, end_day=d(2))
_LEAP_N3 = habit(
    schedule_kind="every_n_days",
    every_n=3,
    anchor_day="2028-02-27",
    start_day="2028-02-20",
)
_ANCHOR_AFTER = habit(schedule_kind="every_n_days", every_n=3, anchor_day=d(10))
_ANCHOR_BEFORE = habit(schedule_kind="every_n_days", every_n=4, anchor_day=d(-10))
_ANCHOR_START = habit(schedule_kind="every_n_days", every_n=2, anchor_day=iso(START))
_FRIDAY = habit(schedule_kind="weekdays", weekday_mask=mask(FRI))

IS_SCHEDULED = _numbered(
    "is_scheduled",
    [
        (1, _sched(d(-1), _WINDOWED), "قبل البداية بيوم: غير مجدول"),
        (2, _sched(d(0), _WINDOWED), "يوم البداية"),
        (3, _sched(d(29), _WINDOWED), "آخر يوم في النافذة"),
        (4, _sched(d(30), _WINDOWED), "اليوم التالي للنهاية"),
        (5, _sched("2026-11-08", _SUN_SAT), "قناع الأحد والسبت: الأحد (بتّ 0)"),
        (6, _sched("2026-11-14", _SUN_SAT), "قناع الأحد والسبت: السبت (بتّ 6)"),
        (7, _sched("2026-11-09", _SUN_SAT), "قناع الأحد والسبت: الاثنين غير مجدول"),
        (8, _sched("2026-11-13", _SUN_SAT), "قناع الأحد والسبت: الجمعة غير مجدولة"),
        (9, _sched(d(-1), _ALL_DAYS_SHORT), "قناع كامل لكن قبل البداية"),
        (10, _sched(d(2), _ALL_DAYS_SHORT), "قناع كامل في آخر يوم"),
        (11, _sched(d(3), _ALL_DAYS_SHORT), "قناع كامل بعد النهاية"),
        (12, _sched("2028-02-27", _LEAP_N3), "كل 3 أيام: يوم المرساة"),
        (13, _sched("2028-02-28", _LEAP_N3), "كل 3 أيام: اليوم التالي للمرساة"),
        (14, _sched("2028-02-29", _LEAP_N3), "كل 3 أيام: يوم الكبيسة ليس من الدورة"),
        (15, _sched("2028-03-01", _LEAP_N3), "كل 3 أيام: بعد الكبيسة مجدول"),
        (16, _sched("2028-03-04", _LEAP_N3), "كل 3 أيام: الدورة تستمر"),
        (17, _sched(d(1), _ANCHOR_AFTER), "المرساة بعد البداية: مرساة − 9"),
        (18, _sched(d(0), _ANCHOR_AFTER), "المرساة بعد البداية: البداية نفسها ليست من الدورة"),
        (19, _sched(d(10), _ANCHOR_AFTER), "المرساة بعد البداية: يوم المرساة"),
        (20, _sched(d(2), _ANCHOR_BEFORE), "المرساة قبل البداية: مرساة + 12"),
        (21, _sched(d(0), _ANCHOR_BEFORE), "المرساة قبل البداية: البداية ليست من الدورة"),
        (22, _sched(d(-2), _ANCHOR_BEFORE), "المرساة قبل البداية: من الدورة لكن قبل البداية"),
        (23, _sched(d(6), _ANCHOR_BEFORE), "المرساة قبل البداية: مرساة + 16"),
        (24, _sched(d(0), _ANCHOR_START), "المرساة = البداية، كل يومين: اليوم 0"),
        (25, _sched(d(1), _ANCHOR_START), "المرساة = البداية، كل يومين: اليوم 1"),
        (26, _sched(d(2), _ANCHOR_START), "المرساة = البداية، كل يومين: اليوم 2"),
        (27, _sched("2026-11-13", _FRIDAY), "قناع الجمعة (بتّ 5): الجمعة"),
        (28, _sched("2026-11-12", _FRIDAY), "قناع الجمعة: الخميس"),
    ],
)

# ---------------------------------------------------------------- end_day


def _ed(start: str, n: int) -> dict[str, Any]:
    return {"start": start, "duration_days": n}


END_DAY = _numbered(
    "end_day",
    [
        (1, _ed("2026-11-09", 30), "تحدي 30 يوماً"),
        (2, _ed("2026-11-09", 1), "تحدي يوم واحد ينتهي يوم بدايته"),
        (3, _ed("2028-02-28", 3), "يعبر يوم الكبيسة"),
        (4, _ed("2026-12-30", 3), "يعبر حد السنة"),
        (5, _ed("2026-11-09", 7), "شريحة 7"),
        (6, _ed("2026-11-09", 66), "شريحة 66"),
        (7, _ed("2026-11-09", 100), "شريحة 100"),
        (8, _ed("2028-02-29", 1), "يبدأ يوم الكبيسة"),
        (9, _ed("2028-02-01", 29), "ينتهي يوم الكبيسة"),
        (10, _ed("2026-10-02", 30), "ينتهي في 10-31"),
    ],
)

# ---------------------------------------------------------------- period_progress

_W5 = count(5.0, "week", start_day=iso(WEEK1))
_W5_EARLY = [done("2026-11-08"), done("2026-11-09"), done("2026-11-10")]
_W5_TODAY = "2026-11-11"  # الأربعاء
_W7 = count(7.0, "week", start_day=iso(WEEK1))
_W5_MON = count(5.0, "week")  # تبدأ الاثنين 11-09
_W5_MON_LOGS = [done("2026-11-08"), done("2026-11-09")]
_FEB29 = count(29.0, "month", start_day="2028-01-01")
_M30 = count(30.0, "month", start_day=iso(WEEK1))
_HOUR = duration(1.0, unit="hour")

PERIOD_PROGRESS = _numbered(
    "period_progress",
    [
        (1, rules(habit(), [], d(0)), "يومية منطقية بلا سجل: اليوم غير منقضٍ قبل التسجيل"),
        (2, rules(habit(), [done(d(0))], d(0)), "يومية منطقية محققة: اليوم منقضٍ بسجله"),
        (3, rules(habit(), [done(d(0)), done(d(0))], d(0)), "سجلان في اليوم للمنطقية يُحسبان مرة"),
        (4, rules(habit(), [status(d(0), "skip")], d(0)), "تخطٍّ اليوم: لا يُتوقع شيء"),
        (5, rules(habit(), [status(d(0), "vacation")], d(0)), "إجازة اليوم: لا يُتوقع شيء"),
        (
            6,
            rules(habit(schedule_kind="weekdays", weekday_mask=mask(SUN)), [], d(0)),
            "يوم غير مجدول: لا هدف منقضٍ ولا مطلوب",
        ),
        (7, rules(duration(30.0), [done(d(0), 15.0)], d(0)), "مدة جزئية: نصف الهدف وتوقّع الإكمال"),
        (8, rules(count(3.0, "day"), [done(d(0), 5.0)], d(0)), "تجاوز الهدف: completion بسقف 1"),
        (9, rules(_W5, _W5_EARLY, _W5_TODAY), "أسبوعية منتصف الأسبوع، واليوم بلا سجل"),
        (10, rules(_W5, [*_W5_EARLY, done(_W5_TODAY)], _W5_TODAY), "اليوم بسجل: يدخل في المنقضي"),
        (
            11,
            rules(_W5, [*_W5_EARLY, status(_W5_TODAY, "missed")], _W5_TODAY),
            "سجل missed اليوم يكفي ليدخل في المنقضي",
        ),
        (
            12,
            rules(_W5, [*_W5_EARLY, status(_W5_TODAY, "skip")], _W5_TODAY),
            "تخطّي اليوم لا يدخله في المنقضي",
        ),
        (
            13,
            rules(
                _W5,
                [done("2026-11-08"), status("2026-11-09", "vacation"), done("2026-11-10")],
                _W5_TODAY,
            ),
            "إجازة في الأسبوع تخفض المتوقع ولا ترفع المطلوب اليومي",
        ),
        (
            14,
            rules(_W7, [done(d(i, date(2026, 11, 8))) for i in range(5)], "2026-11-13"),
            "متأخر عن الوتيرة: 5 من 7 حتى الجمعة",
        ),
        (
            15,
            rules(_W5, [done("2026-11-07"), done("2026-11-15")], _W5_TODAY),
            "سجلات خارج الفترة (الأسبوع السابق واللاحق) تُهمل",
        ),
        (
            16,
            rules(_W5_MON, _W5_MON_LOGS, "2026-11-10"),
            "سجل قبل start_day يُهمل، والأسبوع الأول مقصوص (6 أيام مجدولة)",
        ),
        (17, rules(_W5_MON, _W5_MON_LOGS, "2026-11-10", "sat"), "بداية السبت تغيّر الفترة"),
        (
            18,
            rules(_W5_MON, _W5_MON_LOGS, "2026-11-10", "mon"),
            "بداية الاثنين: الأسبوع كامل من البداية",
        ),
        (
            19,
            rules(_FEB29, [done(d(i, date(2028, 2, 1))) for i in range(10)], "2028-02-29"),
            "فبراير الكبيسة: 29 يوماً، واليوم الأخير بلا سجل",
        ),
        (20, rules(_M30, [], "2026-11-15"), "شهرية: المتوقع يتناسب مع الأيام المنقضية"),
        (21, rules(habit(), [], d(-3)), "قبل start_day: لا فترة مجدولة"),
        (22, rules(habit(end_day=d(9)), daily_done(START, 10), d(12)), "بعد نهاية التحدي"),
        (
            23,
            rules(
                _HOUR, [done(d(0), 0.7), done(d(0), 0.1), done(d(0), 0.1), done(d(0), 0.1)], d(0)
            ),
            "مجموع كسور يبلغ الهدف بالضبط رغم ضجيج الفاصلة العائمة",
        ),
        (24, rules(count(3.0, "day"), [done(d(0), None)], d(0)), "done بلا قيمة لغير المنطقية = 0"),
        (
            25,
            rules(weekly_bool(start_day=iso(THURSDAY)), week_done(THURSDAY), "2026-11-14"),
            "أسبوع أول مقصوص: الهدف ceil(5·3/7) = 3 محقق",
        ),
        (
            26,
            rules(weekly_bool(start_day=iso(THURSDAY)), week_done(THURSDAY, 2), "2026-11-14"),
            "أسبوع أول مقصوص: 2 من 3",
        ),
        (
            27,
            rules(duration(285.0, "week", start_day=iso(THURSDAY)), [], iso(THURSDAY)),
            "التناسب يقرّب لأعلى: ceil(285·3/7) = 123",
        ),
        (
            28,
            rules(count(14.000000001, "week", start_day=iso(THURSDAY)), [], iso(THURSDAY)),
            "هامش 1e-9 في التناسب: 6.0000000004 تعطي 6",
        ),
        (
            29,
            rules(count(2.0, "week", start_day="2026-11-14"), [], "2026-11-14"),
            "يوم واحد من 7: الهدف المتناسب لا يقل عن 1",
        ),
        (
            30,
            rules(
                duration(0.5, "week", unit="hour", start_day=iso(THURSDAY)),
                [done(iso(THURSDAY), 0.5)],
                "2026-11-14",
            ),
            "السقف T: هدف 0.5 يبقى 0.5 في الأسبوع الجزئي",
        ),
        (
            31,
            rules(count(1.0, "week", start_day=iso(THURSDAY)), [], iso(THURSDAY)),
            "هدف 1 في أسبوع جزئي يبقى 1",
        ),
        (
            32,
            rules(count(2.5, "week", start_day=iso(WEEK1)), [], _W5_TODAY),
            "أسبوع كامل: الهدف 2.5 بلا تقريب",
        ),
        (
            33,
            rules(count(3.0, "day", start_day=iso(THURSDAY)), [], iso(THURSDAY)),
            "اليومية لا تتناسب",
        ),
        (
            34,
            rules(count(5.0, "week", start_day="2026-11-22"), [], _W5_TODAY),
            "الفترة قبل البداية كلياً: الهدف كما هو ولا توقّع",
        ),
        (
            35,
            rules(
                count(10.0, "month", start_day="2026-11-21"),
                [done(d(i, date(2026, 11, 21))) for i in range(4)],
                "2026-11-30",
            ),
            "شهر أول مقصوص: ceil(10·10/30) = 4",
        ),
        (
            36,
            rules(count(10.0, "month", start_day="2026-11-21"), [], "2026-12-05"),
            "الشهر الكامل التالي بهدفه",
        ),
        (
            37,
            rules(_W5, list(reversed(_W5_EARLY)), _W5_TODAY),
            "ترتيب السجلات معكوس: الناتج نفسه كالحالة 009",
        ),
        (
            38,
            rules(_HOUR, [done(d(0), 0.3), done(d(0), 0.2), done(d(0), 0.1)], d(0)),
            "ترتيب الجمع محدِّد: 0.3+0.2+0.1 كـ0.1+0.2+0.3",
        ),
        (
            39,
            rules(_HOUR, [done(d(0), 0.1), done(d(0), 0.2), done(d(0), 0.3)], d(0)),
            "الترتيب الآخر للحالة 038 يعطي القيمة نفسها حتى آخر خانة",
        ),
        (
            40,
            rules(_W5, [done(_W5_TODAY), done("2026-11-09")], _W5_TODAY),
            "تعديل بأثر رجعي: سجل ليوم سابق يصل بعد سجل اليوم",
        ),
        (
            41,
            rules(duration(30.0), [done(d(0), 15.0), done(d(0), 20.0)], d(0)),
            "سجلان للمدة في اليوم يُجمعان",
        ),
    ],
)

# ---------------------------------------------------------------- strength

_SKIP20 = [*daily_done(START, 20), status(d(20), "skip")]
_VAC20 = [*daily_done(START, 20), status(d(20), "vacation")]
_WEEKDAYS_MT = habit(schedule_kind="weekdays", weekday_mask=mask(MON, TUE))
_N3 = habit(schedule_kind="every_n_days", every_n=3, anchor_day=iso(START))
_CHALLENGE10 = habit(end_day=d(9))
_W3 = count(3.0, "week")
_W3_LOGS = [done(d(0)), done(d(2)), done(d(4)), done(d(9), 2.0)]
_M10 = count(10.0, "month")
_M10_LOGS = [done(d(i), 1.0) for i in (0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 33)]
_LEAP_DAILY = habit(start_day="2028-02-20")

STRENGTH = _numbered(
    "strength",
    [
        (
            1,
            rules(habit(), daily_done(START, 30), d(30)),
            "Loop: 30 يوماً كاملاً ≈ 0.7980",
            5e-5,
            (0.7980, 5e-5),
        ),
        (
            2,
            rules(habit(), daily_done(START, 60), d(60)),
            "Loop: 60 يوماً كاملاً ≈ 0.9592",
            5e-5,
            (0.9592, 5e-5),
        ),
        (
            3,
            rules(habit(), daily_done(START, 90), d(90)),
            "Loop: 90 يوماً كاملاً ≈ 0.9918",
            5e-5,
            (0.9918, 5e-5),
        ),
        (4, rules(habit(), [], d(0)), "بلا تاريخ: صفر"),
        (5, rules(habit(), daily_done(START, 3), d(3)), "اليوم بلا سجل لا يدخل: 1 − m³"),
        (6, rules(habit(), daily_done(START, 4), d(3)), "اليوم بسجل يدخل: 1 − m⁴"),
        (
            7,
            rules(habit(), [*daily_done(START, 3), status(d(3), "missed")], d(3)),
            "missed اليوم يدخل صفراً",
        ),
        (8, rules(habit(), [done(d(0))], d(3)), "يومان مجدولان بلا سجل يخفضان: (1 − m)·m²"),
        (
            9,
            rules(habit(), [done(d(0)), status(d(1), "missed"), status(d(2), "missed")], d(3)),
            "missed صريح = غياب السجل",
        ),
        (10, rules(habit(), _SKIP20, d(21)), "تخطٍّ لا يغيّر القوة: كأن اليوم لم يكن"),
        (11, rules(habit(), _VAC20, d(21)), "إجازة لا تغيّر القوة"),
        (
            12,
            rules(_WEEKDAYS_MT, [done(d(0)), done(d(1)), done(d(7))], d(8)),
            "الأيام غير المجدولة لا تغيّر القوة",
        ),
        (
            13,
            rules(_N3, [done(d(0)), done(d(3)), done(d(6))], d(8)),
            "كل 3 أيام: المجدولة وحدها تُحدّث",
        ),
        (14, rules(_N3, [done(d(0)), done(d(6))], d(8)), "كل 3 أيام مع يوم مجدول فائت"),
        (
            15,
            rules(habit(), [done(d(-2)), done(d(-1)), *daily_done(START, 4)], d(4)),
            "سجلات قبل start_day تُهمل",
        ),
        (16, rules(duration(30.0), [done(d(0), 15.0)], d(1)), "المدة الجزئية: نسبة 0.5"),
        (17, rules(duration(30.0), [done(d(0), 60.0)], d(1)), "المدة فوق الهدف: سقف 1"),
        (
            18,
            rules(count(2.0, "day"), [done(d(0), 1.0), done(d(0), 1.0)], d(1)),
            "سجلان للعدد في اليوم يُجمعان",
        ),
        (19, rules(_CHALLENGE10, daily_done(START, 10), d(9)), "تحدٍّ: آخر يوم"),
        (
            20,
            rules(_CHALLENGE10, daily_done(START, 10), d(30)),
            "تحدٍّ: مجمّد بعد النهاية = الحالة 019",
        ),
        (21, rules(_W3, _W3_LOGS, d(14)), "أسبوعية عدد: نافذة 7 أيام متحركة وf = 3/7"),
        (22, rules(_W3, [done(d(-3)), *_W3_LOGS], d(14)), "النافذة المتحركة تهمل ما قبل start_day"),
        (23, rules(_M10, _M10_LOGS, d(40)), "شهرية عدد: نافذة 30 يوماً وf = 1/3"),
        (24, rules(_W3, [*_W3_LOGS, status(d(5), "skip")], d(14)), "تخطٍّ في الأسبوعية لا يُحدّث"),
        (25, rules(_W3, _W3_LOGS, d(14), "sat"), "week_start لا يؤثر في القوة (سبت)"),
        (26, rules(_W3, _W3_LOGS, d(14), "mon"), "week_start لا يؤثر في القوة (اثنين)"),
        (
            27,
            rules(habit(), [done(d(5)), done(d(1)), done(d(0)), done(d(2))], d(3)),
            "سجل مستقبلي يُهمل والترتيب لا يؤثر",
        ),
        (
            28,
            rules(duration(285.0, "week"), [done(d(0), 285.0)], d(7)),
            "مدة أسبوعية: f = 1 لا 285/7",
        ),
        (
            29,
            rules(duration(5.0, "week", unit="hour"), [done(d(0), 5.0)], d(7)),
            "مدة بالساعات: السرعة نفسها",
        ),
        (30, rules(count(5.0, "week"), [done(d(0), 5.0)], d(7)), "عدد أسبوعي: f = 5/7"),
        (
            31,
            rules(
                habit(kind="boolean", target_per_period=3.0, period="week"),
                daily_done(START, 3),
                d(7),
            ),
            "منطقية أسبوعية 3 من 7: f = 3/7",
        ),
        (32, rules(count(60.0, "month"), [done(d(0), 60.0)], d(30)), "f بسقف 1: 60/30 → 1"),
        (33, rules(duration(600.0, "month"), [done(d(0), 600.0)], d(30)), "مدة شهرية: f = 1"),
        (
            34,
            rules(_LEAP_DAILY, daily_done(date(2028, 2, 20), 11), "2028-03-02"),
            "يومية تعبر 2028-02-29",
        ),
        (
            35,
            rules(habit(), list(reversed(daily_done(START, 30))), d(30)),
            "ترتيب معكوس = الحالة 001",
        ),
    ],
)

# ---------------------------------------------------------------- streak

_WEEKLY = count(3.0, "week", start_day=iso(WEEK1))
_WK = {i: date(2026, 11, i) for i in (1, 8, 15, 22)}
_MONTHLY2 = count(2.0, "month", start_day="2026-09-01")
_MONTHLY2_LOGS = [
    done("2026-09-03"),
    done("2026-09-20"),
    *[status(iso(date(2026, 10, i)), "vacation") for i in range(1, 32)],
    done("2026-11-02"),
    done("2026-11-05"),
]
_CH30 = weekly_bool(start_day="2026-11-08", end_day="2026-12-07")
_CH30_LOGS = daily_done(date(2026, 11, 8), 30)
_CH30_SHORT = daily_done(date(2026, 11, 8), 29)
_PART_W1 = [done(iso(date(2026, 11, i))) for i in (12, 13, 14)]
_PART_W2 = [done(iso(date(2026, 11, i))) for i in (15, 16, 17, 18, 19)]

STREAK = _numbered(
    "streak",
    [
        (1, rules(habit(), [], d(-1)), "قبل start_day: صفر"),
        (2, rules(habit(), daily_done(START, 3), d(2)), "اليوم محقق فيُعد"),
        (3, rules(habit(), daily_done(START, 3), d(3)), "اليوم بلا سجل محايد لا يكسر"),
        (4, rules(habit(), [done(d(0)), done(d(1))], d(3)), "يوم 2 فائت: تنقطع"),
        (
            5,
            rules(habit(), [done(d(0)), done(d(1)), done(d(2))], d(3)),
            "تعديل بأثر رجعي للحالة 004: يوم 2 سُجل لاحقاً",
        ),
        (
            6,
            rules(habit(), [done(d(0)), done(d(1)), status(d(2), "missed")], d(3)),
            "missed صريح يقطع",
        ),
        (
            7,
            rules(habit(), [done(d(0)), status(d(1), "skip"), done(d(2))], d(2)),
            "تخطٍّ يجسر ولا يُعد",
        ),
        (
            8,
            rules(habit(), [done(d(0)), status(d(1), "vacation"), done(d(2))], d(2)),
            "إجازة تجسر ولا تُعد",
        ),
        (
            9,
            rules(_WEEKDAYS_MT, [done(d(0)), done(d(1)), done(d(7))], d(7)),
            "الأيام غير المجدولة تجسر",
        ),
        (10, rules(_N3, [done(d(0)), done(d(3)), done(d(6))], d(8)), "كل 3 أيام: ثلاث فترات"),
        (11, rules(_N3, [done(d(0)), done(d(6))], d(8)), "كل 3 أيام: فاتت d3"),
        (12, rules(habit(end_day=d(2)), daily_done(START, 3), d(2)), "تحدٍّ مكتمل في آخر يوم"),
        (13, rules(habit(end_day=d(2)), daily_done(START, 3), d(20)), "تحدٍّ مكتمل بعد الانتهاء"),
        (
            14,
            rules(habit(end_day=d(2)), daily_done(START, 2), d(3)),
            "آخر يوم فائت يُحكم صارماً بعد الانتهاء",
        ),
        (
            15,
            rules(habit(end_day=d(2)), daily_done(START, 2), d(2)),
            "يوم النهاية نفسه حالي فلا يكسر",
        ),
        (
            16,
            rules(_WEEKLY, [*week_done(_WK[1]), *week_done(_WK[8])], "2026-11-16"),
            "أسبوعان محققان والحالي محايد",
        ),
        (
            17,
            rules(
                _WEEKLY, [*week_done(_WK[1]), *week_done(_WK[8]), *week_done(_WK[15])], "2026-11-17"
            ),
            "الأسبوع الحالي يُعد حين يتحقق",
        ),
        (
            18,
            rules(
                _WEEKLY,
                [
                    *week_done(_WK[1]),
                    *week_status(_WK[8], "vacation"),
                    *week_done(_WK[15]),
                    done("2026-11-22"),
                ],
                "2026-11-23",
            ),
            "أسبوع إجازة كامل يجسر ولا يُعد",
        ),
        (
            19,
            rules(
                _WEEKLY,
                [*week_done(_WK[1]), *week_status(_WK[8], "skip"), *week_done(_WK[15])],
                "2026-11-23",
            ),
            "أسبوع تخطٍّ كامل يجسر",
        ),
        (
            20,
            rules(_WEEKLY, [*week_done(_WK[1]), *week_done(_WK[15])], "2026-11-23"),
            "أسبوع بلا سجلات يقطع",
        ),
        (
            21,
            rules(
                _WEEKLY,
                [*week_done(_WK[1]), *week_status(_WK[8], "vacation", 6), *week_done(_WK[15])],
                "2026-11-23",
            ),
            "إجازة 6 أيام من 7 ليست محايدة",
        ),
        (22, rules(_MONTHLY2, _MONTHLY2_LOGS, "2026-11-09"), "شهرية: سبتمبر ونوفمبر وأكتوبر محايد"),
        (23, rules(habit(), [*daily_done(START, 3), done(d(5))], d(2)), "سجل مستقبلي يُهمل"),
        (
            24,
            rules(weekly_bool(start_day=iso(THURSDAY)), [*_PART_W1, *_PART_W2], "2026-11-22"),
            "أسبوع أول مقصوص + كامل = 2",
        ),
        (
            25,
            rules(weekly_bool(start_day=iso(THURSDAY)), [*_PART_W1, *_PART_W2[:4]], "2026-11-22"),
            "أسبوع ثانٍ ناقص يقطع",
        ),
        (26, rules(_CH30, _CH30_LOGS, "2026-12-08"), "تحدي 30 يوماً أسبوعي من الأحد: 5 فترات"),
        (
            27,
            rules(_CH30, _CH30_SHORT, "2026-12-08"),
            "ينقص يوم النهاية: الفترة الأخيرة المقصوصة فائتة",
        ),
        (
            28,
            rules(_WEEKLY, [*week_done(_WK[1]), *week_done(_WK[8])], "2026-11-16", "sat"),
            "الحالة 016 ببداية السبت",
        ),
        (
            29,
            rules(_WEEKLY, [*week_done(_WK[1]), *week_done(_WK[8])], "2026-11-16", "mon"),
            "الحالة 016 ببداية الاثنين",
        ),
        (
            30,
            rules(_LEAP_DAILY, daily_done(date(2028, 2, 20), 11), "2028-03-01"),
            "يومية تعبر يوم الكبيسة",
        ),
    ],
)

# ---------------------------------------------------------------- challenge_progress

_CH_DAILY30 = habit(end_day="2026-12-08")
_CH_W2 = count(2.0, "week", end_day="2026-11-30")
_CH_W2_LOGS = [done("2026-11-09"), done("2026-11-10"), done("2026-11-16")]
_CH_M1 = count(1.0, "month", end_day="2027-01-20")
_CH_M10 = count(10.0, "month", start_day="2026-11-21", end_day="2027-01-10")
_CH_M10_LOGS = [
    *[done(d(i, date(2026, 11, 21))) for i in range(4)],
    *[done(d(i, date(2026, 12, 1))) for i in range(10)],
    *[done(d(i, date(2027, 1, 1))) for i in range(4)],
]

CHALLENGE_PROGRESS = _numbered(
    "challenge_progress",
    [
        (1, rules(habit(), daily_done(START, 5), d(5)), "بلا end_day: null"),
        (2, rules(_CH_DAILY30, daily_done(START, 10), d(11)), "يومية 30 يوماً: 10 من 30"),
        (3, rules(_CH_DAILY30, [], d(-8)), "قبل البداية: الباقي كامل النافذة"),
        (4, rules(_CH_DAILY30, [], d(0)), "يوم البداية"),
        (5, rules(_CH_DAILY30, [], "2026-12-07"), "قبل النهاية بيوم"),
        (6, rules(_CH_DAILY30, [], "2026-12-08"), "يوم النهاية: الباقي 1"),
        (7, rules(_CH_DAILY30, [], "2026-12-09"), "اليوم التالي للنهاية: الباقي 0"),
        (8, rules(_CH_DAILY30, [], "2027-03-01"), "بعد النهاية بكثير"),
        (
            9,
            rules(
                habit(end_day=d(9)),
                [done(d(0)), status(d(1), "skip"), status(d(2), "vacation")],
                d(3),
            ),
            "المتخطّاة تبقى في المقام",
        ),
        (
            10,
            rules(
                habit(schedule_kind="weekdays", weekday_mask=mask(MON, TUE), end_day=d(13)),
                [done(d(0)), done(d(1))],
                d(5),
            ),
            "المجدولة وحدها تُعد",
        ),
        (
            11,
            rules(duration(30.0, end_day=d(2)), [done(d(0), 30.0), done(d(1), 29.0)], d(2)),
            "المدة تحتاج الهدف كاملاً",
        ),
        (12, rules(_CH_W2, _CH_W2_LOGS, "2026-11-20"), "أسبوعية: الفترات المتقاطعة (أحد)"),
        (13, rules(_CH_W2, _CH_W2_LOGS, "2026-11-20", "mon"), "أسبوعية: الفترات المتقاطعة (اثنين)"),
        (14, rules(_CH_W2, _CH_W2_LOGS, "2026-11-20", "sat"), "أسبوعية: الفترات المتقاطعة (سبت)"),
        (
            15,
            rules(_CH_M1, [done("2026-11-15"), done("2026-12-03")], "2026-12-10"),
            "شهرية: 3 أشهر متقاطعة",
        ),
        (16, rules(_CH30, _CH30_LOGS, "2026-12-08"), "تحدي 30 يوماً أسبوعي مكتمل"),
        (17, rules(_CH30, _CH30_SHORT, "2026-12-08"), "ينقص يوم النهاية: 4 من 5"),
        (18, rules(_CH_M10, _CH_M10_LOGS, "2027-01-12"), "أشهر مقصوصة بأهداف متناسبة: 3 من 3"),
        (19, rules(_CH30, _CH30_LOGS, "2026-12-07"), "يوم النهاية نفسه: الباقي 1"),
        (
            20,
            rules(
                habit(start_day="2028-02-27", end_day="2028-03-02"),
                daily_done(date(2028, 2, 27), 5),
                "2028-03-02",
            ),
            "تحدٍّ يعبر 2028-02-29",
        ),
    ],
)

# ---------------------------------------------------------------- adherence

_HALF_HOUR = duration(0.5, "week", unit="hour", start_day=iso(THURSDAY))

ADHERENCE = _numbered(
    "adherence",
    [
        (1, rules(habit(), [], d(0)), "لم تنتهِ فترة: null"),
        (2, rules(habit(), [done(d(0))], d(1)), "بعد أول يوم محقق: 1"),
        (3, rules(habit(), [], d(1)), "بعد أول يوم فائت: 0"),
        (4, rules(habit(), [done(d(0)), done(d(1)), done(d(3))], d(4)), "3 من 4 أيام منتهية"),
        (5, rules(habit(), [done(d(0)), status(d(1), "skip")], d(3)), "التخطّي مستبعد: 1 من 2"),
        (6, rules(_WEEKDAYS_MT, [done(d(0))], d(4)), "غير المجدول مستبعد: الاثنين والثلاثاء"),
        (
            7,
            rules(habit(), [status(d(0), "vacation"), status(d(1), "skip")], d(2)),
            "كلها محايدة: null",
        ),
        (
            8,
            rules(_WEEKLY, [*week_done(_WK[1]), done("2026-11-08")], "2026-11-16"),
            "أسبوعية: 1 من 2",
        ),
        (
            9,
            rules(_WEEKLY, [*week_done(_WK[1]), done("2026-11-08")], "2026-11-07"),
            "الأسبوع الأول لم ينتهِ: null",
        ),
        (
            10,
            rules(_WEEKLY, [*week_done(_WK[1]), done("2026-11-08")], "2026-11-08"),
            "أول أسبوع انتهى محققاً",
        ),
        (
            11,
            rules(_WEEKLY, [*week_done(_WK[1]), *week_status(_WK[8], "vacation")], "2026-11-16"),
            "أسبوع إجازة مستبعد",
        ),
        (12, rules(habit(end_day=d(2)), [done(d(0)), done(d(1))], d(2)), "يوم النهاية لم ينتهِ"),
        (13, rules(habit(end_day=d(2)), [done(d(0)), done(d(1))], d(3)), "بعد النهاية: 2 من 3"),
        (
            14,
            rules(habit(end_day=d(2)), [done(d(0)), done(d(1))], d(50)),
            "بعد النهاية بكثير: الناتج ثابت",
        ),
        (
            15,
            rules(weekly_bool(start_day=iso(THURSDAY)), _PART_W1, "2026-11-15"),
            "أسبوع أول مقصوص محقق بهدفه المتناسب",
        ),
        (
            16,
            rules(weekly_bool(start_day=iso(THURSDAY)), [*_PART_W1, *_PART_W2[:4]], "2026-11-22"),
            "أسبوع ثانٍ ناقص: 0.5",
        ),
        (
            17,
            rules(_HALF_HOUR, [done(iso(THURSDAY), 0.5)], "2026-11-15"),
            "هدف 0.5 في أسبوع جزئي محقق",
        ),
        (
            18,
            rules(
                weekly_bool(start_day=iso(THURSDAY)),
                [status(iso(date(2026, 11, i)), "vacation") for i in (12, 13, 14)],
                "2026-11-15",
            ),
            "أسبوع جزئي كله إجازة: null",
        ),
        (19, rules(_CH30, _CH30_LOGS, "2026-12-08"), "تحدي 30 يوماً أسبوعي: 1"),
        (20, rules(_CH30, _CH30_SHORT, "2026-12-08"), "ينقص يوم النهاية: 4 من 5"),
        (
            21,
            rules(_WEEKLY, [*week_done(_WK[1]), done("2026-11-08")], "2026-11-16", "sat"),
            "الحالة 008 ببداية السبت",
        ),
        (
            22,
            rules(_WEEKLY, [*week_done(_WK[1]), done("2026-11-08")], "2026-11-16", "mon"),
            "الحالة 008 ببداية الاثنين",
        ),
    ],
)

# ---------------------------------------------------------------- goal_prefill


def _gp(
    goal: float, current: float, today: str, deadline: str, period: str, ws: str = "sun"
) -> dict[str, Any]:
    return {
        "goal_target": goal,
        "current": current,
        "today": today,
        "deadline": deadline,
        "period": period,
        "week_start": ws,
    }


GOAL_PREFILL = _numbered(
    "goal_prefill",
    [
        (1, _gp(100, 40, "2026-11-09", "2026-12-31", "week"), "القيمة الملزمة: 60 على 8 أسابيع"),
        (2, _gp(10, 0, "2026-11-14", "2026-11-15", "week", "sun"), "السبت والأحد في أسبوعين (أحد)"),
        (
            3,
            _gp(10, 0, "2026-11-14", "2026-11-15", "week", "sat"),
            "السبت والأحد في أسبوع واحد (سبت)",
        ),
        (
            4,
            _gp(10, 0, "2026-11-14", "2026-11-15", "week", "mon"),
            "السبت والأحد في أسبوع واحد (اثنين)",
        ),
        (5, _gp(100, 40, "2026-11-09", "2026-11-18", "day"), "10 أيام"),
        (6, _gp(100, 40, "2026-11-09", "2027-01-31", "month"), "3 أشهر"),
        (7, _gp(100, 40, "2026-11-30", "2026-12-01", "month"), "يومان في شهرين"),
        (8, _gp(10, 0, "2026-11-09", "2026-11-11", "day"), "10/3 يُقرَّب لأعلى"),
        (9, _gp(100, 100, "2026-11-09", "2026-12-31", "week"), "الهدف محقق: الحد الأدنى 1"),
        (10, _gp(100, 150, "2026-11-09", "2026-12-31", "week"), "الهدف متجاوز: الحد الأدنى 1"),
        (11, _gp(100, 40, "2026-11-09", "2026-11-09", "day"), "الموعد اليوم: فترة واحدة"),
        (12, _gp(100, 40, "2026-11-09", "2026-11-01", "week"), "الموعد فات: فترة واحدة"),
        (13, _gp(100, 40, "2026-11-09", "2026-10-01", "month"), "الموعد فات بشهر: فترة واحدة"),
        (14, _gp(2.2, 1.2, "2026-11-09", "2026-11-09", "day"), "ضجيج 2.2 − 1.2 لا يرفع إلى 2"),
        (15, _gp(56, 0, "2026-11-09", "2026-11-15", "day"), "56 على 7 أيام = 8"),
        (
            16,
            _gp(56.000000004, 0, "2026-11-09", "2026-11-15", "day"),
            "8.00000000057 ضمن الهامش → 8",
        ),
        (17, _gp(56.0000000035, 0, "2026-11-09", "2026-11-15", "day"), "8.0000000005 → 8"),
        (18, _gp(56.00000002, 0, "2026-11-09", "2026-11-15", "day"), "8.0000000029 فوق الهامش → 9"),
        (19, _gp(10, 0, "2026-11-09", "2026-11-12", "day"), "كسر: 10/4 = 2.5 → 3"),
        (20, _gp(15, 0, "2026-11-08", "2026-11-21", "week"), "كسر: 15/2 = 7.5 → 8"),
        (21, _gp(7, 0, "2026-11-01", "2026-11-30", "month"), "7 على شهر واحد"),
        (22, _gp(100, 10, "2028-01-15", "2028-03-01", "month"), "3 أشهر تشمل فبراير الكبيسة"),
        (23, _gp(9, 0, "2028-02-27", "2028-02-29", "day"), "الموعد يوم الكبيسة: 3 أيام"),
        (24, _gp(30, 2.5, "2026-11-09", "2026-11-19", "day"), "كسر في الحالي: 27.5/11 = 2.5 → 3"),
    ],
)

# ---------------------------------------------------------------- baseline


# خط الأساس ليوم `day` من ليالٍ مؤرخة (D-065): النافذة الأيام التقويمية الـ28 [day − 28، day − 1]،
# وأقل من 7 ليالٍ فيها `null`، و`full` إن حوت كل كتلة من الكتل الأربع ذات السبعة أيام 4 ليالٍ على
# الأقل، وإلا `provisional`. الليالي تُكتب هنا بعدد الأيام قبل اليوم المقيَّم (1 = أمس ... 28 = أقدم
# يوم في النافذة؛ 0 = اليوم نفسه و29 فأكثر قبل النافذة، وكلاهما خارجها). الكتل بهذا العدّ:
# 22..28 و15..21 و8..14 و1..7. لا تاريخ يتكرر في حالة واحدة.

BASE_DAY = date(2026, 12, 1)  # النافذة 2026-11-03 .. 2026-11-30
LEAP_EDGE_DAY = date(2028, 3, 28)  # النافذة تبدأ في 2028-02-29
OUTSIDE = 1000.0  # قيمة لليالي خارج النافذة: لو حُسبت لأفسدت المتوسط


def night(offset: int, value: float = 60.0, day: date = BASE_DAY) -> dict[str, Any]:
    return {"day": iso(day - timedelta(days=offset)), "value": value}


def nights(offsets: Any, value: float = 60.0, day: date = BASE_DAY) -> list[dict[str, Any]]:
    """ليالٍ بقيمة واحدة، من الأقدم إلى الأحدث."""
    return [night(k, value, day) for k in sorted(offsets, reverse=True)]


def valued(pairs: list[tuple[int, float]], day: date = BASE_DAY) -> list[dict[str, Any]]:
    """ليالٍ `(كم يوماً قبل اليوم، القيمة)` بالترتيب المعطى."""
    return [night(k, v, day) for k, v in pairs]


def varied(offsets: Any, base: float = 55.0, day: date = BASE_DAY) -> list[dict[str, Any]]:
    """ليالٍ بقيم متنوعة محدَّدة من موضعها، من الأقدم إلى الأحدث."""
    return [night(k, base + (k * 7 % 11) * 0.5, day) for k in sorted(offsets, reverse=True)]


def _bl(
    night_list: list[dict[str, Any]], day: date = BASE_DAY, log: bool = False
) -> dict[str, Any]:
    return {"nights": night_list, "day": iso(day), "log": log}


def _flat(n: int, quality: str) -> tuple[dict[str, Any], float]:
    """القيمة المعلنة حين كل ليالي النافذة 60: المتوسط 60 والانحراف 0، و`n` و`quality` من القاعدة."""
    return {"mean": 60.0, "sd": 0.0, "n": n, "quality": quality}, 1e-9


_NO_BASELINE = (None, 0.0)
# 16 ليلة، 4 في كل كتلة، وفي كل من الكتل الثلاث الأقدم ليلة على حدّها الأحدث (22 و15 و8)
_FULL16 = (28, 27, 26, 22, 20, 19, 18, 15, 13, 12, 11, 8, 6, 5, 4, 3)
_WINDOW_EDGES = (28, 27, 20, 14, 9, 2, 1)  # 7 ليالٍ منها طرفا النافذة
_RHR7 = [(7, 50.0), (6, 60.0), (5, 70.0), (4, 50.0), (3, 60.0), (2, 70.0), (1, 60.0)]
_HRV7 = [(7, 40.0), (6, 50.0), (5, 60.0), (4, 45.0), (3, 55.0), (2, 65.0), (1, 50.0)]


def _moved(a: int, b: int) -> tuple[int, ...]:
    """`_FULL16` بعد نقل الليلة `a` إلى `b` (عبور حد داخلي بين كتلتين)."""
    return tuple(b if k == a else k for k in _FULL16)


BASELINE = _numbered(
    "baseline",
    [
        (1, _bl(nights(range(1, 7))), "6 ليالٍ في النافذة: لا خط أساس", None, _NO_BASELINE),
        (2, _bl([]), "بلا ليالٍ: null", None, _NO_BASELINE),
        (
            3,
            _bl(nights(range(1, 8))),
            "7 ليالٍ متتالية كلها في الكتلة الأحدث: أولي",
            None,
            _flat(7, "provisional"),
        ),
        (4, _bl(nights(_FULL16)), "16 ليلة، 4 في كل كتلة: كامل", None, _flat(16, "full")),
        (
            5,
            _bl(nights(_moved(22, 21))),
            "ليلة تعبر الحد 22|21: الكتلة الأقدم صارت 3 → أولي",
            None,
            _flat(16, "provisional"),
        ),
        (
            6,
            _bl(nights(_moved(15, 14))),
            "ليلة تعبر الحد 15|14: الكتلة الثانية صارت 3 → أولي",
            None,
            _flat(16, "provisional"),
        ),
        (
            7,
            _bl(nights(_moved(8, 7))),
            "ليلة تعبر الحد 8|7: الكتلة الثالثة صارت 3 → أولي",
            None,
            _flat(16, "provisional"),
        ),
        (
            8,
            _bl([night(29, OUTSIDE), *nights(_FULL16), night(0, OUTSIDE)]),
            "ليلتان خارج النافذة (اليوم − 29، واليوم نفسه) تُهملان: الناتج كالحالة 004",
            None,
            _flat(16, "full"),
        ),
        (
            9,
            _bl([night(30, OUTSIDE), night(29, OUTSIDE), *nights(range(1, 7)), night(0, OUTSIDE)]),
            "6 في النافذة و3 خارجها: ما زال null",
            None,
            _NO_BASELINE,
        ),
        (
            10,
            _bl(nights(range(1, 25))),
            "24 ليلة متتالية حتى أمس: الكتلة الأقدم فيها 3 → أولي",
            None,
            _flat(24, "provisional"),
        ),
        (
            11,
            _bl(nights(range(1, 26))),
            "25 ليلة متتالية حتى أمس: الكتلة الأقدم بلغت 4 → كامل",
            None,
            _flat(25, "full"),
        ),
        (
            12,
            _bl(nights(range(5, 29))),
            "24 متتالية من أقدم النافذة: الكتلة الأحدث فيها 3 → أولي",
            None,
            _flat(24, "provisional"),
        ),
        (
            13,
            _bl(nights(range(4, 29))),
            "25 متتالية من أقدم النافذة: كامل",
            None,
            _flat(25, "full"),
        ),
        (14, _bl(nights(range(1, 29))), "النافذة كلها: n = 28 وكامل", None, _flat(28, "full")),
        (
            15,
            _bl([*nights(range(29, 40), OUTSIDE), *nights(range(1, 29)), night(0, OUTSIDE)]),
            "40 ليلة متتالية (11 قبل النافذة واليوم نفسه): n = 28 فقط",
            None,
            _flat(28, "full"),
        ),
        (
            16,
            _bl(nights(_WINDOW_EDGES)),
            "طرفا النافذة (اليوم − 28 واليوم − 1) يُحسبان: 7 ليالٍ",
            None,
            _flat(7, "provisional"),
        ),
        (
            17,
            _bl(nights((29, 27, 20, 14, 9, 2, 1))),
            "الحالة 016 وأقدم لياليها أُزيحت إلى اليوم − 29: 6 في النافذة → null",
            None,
            _NO_BASELINE,
        ),
        (
            18,
            _bl(nights((28, 27, 20, 14, 9, 2, 0))),
            "الحالة 016 وأحدث لياليها أُزيحت إلى اليوم نفسه: 6 في النافذة → null",
            None,
            _NO_BASELINE,
        ),
        (
            19,
            _bl(nights(_FULL16[:-1])),
            "4 و4 و4 و3: كتلة واحدة ناقصة تكفي للأولي",
            None,
            _flat(15, "provisional"),
        ),
        (
            20,
            _bl(nights(range(1, 22))),
            "21 ليلة والكتلة الأقدم فارغة: أولي",
            None,
            _flat(21, "provisional"),
        ),
        (
            21,
            _bl(valued(_RHR7)),
            "المتوسط 60 والانحراف المعياري للعيّنة sqrt(400/6)",
            None,
            ({"mean": 60.0, "sd": 8.16496580927726, "n": 7, "quality": "provisional"}, 1e-9),
        ),
        (22, _bl(varied(_FULL16)), "16 ليلة بقيم متنوعة: كامل"),
        (
            23,
            _bl([night(29, OUTSIDE), *varied(_FULL16), night(0, OUTSIDE)]),
            "الحالة 022 مع ليلتين خارج النافذة: المتوسط والانحراف لا يتغيران",
        ),
        (24, _bl(list(reversed(varied(_FULL16)))), "الحالة 022 بترتيب معكوس (الأحدث أولاً)"),
        (
            25,
            _bl(valued(_HRV7), log=True),
            "HRV على مقياس ln: المتوسط ≈ 3.942236 والانحراف ≈ 0.166165",
            None,
            ({"mean": 3.942236, "sd": 0.166165, "n": 7, "quality": "provisional"}, 1e-6),
        ),
        (26, _bl(varied(_FULL16, base=42.5), log=True), "16 ليلة بمقياس ln: كامل"),
        (
            27,
            _bl(varied(range(1, 26), day=date(2028, 3, 15)), day=date(2028, 3, 15)),
            "25 ليلة متتالية تعبر 2028-02-29: كامل",
        ),
        (
            28,
            _bl(nights(_WINDOW_EDGES, day=LEAP_EDGE_DAY), day=LEAP_EDGE_DAY),
            "أقدم يوم في النافذة هو 2028-02-29 ويُحسب",
            None,
            _flat(7, "provisional"),
        ),
        (
            29,
            _bl(nights((29, 27, 20, 14, 9, 2, 1), day=LEAP_EDGE_DAY), day=LEAP_EDGE_DAY),
            "ليلة 2028-02-28 قبل النافذة بيوم: 6 في النافذة → null",
            None,
            _NO_BASELINE,
        ),
    ],
)

# ---------------------------------------------------------------- recovery


def _rc(z_hrv: float, z_rhr: float, z_sleep: float, penalty: float = 0.0) -> dict[str, Any]:
    return {"z_hrv": z_hrv, "z_rhr": z_rhr, "z_sleep": z_sleep, "penalty": penalty}


RECOVERY = _numbered(
    "recovery",
    [
        (1, _rc(0, 0, 0), "الحياد: 50", None, (50, 0)),
        (2, _rc(1, 0, 0), "انحراف معياري واحد في HRV: 69", None, (69, 0)),
        (3, _rc(-5, -5, -5), "قصّ عند 0"),
        (4, _rc(5, 5, 5), "قصّ عند 100"),
        (5, _rc(0, 0, 0, 10.0), "العقوبة تُطرح قبل القصّ: 40"),
        (6, _rc(5, 5, 5, 10.0), "العقوبة من 100: 90"),
        (7, _rc(-5, -5, -5, 10.0), "العقوبة لا تنزل تحت 0"),
        (8, _rc(0, 0, 0, 0.5), "تقريب نصفي لأعلى: 49.5 → 50", None, (50, 0)),
        (9, _rc(0, 0, 0, 1.5), "تقريب نصفي لأعلى: 48.5 → 49", None, (49, 0)),
        (10, _rc(0, 0, 0, 2.5), "تقريب نصفي لأعلى: 47.5 → 48", None, (48, 0)),
        (11, _rc(2, 0, 0), "وزن HRV 0.5: Φ(1.0) → 84", None, (84, 0)),
        (12, _rc(0, 2, 0), "وزن RHR 0.3: Φ(0.6) → 73", None, (73, 0)),
        (13, _rc(0, 0, 2), "وزن النوم 0.2: Φ(0.4) → 66", None, (66, 0)),
        (14, _rc(0, -1, 0), "نبض راحة أعلى من الأساس: المستدعي يقلب الإشارة فيمرّر −1"),
        (15, _rc(0.3, -0.2, 0.1), "قيم كسرية مختلطة"),
        (16, _rc(-1.2, 0.4, -0.6, 3.0), "تراجع مع عقوبة تنفس"),
        (17, _rc(1.5, 1.0, 0.5, 2.5), "تعافٍ عالٍ مع عقوبة بنصف"),
    ],
)

# ---------------------------------------------------------------- trimp


def _tr(minutes: float, hr_reserve: float, female: bool = False) -> dict[str, Any]:
    return {"minutes": minutes, "hr_reserve": hr_reserve, "female": female}


TRIMP = _numbered(
    "trimp",
    [
        (1, _tr(10, 0.5), "القيمة المرجعية للذكور: ≈ 8.357", None, (8.357, 0.01)),
        (2, _tr(10, 0.5, True), "الثوابت الأنثوية (0.86، 1.67)"),
        (3, _tr(0, 0.5), "بلا دقائق: 0"),
        (4, _tr(10, 0.0), "بلا احتياطي نبض: 0"),
        (5, _tr(-5, 0.5), "الدقائق السالبة تُقصّ إلى 0"),
        (6, _tr(10, 1.5), "r فوق 1 يُقصّ إلى 1"),
        (7, _tr(10, 1.0), "r = 1 بالضبط = الحالة 006"),
        (8, _tr(10, -0.2), "r سالب يُقصّ إلى 0"),
        (9, _tr(60, 0.8), "ساعة بجهد عالٍ"),
        (10, _tr(45, 0.65, True), "45 دقيقة بالثوابت الأنثوية"),
        (11, _tr(30.5, 0.42), "كسور في الدقائق والاحتياطي"),
    ],
)

# ---------------------------------------------------------------- strain

STRAIN = _numbered(
    "strain",
    [
        (1, {"trimp_total": 0}, "لا حمل: 0"),
        (2, {"trimp_total": 1e6}, "تشبّع عند 21", None, (21.0, 1e-9)),
        (
            3,
            {"trimp_total": 120},
            "القيمة المرجعية: 21·(1 − e⁻¹)",
            None,
            (21 * (1 - 2.718281828459045**-1), 1e-9),
        ),
        (4, {"trimp_total": 240}, "ضعف المقياس"),
        (5, {"trimp_total": -50}, "الحمل السالب صفر"),
        (6, {"trimp_total": 30}, "حمل خفيف"),
        (7, {"trimp_total": 8.357}, "حمل مقطع واحد"),
        (8, {"trimp_total": 60.5}, "كسور"),
    ],
)

# ---------------------------------------------------------------- عادة الامتناع (rulesVersion 2)

# التصميم §9.6: امتناع يومي من 2026-11-01، واليوم 2026-11-10. سجل `done` معناه انزلاق، وكل يوم
# مجدول حتى اليوم شاملاً محفوظ ما لم يُسجَّل فيه انزلاق، و`skip` و`vacation` محايدان.
_ABSTAIN_TODAY = "2026-11-10"
_ABSTAIN_EXAMPLES: tuple[tuple[str, list[dict[str, Any]], str], ...] = (
    ("clean", [], "P1: بلا سجلات، كل الأيام العشرة محفوظة"),
    ("slip-mid", [done("2026-11-05")], "P2: انزلاق في 11-05"),
    ("slip-today", [done(_ABSTAIN_TODAY)], "P3: انزلاق اليوم، فاليوم فوات لا معلّق"),
    ("skip-neutral", [status("2026-11-05", "skip")], "P4: تخطٍّ في 11-05 محايد"),
)


def _abstain_spec(end: str | None = None) -> dict[str, Any]:
    return habit(start_day="2026-11-01", end_day=end, polarity="abstain")


def _today_progress(kept: bool) -> dict[str, Any]:
    """تقدّم اليوم في §9.6: `done = 1` و`reached` بلا انزلاق، و`done = 0` بانزلاق، و`expected = 1`."""
    value = 1.0 if kept else 0.0
    return {
        "done": value,
        "target": 1.0,
        "completion": value,
        "reached": kept,
        "expected": 1.0,
        "on_track": kept,
        "need_per_day": 1.0 - value,
    }


def _ch(achieved: int) -> dict[str, Any]:
    return {"achieved": achieved, "total": 30, "completion": achieved / 30, "remaining_days": 20}


# القيم المثبّتة من جدول §9.6 (strength بهامش 1e-6)، و`challenge_progress` بنهاية 2026-11-30 حيث
# أعطى التصميم قيمة (P1 وP2).
_ABSTAIN_PINS: dict[str, dict[str, tuple[Any, float]]] = {
    "period_progress": {
        "clean": (_today_progress(True), 1e-9),
        "slip-mid": (_today_progress(True), 1e-9),
        "slip-today": (_today_progress(False), 1e-9),
        "skip-neutral": (_today_progress(True), 1e-9),
    },
    "strength": {
        "clean": (0.413270, 1e-6),
        "slip-mid": (0.373498, 1e-6),
        "slip-today": (0.361347, 1e-6),
        "skip-neutral": (0.381137, 1e-6),
    },
    "streak": {
        "clean": (10, 0.0),
        "slip-mid": (5, 0.0),
        "slip-today": (0, 0.0),
        "skip-neutral": (9, 0.0),
    },
    "challenge_progress": {"clean": (_ch(10), 1e-9), "slip-mid": (_ch(9), 1e-9)},
    "adherence": {
        "clean": (1.0, 1e-9),
        "slip-mid": (0.9, 1e-9),
        "slip-today": (0.9, 1e-9),
        "skip-neutral": (1.0, 1e-9),
    },
}


def _abstain_cases(fn: str) -> list[Case]:
    """حالات الامتناع الأربع لدالة: `<fn>-abstain-clean` و`-slip-mid` و`-slip-today` و`-skip-neutral`."""
    end = "2026-11-30" if fn == "challenge_progress" else None
    return [
        Case(
            id=f"{fn}-abstain-{name}",
            input=rules(_abstain_spec(end), logs, _ABSTAIN_TODAY),
            source=f"الامتناع (§9.6) {source}",
            pin=_ABSTAIN_PINS[fn].get(name),
        )
        for name, logs, source in _ABSTAIN_EXAMPLES
    ]


PERIOD_PROGRESS += _abstain_cases("period_progress")
STRENGTH += _abstain_cases("strength")
STREAK += _abstain_cases("streak")
CHALLENGE_PROGRESS += _abstain_cases("challenge_progress")
ADHERENCE += _abstain_cases("adherence")

CASES: dict[str, list[Case]] = {
    "day_key": DAY_KEY,
    "period_bounds": PERIOD_BOUNDS,
    "is_scheduled": IS_SCHEDULED,
    "end_day": END_DAY,
    "period_progress": PERIOD_PROGRESS,
    "strength": STRENGTH,
    "streak": STREAK,
    "challenge_progress": CHALLENGE_PROGRESS,
    "adherence": ADHERENCE,
    "goal_prefill": GOAL_PREFILL,
    "baseline": BASELINE,
    "recovery": RECOVERY,
    "trimp": TRIMP,
    "strain": STRAIN,
}

if tuple(CASES) != FUNCTIONS:
    raise ValueError("ترتيب CASES يجب أن يطابق FUNCTIONS")
