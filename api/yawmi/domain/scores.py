"""الدرجات الصحية المشتقة: خط الأساس، والتعافي، وTRIMP، والإجهاد، وجودة البيانات.

دوال نقية بلا إدخال/إخراج ولا حالة. المنهج معلن (المواصفة § 3.3) ويقوم على خط أساس شخصي لا
على عتبات عامة. الثوابت هنا هي المصدر الوحيد لها، ولا تُكرَّر في المسارات.
"""

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

WINDOW_DAYS = 28
"""نافذة خط الأساس: الأيام التقويمية الـ28 السابقة لليوم، [اليوم − 28، اليوم − 1] (D-065)."""

MIN_NIGHTS = 7
"""أقل من هذا العدد من الليالي الصالحة في النافذة: لا خط أساس."""

WEEK_DAYS = 7
"""طول كتلة الأسبوع داخل النافذة: أربع كتل متتالية من 7 أيام."""

MIN_NIGHTS_PER_WEEK = 4
"""خط الأساس «كامل» إن حوت كل كتلة أسبوع 4 ليالٍ صالحة على الأقل (المواصفة § 3.3، D-065)."""

WEIGHT_HRV = 0.5
WEIGHT_RHR = 0.3
WEIGHT_SLEEP = 0.2

TRIMP_MALE = (0.64, 1.92)
TRIMP_FEMALE = (0.86, 1.67)

STRAIN_MAX = 21.0
STRAIN_SCALE = 120.0

MIN_HRV_SAMPLES = 3
"""أقل من هذا العدد من عيّنات HRV في الليلة: جودة «منخفضة»."""

BaselineQuality = Literal["provisional", "full"]
DataQuality = Literal["missing", "low", "ok"]

_LOG_POSITIVE_MESSAGE = "log scale requires strictly positive values"


def _require_finite(**values: float) -> None:
    """يرفع `ValueError` إن كانت أي قيمة مسمّاة غير منتهية (NaN أو ±inf)."""
    for name, value in values.items():
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite, got {value!r}")


@dataclass(frozen=True)
class Baseline:
    """خط أساس شخصي: المتوسط والانحراف المعياري وعدد الليالي وجودته.

    عند حسابه بـ`log=True` (HRV) يكون `mean` و`sd` على مقياس ln(x) لا على القيم الخام.
    """

    mean: float
    sd: float
    n: int
    quality: BaselineQuality


def baseline_window(day: date) -> tuple[date, date]:
    """نافذة خط الأساس ليوم `day`: [day − 28، day − 1] شاملة الطرفين."""
    return day - timedelta(days=WINDOW_DAYS), day - timedelta(days=1)


def baseline_quality(nights: Sequence[date], day: date) -> BaselineQuality | None:
    """جودة خط الأساس من تواريخ الليالي الصالحة (D-065).

    تُحسب الليالي داخل النافذة فقط. أقل من 7: `None`. `full` إن حوت كل كتلة من الكتل الأربع
    [day−28..day−22] و[day−21..day−15] و[day−14..day−8] و[day−7..day−1] 4 ليالٍ على الأقل،
    وإلا `provisional`. التاريخ المكرر يُعدّ ليلة واحدة.
    """
    first, last = baseline_window(day)
    inside = {d for d in nights if first <= d <= last}
    if len(inside) < MIN_NIGHTS:
        return None
    per_block = [0] * (WINDOW_DAYS // WEEK_DAYS)
    for d in inside:
        per_block[(d - first).days // WEEK_DAYS] += 1
    return "full" if min(per_block) >= MIN_NIGHTS_PER_WEEK else "provisional"


def baseline(nights: Sequence[tuple[date, float]], day: date, log: bool = False) -> Baseline | None:
    """خط الأساس الشخصي ليوم `day` من ليالٍ صالحة مؤرخة `(تاريخ، قيمة)`.

    على المستدعي أن يمرّر الليالي الصالحة وحدها (بلا قيم فارغة ولا أصفار)؛ والدالة تأخذ منها
    ما وقع في النافذة [day − 28، day − 1] وتهمل ما سواه. الجودة من `baseline_quality`. المتوسط
    والانحراف المعياري للعيّنة (قسمة على n−1) على كل القيم في النافذة، وعلى ln(x) إن كان `log`
    (لـHRV). تُرفض القيم غير المنتهية بـ`ValueError`، وكذلك غير الموجبة في وضع `log`.
    """
    first, last = baseline_window(day)
    inside = [(d, v) for d, v in nights if first <= d <= last]
    quality = baseline_quality([d for d, _ in inside], day)
    if quality is None:
        return None
    values = [v for _, v in inside]
    for v in values:
        _require_finite(value=v)
    if log:
        if any(v <= 0 for v in values):
            raise ValueError(_LOG_POSITIVE_MESSAGE)
        values = [math.log(v) for v in values]
    return Baseline(
        mean=statistics.fmean(values),
        sd=statistics.stdev(values),
        n=len(values),
        quality=quality,
    )


def zscore(value: float, baseline: Baseline, log: bool = False) -> float:
    """الدرجة المعيارية: z = (x − mean) / sd، وx = ln(value) إن كان `log`.

    في وضع `log` يُرفض `value ≤ 0` بـ`ValueError` (بالرسالة نفسها كما في `baseline`) قبل أي
    لوغاريتم، وتُرفض القيمة غير المنتهية. إن كان sd = 0 فالنتيجة 0 (لا تباين في خط الأساس).
    """
    _require_finite(value=value)
    if log:
        if value <= 0:
            raise ValueError(_LOG_POSITIVE_MESSAGE)
        x = math.log(value)
    else:
        x = value
    if baseline.sd == 0:
        return 0.0
    return (x - baseline.mean) / baseline.sd


def _phi(x: float) -> float:
    """دالة التوزيع التراكمي للتوزيع الطبيعي المعياري Φ(x) = ½·(1 + erf(x/√2))."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def recovery(z_hrv: float, z_rhr: float, z_sleep: float, penalty: float = 0.0) -> int:
    """التعافي من 0 إلى 100.

    المعادلة: ⌊100·Φ(0.5·z_hrv + 0.3·z_rhr + 0.2·z_sleep) − penalty + 0.5⌋ (تقريب نحو الأعلى
    عند المنتصف، لا تقريب المصرفيين في بايثون، ليتطابق مع منفَّذَي TypeScript وSwift)، ثم يُقصّ
    إلى [0, 100]. العقوبة (انحراف التنفس أو الحرارة) تُطرح قبل القصّ. إشارة كل z مسؤولية
    المستدعي. تُرفض المدخلات غير المنتهية بـ`ValueError`.
    """
    _require_finite(z_hrv=z_hrv, z_rhr=z_rhr, z_sleep=z_sleep, penalty=penalty)
    combined = WEIGHT_HRV * z_hrv + WEIGHT_RHR * z_rhr + WEIGHT_SLEEP * z_sleep
    score = math.floor(100.0 * _phi(combined) - penalty + 0.5)
    return max(0, min(100, score))


def trimp(minutes: float, hr_reserve: float, female: bool = False) -> float:
    """حمل Banister (TRIMP) لمقطع واحد من التمرين.

    المعادلة: minutes · r · a · exp(b·r)، وr احتياطي النبض (0 إلى 1)، و(a, b) = (0.64, 1.92)
    للذكور و(0.86, 1.67) للإناث. تُقصّ الدقائق السالبة إلى 0 وr إلى [0, 1]، وتُرفض المدخلات
    غير المنتهية (NaN وinf) بـ`ValueError`.
    """
    _require_finite(minutes=minutes, hr_reserve=hr_reserve)
    a, b = TRIMP_FEMALE if female else TRIMP_MALE
    minutes = max(0.0, minutes)
    r = min(1.0, max(0.0, hr_reserve))
    return minutes * r * a * math.exp(b * r)


def strain(trimp_total: float) -> float:
    """الإجهاد من 0 إلى 21 بمنحنى مشبِع.

    المعادلة: 21·(1 − exp(−TRIMP/120))؛ يقترب من 21 ولا يتجاوزه. الحمل السالب يُعامَل صفراً،
    ويُرفض الحمل غير المنتهي (NaN وinf) بـ`ValueError`.
    """
    _require_finite(trimp_total=trimp_total)
    total = max(0.0, trimp_total)
    return STRAIN_MAX * (1.0 - math.exp(-total / STRAIN_SCALE))


def data_quality(has_watch_night: bool, hrv_samples: int) -> DataQuality:
    """جودة بيانات الليلة: `missing` بلا ليلة ساعة، و`low` إن كانت عيّنات HRV أقل من 3، وإلا `ok`.

    الليلة «ناقصة» لا صفراً، ولا تدخل خط الأساس (المواصفة § 3.3).
    """
    if not has_watch_night:
        return "missing"
    if hrv_samples < MIN_HRV_SAMPLES:
        return "low"
    return "ok"
