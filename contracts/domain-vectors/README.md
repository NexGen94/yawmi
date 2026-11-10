# متجهات النطاق المشتركة `contracts/domain-vectors/v1`

المصدر الوحيد لقواعد العادات والدرجات الصحية بين العملاء: بايثون هو التنفيذ المرجعي، ومنه تُولَّد
هذه الملفات، وعلى TypeScript (Vitest) وSwift (Swift Testing) اجتياز الملفات نفسها. القواعد نفسها
موثقة في المواصفة §2.6 (العادات) و§3.3 (الدرجات)، والأحكام الملزمة في D-062.

## الملفات

أربعة عشر ملفاً، ملف لكل دالة، باسم الدالة بصيغة `snake_case`:

| الملف | الدالة المرجعية | المدخلات | `expect.value` |
|---|---|---|---|
| `day_key.json` | `yawmi.domain.days.day_key` | `instant` (ISO بـ`Z`)، `tz` | `YYYY-MM-DD` |
| `period_bounds.json` | `periods.period_bounds` | `day`، `period`، `week_start` | `{start, end}` |
| `is_scheduled.json` | `periods.is_scheduled` | `day`، `habit` | `true`/`false` |
| `end_day.json` | `periods.end_day` | `start`، `duration_days` | `YYYY-MM-DD` |
| `period_progress.json` | `habits.period_progress` | `habit`، `logs`، `today`، `week_start` | `{done, target, completion, reached, expected, on_track, need_per_day}` |
| `strength.json` | `habits.strength` | كذلك | عدد في `[0, 1]` |
| `streak.json` | `habits.streak` | كذلك | عدد صحيح |
| `challenge_progress.json` | `habits.challenge_progress` | كذلك | `{achieved, total, completion, remaining_days}` أو `null` |
| `adherence.json` | `habits.adherence` | كذلك | عدد في `[0, 1]` أو `null` |
| `goal_prefill.json` | `habits.goal_prefill` | `goal_target`، `current`، `today`، `deadline`، `period`، `week_start` | عدد صحيح |
| `baseline.json` | `scores.baseline` (وبه `scores.baseline_quality`) | `nights`، `day`، `log` | `{mean, sd, n, quality}` أو `null` |
| `recovery.json` | `scores.recovery` | `z_hrv`، `z_rhr`، `z_sleep`، `penalty` | عدد صحيح 0..100 |
| `trimp.json` | `scores.trimp` | `minutes`، `hr_reserve`، `female` | عدد |
| `strain.json` | `scores.strain` | `trimp_total` | عدد 0..21 |

الويب (المرحلة 1ب) يقرأ العشرة الأولى فقط؛ وSwift يقرأ الأربعة عشر.

لا ملف مستقل لـ`baseline_quality`: `baseline` تأخذ `quality` منها مباشرة على ليالي النافذة،
فكل فروع قاعدتها (`null` و`provisional` و`full`، وحدود الكتل الثلاثة الداخلية، وطرفا النافذة)
مثبّتة في حقل `quality` من `baseline.json`. الفرق الوحيد بينهما التاريخ المكرر (`baseline_quality`
تعدّه ليلة واحدة)، والمتجهات لا تحمل تواريخ مكررة لأن المستدعي يمرّر ليلة واحدة لكل يوم. فالعدد
يبقى أربعة عشر ملفاً.

## الصيغة

```json
{
  "rulesVersion": 1,
  "function": "strength",
  "cases": [
    {
      "id": "strength-001",
      "input": { "habit": { "...": "..." }, "logs": [], "today": "2026-12-09", "week_start": "sun" },
      "expect": { "value": 0.798016731996357 },
      "tol": 5e-05,
      "source": "Loop: 30 يوماً كاملاً ≈ 0.7980"
    }
  ]
}
```

- `id`: `<fn>-NNN` فريد في كل الملفات.
- `input`: بدائيات JSON وحدها بمفاتيح `snake_case`: تواريخ `YYYY-MM-DD`، ولحظات ISO 8601 بـ`Z`
  (وفي `day_key` حالة واحدة بأجزاء الثانية `20:59:59.999Z` هي `day_key-006`، وحالة واحدة بإزاحة
  صريحة `+03:00` هي `day_key-013`)، وأعداد، ونصوص تعداد، ومصفوفات وكائنات منها. محلل اللحظات في
  كل عميل يجب أن يقبل الصيغ الثلاث؛ في Swift يحتاج `ISO8601DateFormatter` إلى
  `.withFractionalSeconds` لقبول `day_key-006`.
  - `habit`: حقول `HabitSpec` العشرة دائماً (ولو `null`): `kind`، `unit`، `target_per_period`،
    `period`، `schedule_kind`، `weekday_mask` (بتّ 0 = الأحد ... 6 = السبت)، `every_n`،
    `anchor_day`، `start_day`، `end_day`.
  - `logs`: مصفوفة `{day, value, status}`، و`status` من `done` و`skip` و`vacation` و`missed`،
    و`value` عدد أو `null`. الترتيب لا يؤثر في الناتج (حالات مقصودة تثبت ذلك).
  - `week_start`: `sat` أو `sun` أو `mon` في كل حالة تمرّ به للدالة.
  - `baseline`: `nights` مصفوفة `{day, value}` لليالي الصالحة (التاريخ يوم الاستيقاظ، بلا تاريخ
    مكرر، وبأي ترتيب)، و`day` اليوم المقيَّم، و`log` (`true` لـHRV: الحساب على `ln`). القاعدة
    (D-065): النافذة الأيام التقويمية الـ28 `[day − 28، day − 1]` وما خارجها يُهمل (ومنه `day`
    نفسه)؛ أقل من 7 ليالٍ فيها `null`؛ `quality = "full"` إن حوت كل كتلة من الكتل الأربع
    `[day−28..day−22]` و`[day−21..day−15]` و`[day−14..day−8]` و`[day−7..day−1]` 4 ليالٍ على الأقل،
    وإلا `"provisional"`؛ و`n` عدد ليالي النافذة وحدها.
- `expect`: كائن بمفتاح واحد `value` يحمل الناتج: قيمة مفردة، أو `null`، أو كائن بحقول النتيجة
  بأسماء `snake_case`. التواريخ نصوص ISO.
- `tol` (اختياري): هامش هذه الحالة وحدها للكسور.
- `source`: لماذا هذه الحالة (بالعربية).

## قواعد المقارنة

- الأعداد الصحيحة والنصوص والقيم المنطقية و`null`: تطابق تام.
- الكسور: `|actual − expect| ≤ tol`، و`tol = 1e-9` إن لم يُحدَّد.
- الكائنات: المفاتيح نفسها، وكل حقل بالقاعدة التي تناسبه. العدد المكتوب `3.0` كسر و`3` صحيح؛
  حقول `PeriodProgress` كلها كسور إلا `reached` و`on_track`، وحقول `ChallengeProgress` صحيحة إلا
  `completion`، وفي `Baseline` الحقل `n` صحيح و`mean` و`sd` كسور و`quality` نص. نواتج `streak`
  و`goal_prefill` و`recovery` صحيحة، و`strength` و`adherence` و`trimp` و`strain` كسور.

## قاعدة الثبات

- المعرّف لا يتغيّر ولا يُحذف بعد التزامه، ومدخلاته لا تتغيّر. الحالة الجديدة تأخذ رقماً جديداً.
- أي تغيير في `expect` (أو `tol`) لمعرّف ملتزَم يرفع `RULES_VERSION` في `api/tools/vector_cases.py`،
  وإلا رفض المولّد الكتابة بعبارة «تغيّر expect دون رفع rulesVersion».
- الملف الملتزَم هو خط الأساس للحارس، فحذفه ثم التوليد لا يعيد ضبطه بصمت: ملف مفقود يُفشل
  المولّد في الوضعين إلا بـ`--init` (لإنشاء المجلد أول مرة أو ملف دالة جديدة). و`--init` وحده
  لا يحمي من الحذف وإعادة التوليد محلياً؛ الذي يمنعه أن CI يطبّق الحارس على ملفات commit الأساس
  لا على ملفات الفرع نفسه فقط (التفاصيل في «التوليد والتحقق»).
- الحارس يفحص الملفات الأربعة عشر كلها قبل أن يكتب أيّها، والكتابة ذرّية (ملف مؤقت ثم استبدال)،
  فلا يترك فشلٌ متأخر ملفاً مكتوباً جزئياً.
- القيم المعلنة في المواصفة (Loop 0.7980 @30 و0.9592 @60 و0.9918 @90، والتعافي 50 و69 و84،
  وTRIMP 8.357 ...) مثبّتة كـ`pin` في `vector_cases.py`؛ المولّد والاختبار يفشلان إن خالفها الناتج.

## التوليد والتحقق

```bash
cd api
uv run python -I tools/gen_domain_vectors.py            # يكتب الملفات المختلفة فقط
uv run python -I tools/gen_domain_vectors.py --check    # لا يكتب؛ يفشل عند أي فرق
uv run python -I tools/gen_domain_vectors.py --init     # يسمح بإنشاء ملف ملتزَم مفقود (أول مرة فقط)
uv run pytest -q tests/test_domain_vectors.py           # الصيغة، والمطابقة مع المرجع، وحارس المولّد
```

مجلد الإخراج ثابت من موقع السكربت (`contracts/domain-vectors/v1` في جذر المستودع) ولا يُمرَّر
من سطر الأوامر. الملفات بمفاتيح مرتبة ومسافتين وUTF-8 وLF وسطر أخير فارغ، فأي تعديل يدوي
يظهر فرقاً.

### ما تفعله خطوة CI (`api-tests.yml` · «Domain vectors match the reference implementation»)

1. `--check` على ملفات الفرع (لا كتابة)، ثم التأكد أن `contracts/` بلا ملف معدَّل أو غير متتبَّع.
2. الحراسة ضد commit الأساس (`BASE_SHA`: أساس الـPR، أو الرأس السابق عند الدفع إلى `main`):
   تُستخرج ملفات `contracts/domain-vectors/v1` منه بـ`git archive`، وتوضع مكان ملفات الفرع،
   ثم يُشغَّل المولّد (`--init` لملف دالة جديدة) فيحكم حارسه على قواعد الفرع ضد معرّفات الأساس
   ومدخلاته وقيم `expect` فيه. بعدها يجب أن يساوي الناتج ملفات الفرع الملتزَمة (`git diff`)
   وألا يبقى ملف من الأساس بلا متتبَّع (دالة حُذفت مع ملفها). فلا يمرّ حذف ملف وإعادة توليده
   بـ`expect` جديد دون رفع `rulesVersion`.
3. الخطوة **تفشل مغلقة**: تُتخطّى الحراسة ضد الأساس في حالتين فقط: الحدث بلا commit أساس
   (`BASE_SHA` فارغ أو أصفار كله: فرع جديد)، أو commit الأساس موجود وليس فيه أي `*.json` تحت
   `contracts/domain-vectors/v1/`. أما `BASE_SHA` ليس معرّف commit، أو commit غير موجود في
   النسخة (نسخة ضحلة أو تاريخ أُعيدت كتابته)، فخطأ يُفشل الخطوة لا تخطٍّ. ولهذا `fetch-depth: 0`
   في `actions/checkout`: النسخة الضحلة لا تحوي commit الأساس، ولا يمكن جلبه لاحقاً لأن
   `persist-credentials: false`.

بنية الخطوة مثبّتة باختبار `api/tests/test_vectors_ci_step.py`.

## كيف يقرأها TypeScript وSwift

- **Vitest** (`web/tests/vectors.test.ts`): لكل ملف من العشرة
  `const file = JSON.parse(readFileSync('../contracts/domain-vectors/v1/<fn>.json'))` ثم
  `test.for(file.cases)('$id', c => …)`؛ محوّل `snake_case ← camelCase` للمدخلات ولحقول
  `expect.value`؛ `dayKey` بإزاحة الرياض الثابتة +3 (لا منطقة المتصفح)، والتواريخ نصوص وحسابها
  بـUTC صرفاً؛ والمقارنة `Math.abs(a − b) <= (c.tol ?? 1e-9)` للكسور وتطابقاً لغيرها.
- **Swift Testing** (`YawmiKit/Tests/.../VectorTests.swift`): `VectorLoader.load("<fn>")` يحدد
  الجذر من `#filePath` صعوداً ثم `contracts/domain-vectors/v1/<fn>.json`، ويعيد
  `[VectorCase { id, input: JSONValue, expect: JSONValue, tol: Double? }]`؛ ثم
  `@Test(arguments: VectorLoader.load("<fn>"))` لكل ملف من الأربعة عشر، ومحلل لحظات يقبل `Z`
  وأجزاء الثانية والإزاحة الصريحة (`ISO8601DateFormatter` مع `.withFractionalSeconds` لحالة
  `day_key-006`، أو محلل يدوي على `Foundation` وحده)، وفك `input` إلى
  `HabitSpec`/`HabitLog`/`DayKey` من `Foundation` وحده.

## ما لا تغطيه المتجهات

- حالات الخطأ (`ValueError` في بايثون: بداية أسبوع مجهولة، هدف غير موجب، قيم غير منتهية ...)
  ليست متجهات لأن دلالة الخطأ تختلف بين اللغات؛ كل عميل يختبرها محلياً.
- لا دالة من الأربع عشرة تعيد قائمة، فلا ترتيب مخرجات يُثبَّت؛ أما استقلال الناتج عن ترتيب
  `logs` فمثبّت بحالات مقصودة (مثل `period_progress-037..039` و`strength-035`).
