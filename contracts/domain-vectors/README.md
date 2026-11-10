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
| `baseline.json` | `scores.baseline` | `values`، `log` | `{mean, sd, n, quality}` أو `null` |
| `recovery.json` | `scores.recovery` | `z_hrv`، `z_rhr`، `z_sleep`، `penalty` | عدد صحيح 0..100 |
| `trimp.json` | `scores.trimp` | `minutes`، `hr_reserve`، `female` | عدد |
| `strain.json` | `scores.strain` | `trimp_total` | عدد 0..21 |

الويب (المرحلة 1ب) يقرأ العشرة الأولى فقط؛ وSwift يقرأ الأربعة عشر.

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
  (وحالة واحدة بإزاحة صريحة `+03:00` في `day_key`)، وأعداد، ونصوص تعداد، ومصفوفات وكائنات منها.
  - `habit`: حقول `HabitSpec` العشرة دائماً (ولو `null`): `kind`، `unit`، `target_per_period`،
    `period`، `schedule_kind`، `weekday_mask` (بتّ 0 = الأحد ... 6 = السبت)، `every_n`،
    `anchor_day`، `start_day`، `end_day`.
  - `logs`: مصفوفة `{day, value, status}`، و`status` من `done` و`skip` و`vacation` و`missed`،
    و`value` عدد أو `null`. الترتيب لا يؤثر في الناتج (حالات مقصودة تثبت ذلك).
  - `week_start`: `sat` أو `sun` أو `mon` في كل حالة تمرّ به للدالة.
- `expect`: كائن بمفتاح واحد `value` يحمل الناتج: قيمة مفردة، أو `null`، أو كائن بحقول النتيجة
  بأسماء `snake_case`. التواريخ نصوص ISO.
- `tol` (اختياري): هامش هذه الحالة وحدها للكسور.
- `source`: لماذا هذه الحالة (بالعربية).

## قواعد المقارنة

- الأعداد الصحيحة والنصوص والقيم المنطقية و`null`: تطابق تام.
- الكسور: `|actual − expect| ≤ tol`، و`tol = 1e-9` إن لم يُحدَّد.
- الكائنات: المفاتيح نفسها، وكل حقل بالقاعدة التي تناسبه. العدد المكتوب `3.0` كسر و`3` صحيح؛
  حقول `PeriodProgress` كلها كسور إلا `reached` و`on_track`، وحقول `ChallengeProgress` صحيحة إلا
  `completion`.

## قاعدة الثبات

- المعرّف لا يتغيّر ولا يُحذف بعد التزامه، ومدخلاته لا تتغيّر. الحالة الجديدة تأخذ رقماً جديداً.
- أي تغيير في `expect` (أو `tol`) لمعرّف ملتزَم يرفع `RULES_VERSION` في `api/tools/vector_cases.py`،
  وإلا رفض المولّد الكتابة بعبارة «تغيّر expect دون رفع rulesVersion».
- القيم المعلنة في المواصفة (Loop 0.7980 @30 و0.9592 @60 و0.9918 @90، والتعافي 50 و69 و84،
  وTRIMP 8.357 ...) مثبّتة كـ`pin` في `vector_cases.py`؛ المولّد والاختبار يفشلان إن خالفها الناتج.

## التوليد والتحقق

```bash
cd api
uv run python -I tools/gen_domain_vectors.py            # يكتب الملفات المختلفة فقط
uv run python -I tools/gen_domain_vectors.py --check    # لا يكتب؛ يفشل عند أي فرق
uv run pytest -q tests/test_domain_vectors.py           # الصيغة، والمطابقة مع المرجع، وحارس المولّد
```

CI (`api-tests.yml`) يعيد التوليد ويفشل إن ظهر أي فرق في `contracts/`. الملفات بمفاتيح مرتبة
ومسافتين وUTF-8 وLF وسطر أخير فارغ، فأي تعديل يدوي يظهر فرقاً.

## كيف يقرأها TypeScript وSwift

- **Vitest** (`web/tests/vectors.test.ts`): لكل ملف من العشرة
  `const file = JSON.parse(readFileSync('../contracts/domain-vectors/v1/<fn>.json'))` ثم
  `test.for(file.cases)('$id', c => …)`؛ محوّل `snake_case ← camelCase` للمدخلات ولحقول
  `expect.value`؛ `dayKey` بإزاحة الرياض الثابتة +3 (لا منطقة المتصفح)، والتواريخ نصوص وحسابها
  بـUTC صرفاً؛ والمقارنة `Math.abs(a − b) <= (c.tol ?? 1e-9)` للكسور وتطابقاً لغيرها.
- **Swift Testing** (`YawmiKit/Tests/.../VectorTests.swift`): `VectorLoader.load("<fn>")` يحدد
  الجذر من `#filePath` صعوداً ثم `contracts/domain-vectors/v1/<fn>.json`، ويعيد
  `[VectorCase { id, input: JSONValue, expect: JSONValue, tol: Double? }]`؛ ثم
  `@Test(arguments: VectorLoader.load("<fn>"))` لكل ملف من الأربعة عشر، وفك `input` إلى
  `HabitSpec`/`HabitLog`/`DayKey` من `Foundation` وحده.

## ما لا تغطيه المتجهات

- حالات الخطأ (`ValueError` في بايثون: بداية أسبوع مجهولة، هدف غير موجب، قيم غير منتهية ...)
  ليست متجهات لأن دلالة الخطأ تختلف بين اللغات؛ كل عميل يختبرها محلياً.
- لا دالة من الأربع عشرة تعيد قائمة، فلا ترتيب مخرجات يُثبَّت؛ أما استقلال الناتج عن ترتيب
  `logs` فمثبّت بحالات مقصودة (مثل `period_progress-037..039` و`strength-035`).
