# دليل نشر «يومي» على الخادم

> **الحالة:** مكتوب ولم يُنفَّذ منه شيء. كل خطوة على الخادم **يحتاج موافقة عبدالله المستقلة** في المحادثة، لكل عملية على حدة، ولا تنتقل موافقة خطوة إلى التي تليها.
> **الملفات:** `deploy/compose/yawmi-db-1-schema.yml` و`deploy/compose/yawmi-db-2-role.yml` و`deploy/compose/yawmi-api.api.yml`، وصورة الحاوية من `api/Dockerfile`.
> **المرجع:** `gate0/README.md` § ب في مستودع الخطة (الشبكات وأسلوب المحمّلات)، و`raqib/server/BACKUP-RUNBOOK.md` (النسخ الاحتياطي).

## 0. قواعد ثابتة

- **الأسرار:** لا مفتاح ولا توكن ولا كلمة مرور ولا عنوان IP ولا اسم الخادم في أي ملف ولا في المحادثة. القيم السرية يكتبها عبدالله بنفسه في خانات واجهة Hostinger أو في طرفية الخادم. وما يُلصق في المحادثة يُعامل كمسرَّب: يُلغى ويُنشأ غيره.
- **كلمة مرور الدور `yawmi_api`:** تُولَّد على الخادم داخل volume باسم `yawmi_secrets` (محمّل المخطط)، وتقرؤها حاوية الواجهة منه للقراءة فقط. لا تمر بمحادثة ولا بملف ولا بمتغير.
- **n8n:** لا `create` ولا `update` لمشروعه، ولا إعادة تشغيل. ما يُنشأ هنا ثلاثة مشاريع جديدة مستقلة: `yawmi-loader` (مؤقت) و`yawmi-api`.
- **مشروع المحمّلات `yawmi-loader`:** يبقى متوقفاً بعد كل خطوة ولا يُحذف بخيار «حذف الـvolumes». حذف الـvolume `yawmi_secrets` يُضيع كلمة المرور (انظر ملحق التعافي).
- **ترتيب لا يتبدل:** النسخة الاحتياطية (1) ← جدولا W9 (2) ← محمّل 1 (3) ← محمّل 2 (4). محمّل 2 **لا يُشغَّل قبل جدولَي W9**: ملف `0002` يمنح `yawmi_api` القراءة على `raqib.notion_milestones` و`raqib.notion_cards`، وهما من محمّل W9 الأول، فإن غابا توقف محمّل 2 قبل أي تغيير. المطلوب من W9 هنا جدولاه وحدهما (محمّل `W9-loader-1-tables`)؛ أما بقية العمل عليه (Credential Notion وworkflow المزامنة) فخطوة لاحقة منفصلة لا يعتمد عليها هذا الدليل. ومحمّل 1 لا يمسّ جداول W9، فيصح قبلها أو بعدها، لكن الترتيب أعلاه هو المعتمد.
- **إبطال الرموز:** رمز الوصول عديم الحالة (لا يقرأ الخادم القاعدة عند فحصه)، فلا يُقطع رمز قبل انتهائه بإبطال صف جهازه. ورمز الخدمة لا ينتهي قبل سنة افتراضياً، **فلا يُبطَل إلا بتدوير `YAWMI_JWT_SECRET`**، وهذا يُسقط رموز كل الأجهزة والخدمات فتُقرن من جديد (الخطوة 10 وملحق ج).
- **حد ملف compose:** 8192 حرفاً، بنهايات LF، بلا وسم `latest`. يفحصها `python -I deploy/tools/check_compose.py deploy/compose`.
- **المحمّلات لا تطبع إلا أعداداً وبصمات:** أسطر `yawmi-verify` و`yawmi-loader` ونتيجة `sha256sum`، ولا تطبع قيمة سرية.

### متغيرات المشروع (في واجهة Hostinger، يكتبها عبدالله)

| المتغير | أين | ما هو |
|---|---|---|
| `YAWMI_DB_HOST` | المحمّلان وواجهة `yawmi-api` | اسم حاوية Postgres على الشبكة المشتركة (الخطوة 0) |
| `N8N_NETWORK` | `yawmi-api` | اسم شبكة n8n الموجودة (الخطوة 0) |
| `YAWMI_API_HOST` | `yawmi-api` | المضيف العام للواجهة، وله سجل DNS إلى الخادم |
| `TRAEFIK_CERT_RESOLVER` | `yawmi-api` | اسم مُصدِر الشهادات كما في علامات Traefik لمشروع n8n |
| `TRAEFIK_ENTRYPOINT` | `yawmi-api` | اختياري، الافتراضي `websecure` |
| `YAWMI_JWT_SECRET` | `yawmi-api` | **سر**: 32 خانة عشوائية فأكثر، يولّدها عبدالله ويكتبها بيده |
| `YAWMI_ANTHROPIC_API_KEY` | `yawmi-api` | **سر**: مفتاح Anthropic الخاص بالخدمة |
| `YAWMI_DB_NAME`، `RAQIB_NETWORK` | اختياري | الافتراضيان `raqib` و`raqib_internal` |

عند كل أمر أدناه يُفترض أن عبدالله عرّف في طرفية الخادم المتغيرين `YAWMI_DB_HOST` و`YAWMI_API_HOST` (بالقيم نفسها، ودون لصقهما في المحادثة).

## 1. الترتيب

| # | الخطوة | الملف | موافقة مستقلة |
|---|---|---|---|
| 0 | فحوص قراءة فقط وتجهيز المتغيرات وDNS | — | نعم (أوامر الطرفية) |
| 1 | نسخة احتياطية والتحقق من `backup_ok` | `raqib/server/backup.sh` | نعم |
| 2 | شرط مسبق: جدولا مرآة Notion (W9)، **قبل محمّل 2** | `raqib/server/W9-loader-1-tables.proposed.yml` | نعم |
| 3 | محمّل 1: المخطط وسر كلمة المرور | `yawmi-db-1-schema.yml` | نعم |
| 4 | محمّل 2: الدور والبذرة وفحص `yawmi_api`، **بعد الخطوتين 2 و3** | `yawmi-db-2-role.yml` | نعم |
| 5 | وسم الإصدار وبناء الصورة ودفعها إلى GHCR | `.github/workflows/api-image.yml` | نعم (push) |
| 6 | تسجيل GHCR من طرفية الخادم بـPAT قراءة فقط، وسحب الصورة | — | نعم |
| 7 | مشروع `yawmi-api` | `yawmi-api.api.yml` | نعم |
| 8 | فحص `/v1/health/live` | — | نعم (أوامر قراءة) |
| 9 | كود إقران | — | نعم |
| 10 | رمز خدمة (للمجدول ولإبطال الأجهزة) | — | نعم |

## الخطوة 0 · فحوص قراءة فقط وتجهيز المتغيرات

**يحتاج موافقة عبدالله المستقلة** (أوامر قراءة فقط، لا تغيّر شيئاً).

```sh
docker network ls --format '{{.Name}}' | grep n8n
docker ps --format '{{.Names}}' | grep -i postgres
docker inspect <حاوية n8n> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -E 'entrypoints|certresolver'
```

- **المطبوع المتوقع:** اسم شبكة n8n واحد (يُوضع في `N8N_NETWORK`)، واسم حاوية Postgres الخاصة برقيب (يُوضع في `YAWMI_DB_HOST`)، وسطران من علامات Traefik يظهر فيهما اسم نقطة الدخول واسم مُصدِر الشهادات (يوضعان في `TRAEFIK_ENTRYPOINT` و`TRAEFIK_CERT_RESOLVER`). لا يُلصق الناتج في المحادثة.
- **DNS (عبدالله، في واجهة Hostinger):** سجل `A` للمضيف الفرعي المختار ويشير إلى الخادم. التحقق من الطرفية: `getent hosts "$YAWMI_API_HOST"` يطبع عنوان الخادم نفسه.
- **التراجع:** لا شيء يُتراجع عنه. حذف سجل DNS إن لم يُستعمل المضيف.

## الخطوة 1 · نسخة احتياطية

**يحتاج موافقة عبدالله المستقلة.** شرط الدخول: اجتاز اختبار الاسترجاع وفق `raqib/server/BACKUP-RUNBOOK.md` (F-Y01).

```sh
/opt/raqib-backup/backup.sh
```

- **المطبوع المتوقع:** ظهور ملف `raqib-YYYY-MM-DD.dump` مع `.counts` و`.sha256`، وسطر `backup_ok` في `raqib.events` بعبارة `bytes=…;tables=…;sha256=…` حيث `tables` لا يقل عن 31 (الاستعلام في `BACKUP-RUNBOOK.md` § 3.2).
- **التراجع:** النسخة الاحتياطية لا تغيّر شيئاً. وإن ظهر `backup_failed` فلا تُنفَّذ الخطوات التالية حتى يُعرف السبب.

## الخطوة 2 · شرط مسبق: جدولا مرآة Notion

**يحتاج موافقة عبدالله المستقلة.** السبب: ملف `0002_yawmi_role.sql` يمنح `yawmi_api` القراءة على `raqib.notion_milestones` و`raqib.notion_cards`، فإن لم يوجدا فشل محمّل 2 قبل أي تغيير (ويكتب أسماء المفقود). التنفيذ بمحمّل W9 الأول وفق `raqib/server/W9-NOTION-RUNBOOK.md`، ويُتخطى إن كان الجدولان موجودين.

- **المطبوع المتوقع** (من المحمّل نفسه): `raqib-verify notion_tables=2` و`raqib-verify app_insert_probe=ok` و`raqib-verify probe_rows_left=0`.
- **التراجع:** كما في `W9-NOTION-RUNBOOK.md`. لا يلمس هذا الجدول بيانات رقيب القائمة.

## الخطوة 3 · محمّل 1: المخطط وسر كلمة المرور

**يحتاج موافقة عبدالله المستقلة.** مشروع جديد باسم `yawmi-loader` من الملف `deploy/compose/yawmi-db-1-schema.yml`، ومتغيره `YAWMI_DB_HOST`.

ما يفعله، بالترتيب: ينتظر القاعدة ← يفك حزمة `0001` ويرفض التشغيل إن لم تطابق بصمتها ← يولّد `yawmi_api_pw` في `yawmi_secrets` إن غاب (64 خانة سداسية، مالكها uid 10001، صلاحيتها 0400) ← يطبّق `0001` مع سطر `schema_migrations` في معاملة واحدة. وتكرار التشغيل آمن: ما طُبّق لا يُعاد وكلمة المرور لا تتبدل.

- **المطبوع المتوقع** (سجل الحاوية):

  ```
  /tmp/0001.sql: OK
  <64 خانة سداسية>  /tmp/0001.sql
  yawmi-loader: generated yawmi_api_pw in yawmi_secrets
  yawmi-loader: applied 0001_yawmi_schema.sql
  yawmi-verify schema_tables=13
  yawmi-verify migrations=0001_yawmi_schema.sql
  yawmi-verify secret_bytes=64 mode=400 owner=10001
  yawmi-loader: schema step done
  ```

  وعند الإعادة يصير السطران الثاني والرابع `yawmi-loader: 0001_yawmi_schema.sql already applied, skipped` ويغيب سطر `generated`.
- **إن فشل:** المعاملة تُلغى كلها، فلا مخطط ناقص. `sha256 mismatch` أو `FAILED` يعني أن الملف تغيّر بعد توليده (يُعاد التوليد بـ`python -I deploy/tools/build_loaders.py`).
- **التراجع** (يحتاج موافقة مستقلة، ولا يُجرى بعد نشر الواجهة): في `psql` بحساب `raqib_admin`: `DROP SCHEMA yawmi CASCADE;` يحذف مخطط يومي كله (لا بيانات فيه قبل الخطوة 7). وسر كلمة المرور يُحذف بحذف الـvolume `yawmi_secrets` بعد التأكد أن لا مشروع يستعمله.

## الخطوة 4 · محمّل 2: الدور والبذرة وفحص `yawmi_api`

**يحتاج موافقة عبدالله المستقلة.** المشروع `yawmi-loader` نفسه، من الملف `deploy/compose/yawmi-db-2-role.yml`، ومتغيره `YAWMI_DB_HOST`.

**شرط الترتيب:** يُشغَّل بعد الخطوة 2 (جدولا W9) وبعد الخطوة 3 (محمّل 1)، لا قبلهما. ويتحقق المحمّل من الشرطين بنفسه قبل أي تغيير: يتوقف إن لم يجد `0001` مسجلاً في `schema_migrations` (ويطلب محمّل 1)، أو إن غاب أحد كائنات `raqib` السبعة التي يمنحها `0002` القراءة (ويطلب محمّل W9 الأول ويطبع أسماء المفقود).

ما يفعله، بالترتيب: يرفض التشغيل إن غاب السر (فالمحمّل 1 قبله) أو غابت البذرة من الملف ← يتحقق من تطبيق `0001` ومن وجود جداول المرآة في `raqib` ← يطبّق `0002` وكلمة المرور تُقرأ من الملف إلى متغير `psql` ومنه إلى إعداد محلي للمعاملة (لا تظهر في وسيط ولا في SQL مكتوب) ← يضبط كلمة مرور الدور على ما في الملف في كل تشغيل ← يطبّق بذرة العادات (إدراج مع تحديث يحفظ المرسى والتذكيرات وتاريخ البداية، فتكراره آمن) ← يتصل بحساب `yawmi_api` نفسه عبر الشبكة ويجرّب المسموح والمرفوض.

- **المطبوع المتوقع:**

  ```
  /tmp/0002.sql: OK
  <64 خانة سداسية>  /tmp/0002.sql
  /tmp/seed.sql: OK
  <64 خانة سداسية>  /tmp/seed.sql
  yawmi-loader: applied 0002_yawmi_role.sql
  yawmi-loader: system habits upserted
  yawmi-verify migrations=0001_yawmi_schema.sql,0002_yawmi_role.sql
  yawmi-verify system_habits=10
  yawmi-verify api_role=false,false,false,5,true
  yawmi-verify api_login=yawmi_api,search_path=yawmi
  yawmi-verify api_reads_habits=10
  yawmi-verify api_reads_raqib_kpis=<عدد>
  yawmi-verify api_reads_v_journal_daily=<عدد>
  NOTICE:  yawmi-verify denied_probes=4/4
  yawmi-loader: role step done
  ```

  معنى `api_role`: ليس مديراً ولا ينشئ قواعد ولا أدواراً، وحد اتصالاته 5، وله كلمة مرور. و`denied_probes=4/4`: رُفض `DELETE` على `yawmi.events`، والقراءة من `yawmi.schema_migrations`، وإنشاء جدول في `yawmi`، والقراءة من `raqib.facts`.
- **إن فشل:**
  - `raqib objects missing: …` ← الخطوة 2 ناقصة.
  - `yawmi_api_pw is missing` ← الخطوة 3 لم تُنفَّذ.
  - `is not embedded in this file` ← ملف المحمّل وُلّد قبل وجود `api/db/seed/habits.sql`: يُعاد توليده بـ`python -I deploy/tools/build_loaders.py` ثم يُفحص بـ`--check` (ملحق ب).
  - `DENIED=NO` ← صلاحية زائدة للدور: يُوقف النشر ويُسجَّل في `FAILURES.md`.
- **التراجع** (موافقة مستقلة): `DROP OWNED BY yawmi_api; DROP ROLE yawmi_api;` ثم `DELETE FROM yawmi.schema_migrations WHERE filename = '0002_yawmi_role.sql';`. والبذرة: `DELETE FROM yawmi.habits WHERE system;` (لا سجلات عادات قبل نشر الواجهة).

## الخطوة 5 · وسم الإصدار وبناء الصورة

**يحتاج موافقة عبدالله المستقلة** (دفع وسم إلى GitHub، وفق قاعدة «لا push دون موافقة»).

```sh
git tag api-v0.1.0
git push origin api-v0.1.0
```

يبني `.github/workflows/api-image.yml` الصورة ويدفعها إلى `ghcr.io/nexgen94/yawmi-api:0.1.0` (خاصة، لأن المستودع خاص). وقبل الدفع يتحقق من أن المستخدم داخل الصورة uid 10001، وأن `yawmi.main` يُستورد، وأن `yawmi-admin --help` يعمل.

- **المطبوع المتوقع:** مهمة `image` خضراء في تبويب Actions، وظهور الحزمة `yawmi-api` بوسم `0.1.0` في صفحة حزم المستودع.
- **قيد قائم (Issue #5):** GitHub Actions معطّل على مستوى الحساب (`startup_failure`)، ولا Docker على جهاز التطوير. فإلى أن يُحل لا تُبنى الصورة، وتتوقف الخطوات 6–10. بديل يحتاج موافقة مستقلة: بناء الصورة على الخادم نفسه من نسخة من مجلد `api/`، ووسمها باسم الصورة نفسه.
- **التراجع:** حذف الحزمة من صفحة الحزم، وحذف الوسم: `git push origin :refs/tags/api-v0.1.0` (موافقة مستقلة).

## الخطوة 6 · تسجيل GHCR من طرفية الخادم

**يحتاج موافقة عبدالله المستقلة.**

1. **عبدالله في GitHub:** إنشاء Personal access token (classic) بصلاحية `read:packages` وحدها، ومدة قصيرة.
2. **عبدالله في طرفية الخادم:** `docker login ghcr.io -u NexGen94`. يطلب الأمر كلمة المرور، فيكتب عبدالله الرمز بنفسه ولا يظهر على الشاشة. **لا يُكتب الرمز في أمر ولا في ملف ولا في المحادثة.**
3. سحب الصورة يدوياً، فلا يحتاج مدير Docker إلى بيانات الدخول بعد ذلك لأن compose لا يسحب صورة موجودة محلياً:

   ```sh
   docker pull ghcr.io/nexgen94/yawmi-api:0.1.0
   docker image inspect ghcr.io/nexgen94/yawmi-api:0.1.0 --format '{{.Config.User}}'
   ```

- **المطبوع المتوقع:** `Login Succeeded` (مع تنبيه أن بيانات الدخول تُحفظ في `config.json` للمستخدم)، ثم `Status: Downloaded newer image for ghcr.io/nexgen94/yawmi-api:0.1.0`، ثم `10001:10001`.
- **التراجع:** `docker logout ghcr.io`، وإلغاء الرمز من إعدادات GitHub، و`docker rmi ghcr.io/nexgen94/yawmi-api:0.1.0`.

## الخطوة 7 · مشروع `yawmi-api`

**يحتاج موافقة عبدالله المستقلة.** إنشاء مشروع باسم `yawmi-api` في واجهة Hostinger من الملف `deploy/compose/yawmi-api.api.yml`، وكتابة المتغيرات من الجدول في § 0 (الأسرار منها بيد عبدالله وحده). ملف compose يرفض النشر إن غاب `YAWMI_DB_HOST` أو `N8N_NETWORK` أو `YAWMI_JWT_SECRET` أو `YAWMI_ANTHROPIC_API_KEY`.

عند بدء الحاوية يقرأ المدخل `/usr/local/bin/yawmi-entrypoint` كلمة المرور من `/run/yawmi/yawmi_api_pw` ويرمّزها (percent-encoding) ويركّب `YAWMI_DATABASE_URL` في بيئة العملية فقط، ثم يشغّل `uvicorn`.

- **المطبوع المتوقع:**

  ```sh
  docker ps --filter name=yawmi-api --format '{{.Names}} {{.Status}}'
  docker port yawmi-api
  docker logs --tail 20 yawmi-api
  ```

  الأول: `yawmi-api Up … (healthy)` خلال دقيقة تقريباً. والثاني: لا ناتج (لا منفذ منشور). والثالث: أسطر بدء `uvicorn` (`Application startup complete`) بلا كلمة مرور ولا رابط اتصال.
- **إن لم تصل الحاوية إلى `healthy`:** `docker logs yawmi-api`. `password file is missing or unreadable` ← الخطوة 3 أو حذف الـvolume. `password authentication failed` ← كلمة المرور في الملف لا تطابق الدور: يُعاد تشغيل محمّل 2 فيزامنها.
- **التراجع:** إيقاف المشروع `yawmi-api` وحذفه من واجهة Hostinger (دون خيار حذف الـvolumes). لا أثر له على القاعدة ولا على n8n.

## الخطوة 8 · فحص الصحة

**يحتاج موافقة عبدالله المستقلة** (طلبات قراءة فقط).

```sh
curl -sS -w '\n%{http_code} ssl=%{ssl_verify_result}\n' "https://$YAWMI_API_HOST/v1/health/live"
```

- **المطبوع المتوقع:** `{"ok":true}` ثم `200 ssl=0` (الشهادة سارية). تأخر الشهادة بضع دقائق بعد أول نشر طبيعي: يُعاد الأمر.
- **إن فشل:** `404` ← قاعدة الموجّه لا تطابق (المضيف في `YAWMI_API_HOST` أو أولوية الموجّه)؛ `502` ← الحاوية ليست `healthy` أو الشبكة `N8N_NETWORK` خاطئة؛ خطأ شهادة ← `TRAEFIK_CERT_RESOLVER` لا يطابق اسم المُصدِر.
- **التراجع:** لا شيء.

## الخطوة 9 · كود إقران

**يحتاج موافقة عبدالله المستقلة.** الأمر يمر بالمدخل ليركّب رابط الاتصال، لأن `docker exec` المجرد لا يرث متغيرات المدخل:

```sh
docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin pair-code --kind web
```

الأنواع: `iphone` و`watch` و`web`.

- **المطبوع المتوقع:** ثمانية أرقام في سطر واحد (المخرج القياسي)، وفي مخرج الأخطاء: «الكود صالح 10 دقائق ولاستخدام واحد». يُدخل عبدالله الكود في التطبيق بنفسه، ولا يُلصق في المحادثة.
- **التراجع:** لا شيء. الكود ينتهي بعد 10 دقائق أو بأول استعمال.

## الخطوة 10 · رمز خدمة

**يحتاج موافقة عبدالله المستقلة.** يحتاجه المجدول (n8n) ونداء `POST /v1/devices/{id}/revoke`:

```sh
docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin service-token --name n8n-scheduler --ttl-hours 8760
```

- **المطبوع المتوقع:** سطر واحد هو رمز الوصول (ثلاثة أجزاء تفصلها نقطتان)، وفي مخرج الأخطاء: «سُجّل جهاز الخدمة، والرمز صالح 8760 ساعة، ولا يُعرض مرة ثانية». التحقق من الشكل دون عرض الرمز: `… service-token … | awk -F. '{print NF}'` يطبع `3`. الصلاحية الافتراضية سنة، والحد الأقصى 43800 ساعة. ولا رمز تحديث له.
- **يخزّنه عبدالله** في Credential داخل n8n بنفسه، ولا يُلصق في المحادثة.
- **التراجع:** لا يوجد إبطال لرمز خدمة بعينه. الرمز عديم الحالة: يتحقق منه الخادم بالتوقيع والانتهاء وحدهما دون قراءة القاعدة، فحذف صف الجهاز أو استدعاء `POST /v1/devices/{id}/revoke` عليه لا يقطعه قبل انتهائه. **السبيل الوحيد لإبطاله هو تدوير `YAWMI_JWT_SECRET`** في واجهة Hostinger ثم إعادة نشر `yawmi-api`، وهذا يُسقط رموز كل الأجهزة والخدمات معاً فتُقرن الأجهزة من جديد ويُصدَر رمز خدمة جديد. لذلك: الصلاحية الافتراضية سنة بقرار مقبول، وتُقصَّر بـ`--ttl-hours` إن أريد تعرّض أقل، ولا يُترك رمز خدمة في مكان غير Credential داخل n8n.

## ملحق أ · تحديث الصورة

وسم جديد `api-vX.Y.Z` (الخطوة 5)، ثم تغيير الوسم في سطر `image:` من `yawmi-api.api.yml`، و`docker pull` للوسم الجديد (الخطوة 6.3)، ثم تحديث مشروع `yawmi-api` في واجهة Hostinger. **يحتاج موافقة مستقلة.** التراجع: إعادة الوسم السابق وتحديث المشروع.

## ملحق ب · إعادة توليد المحمّلين

بعد أي تعديل في `api/db/migrations/*.sql` أو `api/db/seed/habits.sql`:

```sh
python -I deploy/tools/build_loaders.py          # يكتب الملفين
python -I deploy/tools/build_loaders.py --check  # يفشل إن اختلفت البصمات
python -I deploy/tools/check_compose.py deploy/compose
```

يحذف المولّد أسطر التعليقات والفراغات وحدها (وإلا لم يتسع الملفان لثمانية آلاف حرف) ويضغط ويرمّز base64. ويرفض ملفاً فيه `/* */` أو سطر تعليق داخل نص مقتبس. ولا يُخزَّن في الملفين أي سر.

## ملحق ج · التعافي وتدوير كلمة المرور

- **ضياع الـvolume `yawmi_secrets`:** تشغيل محمّل 1 يولّد كلمة مرور جديدة، ثم تشغيل محمّل 2 يضبطها على الدور. ثم إعادة تشغيل `yawmi-api`. (**موافقة مستقلة لكل تشغيل.**)
- **تدوير كلمة المرور عن قصد:** حذف الملف `yawmi_api_pw` من الـvolume ثم التعافي بالخطوتين السابقتين.
- **تدوير `YAWMI_JWT_SECRET`:** يُسقط كل الرموز الصادرة (الأجهزة المقرونة ورموز الخدمة).
