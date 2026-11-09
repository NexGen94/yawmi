"""الدرجات الصحية المشتقة: خط الأساس، والتعافي، وTRIMP، والإجهاد، وجودة البيانات.

دوال نقية بلا إدخال/إخراج ولا حالة. المنهج معلن (المواصفة § 3.3) ويقوم على خط أساس شخصي لا
على عتبات عامة. الثوابت هنا هي المصدر الوحيد لها، ولا تُكرَّر في المسارات.
"""

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

WINDOW_DAYS = 28
"""نافذة خط الأساس: آخر 28 قيمة."""

MIN_NIGHTS = 7
"""أقل من هذا العدد: لا خط أساس."""

FULL_NIGHTS = 14
"""من هذا العدد فصاعداً: خط الأساس «كامل»، وما دونه (من 7) «أولي»."""

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


@dataclass(frozen=True)
class Baseline:
    """خط أساس شخصي: المتوسط والانحراف المعياري وعدد الليالي وجودته.

    عند حسابه بـ`log=True` (HRV) يكون `mean` و`sd` على مقياس ln(x) لا على القيم الخام.
    """

    mean: float
    sd: float
    n: int
    quality: BaselineQuality


def baseline(values: Sequence[float], log: bool = False) -> Baseline | None:
    """خط الأساس على آخر 28 قيمة (مرتبة من الأقدم إلى الأحدث).

    المعادلة: n = عدد القيم المستخدمة؛ `None` إن كان n < 7؛ `provisional` إن كان n < 14؛
    وإلا `full`. المتوسط والانحراف المعياري للعيّنة (قسمة على n−1)، وعلى ln(x) إن كان `log`
    (لـHRV). في وضع `log` تُرفض القيم غير الموجبة بـ`ValueError`.
    """
    window = list(values[-WINDOW_DAYS:])
    n = len(window)
    if n < MIN_NIGHTS:
        return None
    if log:
        if any(v <= 0 for v in window):
            raise ValueError("log baseline requires strictly positive values")
        window = [math.log(v) for v in window]
    quality: BaselineQuality = "provisional" if n < FULL_NIGHTS else "full"
    return Baseline(
        mean=statistics.fmean(window),
        sd=statistics.stdev(window),
        n=n,
        quality=quality,
    )


def zscore(value: float, baseline: Baseline, log: bool = False) -> float:
    """الدرجة المعيارية: z = (x − mean) / sd، وx = ln(value) إن كان `log`.

    إن كان sd = 0 فالنتيجة 0 (لا تباين في خط الأساس، فلا انحراف يُقاس).
    """
    x = math.log(value) if log else value
    if baseline.sd == 0:
        return 0.0
    return (x - baseline.mean) / baseline.sd


def _phi(x: float) -> float:
    """دالة التوزيع التراكمي للتوزيع الطبيعي المعياري Φ(x) = ½·(1 + erf(x/√2))."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def recovery(z_hrv: float, z_rhr: float, z_sleep: float, penalty: float = 0.0) -> int:
    """التعافي من 0 إلى 100.

    المعادلة: round(100·Φ(0.5·z_hrv + 0.3·z_rhr + 0.2·z_sleep) − penalty)، ثم يُقصّ إلى [0, 100].
    العقوبة (انحراف التنفس أو الحرارة) تُطرح قبل القصّ. إشارة كل z مسؤولية المستدعي.
    """
    combined = WEIGHT_HRV * z_hrv + WEIGHT_RHR * z_rhr + WEIGHT_SLEEP * z_sleep
    score = round(100.0 * _phi(combined) - penalty)
    return max(0, min(100, score))


def trimp(minutes: float, hr_reserve: float, female: bool = False) -> float:
    """حمل Banister (TRIMP) لمقطع واحد من التمرين.

    المعادلة: minutes · r · a · exp(b·r)، وr احتياطي النبض (0 إلى 1)، و(a, b) = (0.64, 1.92)
    للذكور و(0.86, 1.67) للإناث. تُقصّ الدقائق السالبة إلى 0 وr إلى [0, 1].
    """
    a, b = TRIMP_FEMALE if female else TRIMP_MALE
    minutes = max(0.0, minutes)
    r = max(0.0, min(1.0, hr_reserve))
    return minutes * r * a * math.exp(b * r)


def strain(trimp_total: float) -> float:
    """الإجهاد من 0 إلى 21 بمنحنى مشبِع.

    المعادلة: 21·(1 − exp(−TRIMP/120))؛ يقترب من 21 ولا يتجاوزه. الحمل السالب يُعامَل صفراً.
    """
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
