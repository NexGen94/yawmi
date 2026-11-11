# دليل نشر «يومي» على الخادم

> **الحالة:** مكتوب ولم يُنفَّذ منه شيء. كل خطوة على الخادم **يحتاج موافقة عبدالله المستقلة** في المحادثة، لكل عملية على حدة، ولا تنتقل موافقة خطوة إلى التي تليها.
> **الملفات:** `deploy/compose/yawmi-db-1-schema.yml` و`deploy/compose/yawmi-db-2-role.yml` و`deploy/compose/yawmi-db-3-web.yml` (4ب) و`deploy/compose/yawmi-api.api.yml`، وصورة الحاوية من `api/Dockerfile`.
> **المرجع:** `gate0/README.md` § ب في مستودع الخطة (الشبكات وأسلوب المحمّلات)، و`raqib/server/BACKUP-RUNBOOK.md` (النسخ الاحتياطي).

## 0. قواعد ثابتة

- **الأسرار:** لا مفتاح ولا توكن ولا كلمة مرور ولا عنوان IP ولا اسم الخادم في أي ملف ولا في المحادثة. القيم السرية يكتبها عبدالله بنفسه في خانات واجهة Hostinger أو في طرفية الخادم. وما يُلصق في المحادثة يُعامل كمسرَّب: يُلغى ويُنشأ غيره.
- **كلمة مرور الدور `yawmi_api`:** تُولَّد على الخادم داخل volume باسم `yawmi_secrets` (محمّل المخطط)، وتقرؤها حاوية الواجهة منه للقراءة فقط. لا تمر بمحادثة ولا بملف ولا بمتغير.
- **ظهور كلمة المرور في جمل SQL:** في جملة واحدة فقط هي `ALTER ROLE yawmi_api PASSWORD …` في محمّل 2، تُنفَّذ في معاملة تعطّل فيها `SET LOCAL` تسجيل الجمل (`log_statement = 'none'`) وتسجيل الجملة الفاشلة (`log_min_error_statement = 'panic'`) وتسجيل الجمل البطيئة (`log_min_duration_statement = -1`)، فلا يصل النص إلى سجل Postgres على الخادم المشترك. تغيير هذه الإعدادات يحتاج superuser، و`raqib_admin` هو مستخدم التهيئة `POSTGRES_USER` فهو كذلك؛ فإن ظهر `permission denied to set parameter` توقف المحمّل قبل لمس كلمة المرور، ولا يُخفَّف السطر ولا يُحذف. وبقية الطبقات: لا تمر بوسيط ولا متغير، ومتغير `psql` الحامل لها يُحذف فور الجملة، وأخطاء `psql` مختصرة (`VERBOSITY=terse`) فلا تُعيد نص الجملة.
- **n8n:** لا `create` ولا `update` لمشروعه، ولا إعادة تشغيل. ما يُنشأ هنا مشروعان جديدان مستقلان: `yawmi-loader` (مؤقت) و`yawmi-api`، إضافة إلى volume واحد `yawmi_secrets` يُنشأ يدوياً (الخطوة 3).
- **الـvolume `yawmi_secrets`:** خارجي (`external: true`) في الملفات الثلاثة، ويُنشأ بأمر يدوي في الخطوة 3 قبل أي مشروع. السبب: ما يعرّفه compose بنفسه يمكن أن يُعاد إنشاؤه عند تغيير تعريفه أو يُحذف بـ`down -v`، فتضيع كلمة المرور وتنفصل عن الدور في القاعدة؛ أما الخارجي فلا يلمسه compose أبداً. وإن نُسي إنشاؤه فشل المحمّل 1 عند البدء برسالة «volume غير موجود» دون أن يُغيّر شيئاً.
- **مشروع المحمّلات `yawmi-loader`:** يبقى متوقفاً بعد كل خطوة ولا يُحذف بخيار «حذف الـvolumes». حذف الـvolume `yawmi_secrets` يدوياً يُضيع كلمة المرور (التفاصيل في ملحق ج، التعافي).
- **ترتيب لا يتبدل:** النسخة الاحتياطية (1) ← جدولا W9 (2) ← محمّل 1 (3) ← محمّل 2 (4). محمّل 2 **لا يُشغَّل قبل جدولَي W9**: ملف `0002` يمنح `yawmi_api` القراءة على `raqib.notion_milestones` و`raqib.notion_cards`، وهما من محمّل W9 الأول، فإن غابا توقف محمّل 2 قبل أي تغيير. المطلوب من W9 هنا جدولاه وحدهما (محمّل `W9-loader-1-tables`)؛ أما بقية العمل عليه (Credential Notion وworkflow المزامنة) فخطوة لاحقة منفصلة لا يعتمد عليها هذا الدليل. ومحمّل 1 لا يمسّ جداول W9، فيصح قبلها أو بعدها، لكن الترتيب أعلاه هو المعتمد.
- **إبطال الرموز:** رمز الوصول عديم الحالة (لا يقرأ الخادم القاعدة عند فحصه)، فلا يُقطع رمز قبل انتهائه بإبطال صف جهازه. ورمز الخدمة لا يُصدَر إلا عند الحاجة وبصلاحية ساعة واحدة (الخطوة 10)، وإلى أن تنتهي **فلا يُبطَل إلا بتدوير `YAWMI_JWT_SECRET`**، وهذا يُسقط رموز كل الأجهزة والخدمات فتُقرن من جديد (ملحق ج). أما إبطال جهاز مقرون فبالأداة `yawmi-admin revoke` (الخطوة 9أ)، بلا رمز خدمة.
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
| `YAWMI_PUSH_ENABLED`، `YAWMI_VAPID_SUBJECT`، `YAWMI_PUSH_HOSTS` | `yawmi-api` | اختيارية حتى الخطوة 11هـ: الافتراضي `false` وفارغ وفارغ (القائمة الافتراضية). الثاني بصيغة `mailto:` وليس سراً |

عند كل أمر أدناه يُفترض أن عبدالله عرّف في طرفية الخادم المتغيرين `YAWMI_DB_HOST` و`YAWMI_API_HOST` (بالقيم نفسها، ودون لصقهما في المحادثة).

## 1. الترتيب

| # | الخطوة | الملف | موافقة مستقلة |
|---|---|---|---|
| 0 | فحوص قراءة فقط (شبكة `raqib_internal` وvolume `raqib_secrets` وصلاحية `raqib_admin`) وتجهيز المتغيرات وDNS | — | نعم (أوامر الطرفية) |
| 1 | نسخة احتياطية والتحقق من `backup_ok` | `raqib/server/backup.sh` | نعم |
| 2 | شرط مسبق: جدولا مرآة Notion (W9)، **قبل محمّل 2** | `raqib/server/W9-loader-1-tables.proposed.yml` | نعم |
| 3 | إنشاء الـvolume `yawmi_secrets` (3أ) ثم محمّل 1: المخطط وسر كلمة المرور (3ب) | `yawmi-db-1-schema.yml` | نعم، لكلٍّ منهما |
| 4 | محمّل 2: الدور والبذرة وفحص `yawmi_api`، **بعد الخطوتين 2 و3**؛ ثم 4ب: محمّل 3 لترحيل `0003` (جولة الويب للحاسوب)، بعد محمّل 2 | `yawmi-db-2-role.yml`، ثم `yawmi-db-3-web.yml` | نعم، لكلٍّ منهما |
| 5 | وسم الإصدار وبناء الصورة ودفعها إلى GHCR (وصورة الويب 11أ تُبنى قبل الخطوة 7 أيضاً) | `.github/workflows/api-image.yml` | نعم (push) |
| 6 | تسجيل GHCR من طرفية الخادم بـPAT قراءة فقط، وسحب الصورتين `yawmi-api` و`yawmi-web` (11ب) | — | نعم |
| 7 | مشروع `yawmi-api` (بخدمتيه `yawmi-api` و`yawmi-web`، فالصورتان مسحوبتان قبله) | `yawmi-api.api.yml` | نعم |
| 8 | فحص `/v1/health/live`، ثم إثبات حد الإقران مرة واحدة (8أ) | — | نعم (أوامر قراءة، وطلبات إقران بكود خاطئ) |
| 9 | كود إقران، ثم فحص بـ`curl` يقرن جهازاً ويقرأ ويكتب ثم يُبطله (9أ) | — | نعم |
| 10 | رمز خدمة عند الحاجة فقط، صالح ساعة واحدة | — | نعم |
| 11 | الويب: وسم `web-vX.Y.Z` وصورة `yawmi-web` وخدمتها في المشروع نفسه (11أ و11ب **قبل** الخطوة 7) | `web/Dockerfile`، `web-image.yml`، `yawmi-api.api.yml` | نعم، لكل عملية |

## الخطوة 0 · فحوص قراءة فقط وتجهيز المتغيرات

**يحتاج موافقة عبدالله المستقلة** (أوامر قراءة فقط، لا تغيّر شيئاً).

```sh
docker network ls --format '{{.Name}}' | grep n8n
docker ps --format '{{.Names}}' | grep -i postgres
docker inspect <حاوية n8n> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -E 'entrypoints|certresolver'
docker network inspect raqib_internal --format '{{.Name}}'
docker volume inspect raqib_secrets --format '{{.Name}}'
docker exec "$YAWMI_DB_HOST" psql -U raqib_admin -d raqib -Atc "SELECT rolsuper FROM pg_roles WHERE rolname = 'raqib_admin'"
```

- **المطبوع المتوقع:** اسم شبكة n8n واحد (يُوضع في `N8N_NETWORK`)، واسم حاوية Postgres الخاصة برقيب (يُوضع في `YAWMI_DB_HOST`)، وسطران من علامات Traefik يظهر فيهما اسم نقطة الدخول واسم مُصدِر الشهادات (يوضعان في `TRAEFIK_ENTRYPOINT` و`TRAEFIK_CERT_RESOLVER`). ثم الأسطر الثلاثة الأخيرة (بعد تعريف `YAWMI_DB_HOST` في الطرفية): `raqib_internal` (الشبكة التي ينضم إليها المحمّلان والواجهة)، و`raqib_secrets` (منه يقرأ المحمّلان كلمة مرور `raqib_admin`)، و`t` (`raqib_admin` مدير، وإلا رُفضت أسطر `SET LOCAL` في محمّل 2). غياب أحدها يُفشل المحمّلين متأخرين، فلا يُتقدَّم إلى الخطوة 1 قبل الثلاثة. لا يُلصق الناتج في المحادثة.
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

## الخطوة 3 · الـvolume ثم محمّل 1: المخطط وسر كلمة المرور

**3أ · إنشاء الـvolume — يحتاج موافقة عبدالله المستقلة.** أمر واحد في طرفية الخادم، قبل أي مشروع:

```sh
docker volume create yawmi_secrets
docker volume inspect yawmi_secrets --format '{{.Name}} {{.Driver}}'
```

- **المطبوع المتوقع:** `yawmi_secrets` (من الأمر الأول) ثم `yawmi_secrets local`. إن كان موجوداً من قبل فالأمر الأول يطبع اسمه دون تغيير ولا ضرر.
- **التراجع:** `docker volume rm yawmi_secrets` (لا يُجرى إن كان أي حاوية أو مشروع يستعمله، ويُضيع كلمة المرور).

**3ب · محمّل 1 — يحتاج موافقة عبدالله المستقلة.** مشروع جديد باسم `yawmi-loader` من الملف `deploy/compose/yawmi-db-1-schema.yml`، ومتغيره `YAWMI_DB_HOST`.

ما يفعله، بالترتيب: ينتظر القاعدة ← يفك حزمة `0001` ويرفض التشغيل إن لم تطابق بصمتها ← يولّد `yawmi_api_pw` في `yawmi_secrets` إن غاب (64 خانة سداسية، مالكها uid 10001، صلاحيتها 0400) ← يطبّق `0001` مع سطر `schema_migrations` في معاملة واحدة. وتكرار التشغيل آمن: ما طُبّق لا يُعاد وكلمة المرور لا تتبدل.

- **المطبوع المتوقع** (سجل الحاوية):

  ```text
  /tmp/0001.sql: OK
  <64 خانة سداسية>  /tmp/0001.sql
  yawmi-loader: generated yawmi_api_pw in yawmi_secrets
  NOTICE:  schema "yawmi" already exists, skipping
  NOTICE:  relation "schema_migrations" already exists, skipping
  yawmi-loader: applied 0001_yawmi_schema.sql
  yawmi-verify schema_tables=13
  yawmi-verify migrations=0001_yawmi_schema.sql
  yawmi-verify secret_bytes=64 mode=400 owner=10001
  yawmi-loader: schema step done
  ```

  سطرا NOTICE متوقعان: المحمّل ينشئ المخطط وجدول الدفتر قبل `0001`، ثم يعيد `0001` إنشاءهما بـ`IF NOT EXISTS` فيتخطاهما Postgres بتنبيه. وعند الإعادة يصير سطر `applied` هو `yawmi-loader: 0001_yawmi_schema.sql already applied, skipped` ويغيب سطر `generated`، ويبقى سطرا NOTICE (يصدران حينها عن سطري الإنشاء في المحمّل نفسه).
- **إن فشل:** المعاملة تُلغى كلها، فلا مخطط ناقص. `sha256 mismatch` أو `FAILED` يعني أن الملف تغيّر بعد توليده (يُعاد التوليد بـ`python -I deploy/tools/build_loaders.py`).
- **التراجع** (يحتاج موافقة مستقلة، ولا يُجرى بعد نشر الواجهة): في `psql` بحساب `raqib_admin`: `DROP SCHEMA yawmi CASCADE;` يحذف مخطط يومي كله (لا بيانات فيه قبل الخطوة 7). وسر كلمة المرور يُحذف بحذف الـvolume (3أ) بعد التأكد أن لا مشروع يستعمله. ثم يُحذف مشروع `yawmi-loader` المتوقف من واجهة Hostinger (دون خيار حذف الـvolumes).

## الخطوة 4 · محمّل 2: الدور والبذرة وفحص `yawmi_api`

**يحتاج موافقة عبدالله المستقلة.** المشروع `yawmi-loader` نفسه، من الملف `deploy/compose/yawmi-db-2-role.yml`، ومتغيره `YAWMI_DB_HOST`.

**شرط الترتيب:** يُشغَّل بعد الخطوة 2 (جدولا W9) وبعد الخطوة 3 (محمّل 1)، لا قبلهما. ويتحقق المحمّل من الشرطين بنفسه قبل أي تغيير: يتوقف إن لم يجد `0001` مسجلاً في `schema_migrations` (ويطلب محمّل 1)، أو إن غاب أحد كائنات `raqib` السبعة التي يمنحها `0002` القراءة (ويطلب محمّل W9 الأول ويطبع أسماء المفقود).

ما يفعله، بالترتيب: يرفض التشغيل إن غاب السر (فالمحمّل 1 قبله) أو غابت البذرة من الملف ← يتحقق من تطبيق `0001` ومن وجود جداول المرآة في `raqib` ← يطبّق `0002` دون كلمة مرور (فينشئ الدور ويكتفي بتنبيه NOTICE) ← يضبط كلمة مرور الدور على ما في الملف بجملة `ALTER ROLE` واحدة معزولة عن السجلات (§ 0)، وفي كل تشغيل، فيصحّح أي انفصال بينه وبين الملف ← يطبّق بذرة العادات (إدراج مع تحديث يحفظ المرسى والتذكيرات وتاريخ البداية، فتكراره آمن) ← يتصل بحساب `yawmi_api` نفسه عبر الشبكة ويجرّب المسموح والمرفوض.

- **المطبوع المتوقع:**

  ```text
  /tmp/0002.sql: OK
  <64 خانة سداسية>  /tmp/0002.sql
  /tmp/seed.sql: OK
  <64 خانة سداسية>  /tmp/seed.sql
  NOTICE:  yawmi_api: no password supplied; the role cannot log in over the network yet
  yawmi-loader: applied 0002_yawmi_role.sql
  yawmi-loader: yawmi_api password synced
  yawmi-loader: system habits upserted
  yawmi-verify migrations=0001_yawmi_schema.sql,0002_yawmi_role.sql
  yawmi-verify system_habits=10
  yawmi-verify api_role=f,f,f,5,t
  yawmi-verify api_login=yawmi_api,search_path=yawmi
  yawmi-verify api_reads_habits=10
  yawmi-verify api_reads_raqib_kpis=<عدد>
  yawmi-verify api_reads_v_journal_daily=<عدد>
  NOTICE:  yawmi-verify denied_probes=4/4
  yawmi-loader: role step done
  ```

  معنى `api_role` (وPostgres يطبع القيم المنطقية `f` و`t`): ليس مديراً ولا ينشئ قواعد ولا أدواراً، وحد اتصالاته 5، وله كلمة مرور. و`denied_probes=4/4`: رُفض `DELETE` على `yawmi.events`، والقراءة من `yawmi.schema_migrations`، وإنشاء جدول في `yawmi`، والقراءة من `raqib.facts`. وتنبيه NOTICE عن «no password supplied» متوقع في أول تشغيل فقط: يطبّق `0002` قبل أن تُضبط كلمة المرور في السطر التالي له، وعند الإعادة يغيب مع سطر `applied` (يحل محلهما `already applied, skipped`).
- **إن فشل:** المحمّل ليس معاملة واحدة، فيجب معرفة أين توقف:
  - **قبل سطر `yawmi-loader: system habits upserted`** (فشل الحزمة أو شرط الترتيب أو `0002` أو كلمة المرور أو البذرة): لكل من `0002` مع سطر دفتره، ثم `ALTER ROLE`، ثم البذرة معاملة مستقلة. فالجزء الذي فشل لا يترك أثراً، وما سبقه ثابت (مثلاً: فشل البذرة يترك `0002` وكلمة المرور مثبتتين). إعادة التشغيل بعد إصلاح السبب آمنة: تتخطى `0002` إن سُجّل، وتُعيد ضبط كلمة المرور والبذرة.
  - **بعد سطر `yawmi-loader: system habits upserted`**: ما بعده تحقق للقراءة فقط (أسطر `yawmi-verify` واتصال `yawmi_api` وفحص المرفوض). **أي فشل هناك فشل تحقق فقط؛ التغييرات مثبتة (الدور وكلمة المرور والبذرة وسطر `schema_migrations`)** ولا شيء تراجع. لا يُعاد التطبيق بحثاً عن إصلاح: يُقرأ سبب الفشل (كائن في `raqib` أُعيدت تسميته، أو صلاحية لا تطابق المتوقع، أو فشل اتصال `yawmi_api` عبر الشبكة)، ويُصلَح، ثم يُعاد تشغيل المحمّل نفسه فيتخطى `0002` ويكرر التحقق. أما `DENIED=NO` فيعني صلاحية زائدة على الدور (التفاصيل في «أسباب شائعة» أدناه) ويوقف النشر.
- **أسباب شائعة:**
  - `raqib objects missing: …` ← الخطوة 2 ناقصة.
  - `yawmi_api_pw is missing` ← الخطوة 3 لم تُنفَّذ.
  - `is not embedded in this file` ← ملف المحمّل وُلّد قبل وجود `api/db/seed/habits.sql`: يُعاد توليده بـ`python -I deploy/tools/build_loaders.py` ثم يُفحص بـ`--check` (ملحق ب).
  - `DENIED=NO` ← صلاحية زائدة للدور: يُوقف النشر ويُسجَّل في `FAILURES.md`.
- **التراجع** (موافقة مستقلة): `DROP OWNED BY yawmi_api; DROP ROLE yawmi_api;` ثم `DELETE FROM yawmi.schema_migrations WHERE filename = '0002_yawmi_role.sql';`. والبذرة: `DELETE FROM yawmi.habits WHERE system;` (لا سجلات عادات قبل نشر الواجهة).

**4ب · محمّل 3: ترحيل `0003` لجولة الويب للحاسوب — يحتاج موافقة عبدالله المستقلة.** المشروع `yawmi-loader` نفسه، من الملف `deploy/compose/yawmi-db-3-web.yml`، ومتغيره `YAWMI_DB_HOST`. نص فقط في هذه الجولة: لا يُشغَّل قبل أن تُدمج مهام الخادم كلها ويُجمَّد `0003` في مهمة الإغلاق.

**شرط الترتيب:** بعد محمّل 2 (الخطوة 4). يتحقق المحمّل بنفسه قبل أي تغيير: يتوقف إن لم يجد `0002` مسجلاً في `schema_migrations` (ويطلب محمّل 2)، أو إن غاب `raqib.notion_cards`. ولا يلمس كلمة مرور الدور ولا الـvolume `yawmi_secrets` (يُركَّب للقراءة فقط).

ما يفعله: يطبّق `0003` وسطر دفتره في معاملة واحدة (عشرة جداول وأربعة أعمدة والـview `yawmi_ro.notion_card_fields` في مخطط `yawmi_ro` الخاص به، ومنح `yawmi_api`)، ثم يعيد تثبيت قسم المنح من الملف في **كل** تشغيل حتى لو كان `0003` مسجلاً ← يتحقق بصلاحية `yawmi_api` عبر `SET ROLE` أن القراءة من الـview تنجح وأن عمود `props` و`DELETE` على `goal_edits` والدفتر مرفوضة.

- **المطبوع المتوقع:**

  ```text
  /tmp/0003.sql: OK
  <64 خانة سداسية>  /tmp/0003.sql
  yawmi-loader: applied 0003_yawmi_web.sql
  yawmi-loader: grants re-asserted
  yawmi-verify migrations=0001_yawmi_schema.sql,0002_yawmi_role.sql,0003_yawmi_web.sql
  yawmi-verify schema_tables=23
  yawmi-verify api_reads_card_fields=<عدد>
  yawmi-verify api_reads_goal_edits=0
  NOTICE:  yawmi-verify denied_probes=3/3
  yawmi-loader: web step done
  ```

  وعند الإعادة يصير سطر `applied` هو `yawmi-loader: 0003_yawmi_web.sql already applied, skipped`.
- **إن فشل:** المعاملة تُلغى كلها فلا جدول ناقص، ثم يُقرأ السبب: `is not applied: run loader 2 first` ← الخطوة 4 ناقصة؛ `raqib.notion_cards is missing` ← الخطوة 2 ناقصة؛ `sha256 mismatch` ← الملف تغيّر بعد توليده (ملحق ب). و`DENIED=NO` يوقف النشر ويُسجَّل في `FAILURES.md`.
- **تنبيه:** إعادة تطبيق `0002` تصفّر منح `yawmi_api` على كل جداول `yawmi` بما فيها جداول `0003` (ومنها `DELETE` على `ai_memory` و`indicators`)، فيجب تشغيل محمّل 3 بعد أي إعادة تطبيق لمحمّل 2 (يعيد المنح دون حذف سطر الدفتر). والـview في `yawmi_ro` لا يمسّه `0002`، فلا يصير قابلاً للكتابة.
- **التراجع** (موافقة مستقلة، ولا يُجرى بعد نشر الواجهة): `DROP SCHEMA yawmi_ro CASCADE;` ثم حذف الجداول العشرة بأسمائها، و`ALTER TABLE` لإسقاط الأعمدة الأربعة، ثم `DELETE FROM yawmi.schema_migrations WHERE filename = '0003_yawmi_web.sql';`.

## الخطوة 5 · وسم الإصدار وبناء الصورة

**يحتاج موافقة عبدالله المستقلة** (دفع وسم إلى GitHub، وفق قاعدة «لا push دون موافقة»).

```sh
git tag api-v0.1.0
git push origin api-v0.1.0
```

الوسم يوضع على commit مدموج في `main`، ويرفض سير العمل غيره قبل البناء. يبني `.github/workflows/api-image.yml` الصورة ويدفعها إلى `ghcr.io/nexgen94/yawmi-api:0.1.0` (خاصة، لأن المستودع خاص). وفيها شيفرة الإشعارات أصلاً، فلا وسم ثانٍ لها (11هـ). وقبل الدفع يتحقق من أن المستخدم داخل الصورة uid 10001، وأن `yawmi.main` يُستورد، وأن `yawmi-admin --help` يعمل.

- **المطبوع المتوقع:** مهمة `image` خضراء في تبويب Actions، وظهور الحزمة `yawmi-api` بوسم `0.1.0` في صفحة حزم المستودع.
- **قيد قائم (Issue #5):** GitHub Actions معطّل على مستوى الحساب (`startup_failure`)، ولا Docker على جهاز التطوير. فإلى أن يُحل لا تُبنى الصورة، وتتوقف الخطوات 6–10. بديل يحتاج موافقة مستقلة: بناء الصورة على الخادم نفسه من نسخة من مجلد `api/`، ووسمها باسم الصورة نفسه.
- **التراجع:** حذف الحزمة من صفحة الحزم، وحذف الوسم: `git push origin :refs/tags/api-v0.1.0` (موافقة مستقلة).

## الخطوة 6 · تسجيل GHCR من طرفية الخادم

**يحتاج موافقة عبدالله المستقلة.**

1. **عبدالله في GitHub:** إنشاء Personal access token (classic) بصلاحية `read:packages` وحدها، ومدة قصيرة.
2. **عبدالله في طرفية الخادم:** `docker login ghcr.io -u NexGen94`. يطلب الأمر كلمة المرور، فيكتب عبدالله الرمز بنفسه ولا يظهر على الشاشة. **لا يُكتب الرمز في أمر ولا في ملف ولا في المحادثة.**
3. سحب الصورة يدوياً، فلا يحتاج مدير Docker إلى بيانات الدخول بعد ذلك: الخدمتان في الملف عليهما `pull_policy: never`، فلا يحاول compose السحب أبداً، ويفشل المشروع برسالة واضحة إن غابت صورة محلياً:

   ```sh
   docker pull ghcr.io/nexgen94/yawmi-api:0.1.0
   docker image inspect ghcr.io/nexgen94/yawmi-api:0.1.0 --format '{{.Config.User}}'
   docker pull ghcr.io/nexgen94/yawmi-web:0.1.0
   docker image inspect ghcr.io/nexgen94/yawmi-web:0.1.0 --format '{{.Config.User}}'
   ```

   الصورتان تُسحبان في نافذة الدخول والخروج نفسها، لأن ملف compose يحوي الخدمتين، والمشروع لا يقوم إن غابت إحداهما (الحزمتان خاصتان ولا دخول مخزَّناً بعد الخروج). وصورة الويب تُبنى أولاً بالخطوة 11أ.

4. **آخر خطوة فرعية، تسجيل الخروج فور السحب:** `docker logout ghcr.io`. الرمز يبقى بعد `docker login` في `config.json` للمستخدم على الخادم إلى أن يُخرَج، وبعد السحب لا حاجة إليه. ثم يلغيه عبدالله من إعدادات GitHub إن لم يكن سيُعاد الاستعمال قريباً.

- **المطبوع المتوقع:** `Login Succeeded` (مع تنبيه أن بيانات الدخول تُحفظ في `config.json` للمستخدم)، ثم `Status: Downloaded newer image for ghcr.io/nexgen94/yawmi-api:0.1.0`، ثم `10001:10001`، وأخيراً `Removing login credentials for ghcr.io`. وللويب: `Status: Downloaded newer image for ghcr.io/nexgen94/yawmi-web:0.1.0` ثم `101`.
- **التراجع:** إن تعذّر إكمال السحب فيُنفَّذ تسجيل الخروج مع ذلك (الخطوة 4 أعلاه) قبل أي شيء. وإلغاء الرمز من إعدادات GitHub، و`docker rmi ghcr.io/nexgen94/yawmi-api:0.1.0 ghcr.io/nexgen94/yawmi-web:0.1.0`.

## الخطوة 7 · مشروع `yawmi-api`

**يحتاج موافقة عبدالله المستقلة.** إنشاء مشروع باسم `yawmi-api` في واجهة Hostinger من الملف `deploy/compose/yawmi-api.api.yml`، وكتابة المتغيرات من الجدول في § 0 (الأسرار منها بيد عبدالله وحده). **شرط مسبق:** صورة `yawmi-web:0.1.0` مبنيّة (11أ) ومسحوبة (الخطوة 6 أو 11ب) قبل هذه الخطوة؛ فالملف يحوي خدمتي `yawmi-api` و`yawmi-web` معاً. ملف compose يرفض النشر إن غاب `YAWMI_DB_HOST` أو `N8N_NETWORK` أو `YAWMI_JWT_SECRET` أو `YAWMI_ANTHROPIC_API_KEY` أو `YAWMI_API_HOST` أو `TRAEFIK_CERT_RESOLVER`. والخدمة نفسها ترفض الإقلاع إن قلّ `YAWMI_JWT_SECRET` عن 32 حرفاً.

عند بدء الحاوية يقرأ المدخل `/usr/local/bin/yawmi-entrypoint` كلمة المرور من `/run/yawmi/yawmi_api_pw` ويرمّزها (percent-encoding) ويركّب `YAWMI_DATABASE_URL` في بيئة العملية فقط، ثم يشغّل `uvicorn`.

- **المطبوع المتوقع:**

  ```sh
  docker ps --filter name=yawmi-api --format '{{.Names}} {{.Status}}'
  docker ps --filter name=yawmi-web --format '{{.Names}} {{.Status}}'
  docker port yawmi-api
  docker logs --tail 20 yawmi-api
  ```

  الأول: `yawmi-api Up … (healthy)` خلال دقيقة تقريباً. والثاني: `yawmi-web Up … (healthy)`. والثالث: لا ناتج (لا منفذ منشور). والرابع: أسطر بدء `uvicorn` (`Application startup complete`) بلا كلمة مرور ولا رابط اتصال، ثم سطر وصول لكل طلب بالصيغة `<وقت> INFO yawmi.access GET /v1/health/live -> 200 …` (فحص الصحة الداخلي كل 30 ثانية).
- **إن لم تصل الحاوية إلى `healthy`:** `docker logs yawmi-api`. `password file is missing or unreadable` ← الخطوة 3 أو حذف الـvolume. `password authentication failed` ← كلمة المرور في الملف لا تطابق الدور: يُعاد تشغيل محمّل 2 فيزامنها.
- **التراجع:** إيقاف المشروع `yawmi-api` وحذفه من واجهة Hostinger (دون خيار حذف الـvolumes). لا أثر له على القاعدة ولا على n8n. **والتراجع إلى إصدار سابق للواجهة البرمجية وحدها** يحتاج صورة `yawmi-web` الموجودة في الملف حاضرة على الخادم أيضاً، وإلا فشل المشروع كله.

## الخطوة 8 · فحص الصحة

**يحتاج موافقة عبدالله المستقلة** (طلبات قراءة فقط).

```sh
curl -sS -w '\n%{http_code} ssl=%{ssl_verify_result}\n' "https://$YAWMI_API_HOST/v1/health/live"
```

- **المطبوع المتوقع:** `{"ok":true}` ثم `200 ssl=0` (الشهادة سارية). تأخر الشهادة بضع دقائق بعد أول نشر طبيعي: يُعاد الأمر.
- **إن فشل:** `404` بصفحة nginx (من حاوية `yawmi-web`) ← الطلب لم يصل إلى موجّه `yawmi-api`: إما الحاوية ليست `healthy` فأسقط Traefik موجّهها ووقع الطلب على موجّه الويب (يُفحص بـ`docker ps --filter name=yawmi-api` و`docker logs yawmi-api`)، وإما قاعدته أو أولويته لا تطابق؛ `404` من Traefik نفسه (لا nginx) ← المضيف في `YAWMI_API_HOST` لا يطابق أي موجّه؛ `502` ← الشبكة `N8N_NETWORK` خاطئة؛ خطأ شهادة ← `TRAEFIK_CERT_RESOLVER` لا يطابق اسم المُصدِر.
- **التراجع:** لا شيء.

**8أ · إثبات حد الإقران (مرة واحدة).** حد Traefik على `/v1/devices/pair` (10 في الدقيقة، ودفعة 5) لم يُحمَّل قبل اليوم، وخطأ في علامة يعني غيابه دون أثر في أي سجل. عشرون طلباً سريعاً بكود خاطئ:

```sh
for i in $(seq 1 20); do
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://$YAWMI_API_HOST/v1/devices/pair" \
    -H 'Content-Type: application/json' -d '{"code":"00000000","name":"rl-check","kind":"web"}'
done | sort | uniq -c
```

- **المطبوع المتوقع:** سطران تقريباً: بضعة `400` (الدفعة الأولى تصل إلى الخدمة فترفض الكود) والباقي `429` (أوقفها Traefik). غياب `429` كلياً يعني أن الحد لا يعمل: يُوقف النشر وتُراجع علامات `yawmi-rl-pair`. والخدمة نفسها تُبطل كل كود غير مستعمل بعد أكثر من 20 إقراناً فاشلاً في عشر دقائق، والطلبات هنا 20 فلا تبلغ ذلك. ويُنتظر دقيقة قبل الخطوة 9 ليعود الحد كاملاً.
- **التراجع:** لا شيء (لا كود صالح يُستهلك، ولا يُكتب في القاعدة شيء).

## الخطوة 9 · كود إقران

**يحتاج موافقة عبدالله المستقلة.** الأمر يمر بالمدخل ليركّب رابط الاتصال، لأن `docker exec` المجرد لا يرث متغيرات المدخل:

```sh
docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin pair-code --kind web
```

الأنواع: `iphone` و`watch` و`web`.

- **المطبوع المتوقع:** ثمانية أرقام في سطر واحد (المخرج القياسي)، وفي مخرج الأخطاء: «الكود صالح 10 دقائق ولاستخدام واحد». لا يُلصق الكود في المحادثة. ولا شاشة إقران في التطبيق بعد، فالكود الأول يستهلكه فحص 9أ أدناه.
- **التراجع:** لا شيء. الكود ينتهي بعد 10 دقائق أو بأول استعمال.

**9أ · فحص بـ`curl`: أول طلب حقيقي.** أول مرة تمر فيها جمل الخدمة بصلاحيات الدور `yawmi_api` الحقيقية. يُقرن جهاز اختبار بنوع `web`، وتُحفظ القيم في متغيرات الطرفية فلا يُطبع رمز:

```sh
CODE="$(docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin pair-code --kind web)"
PAIR="$(curl -sS -X POST "https://$YAWMI_API_HOST/v1/devices/pair" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"curl-smoke\",\"kind\":\"web\"}")"
TOKEN="$(printf '%s' "$PAIR" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
DEVICE_ID="$(printf '%s' "$PAIR" | sed -n 's/.*"device_id":"\([^"]*\)".*/\1/p')"
unset CODE PAIR
printf '%s\n' "$DEVICE_ID"; printf '%s' "$TOKEN" | awk -F. '{print NF}'

curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "https://$YAWMI_API_HOST/v1/today"
curl -sS -H "Authorization: Bearer $TOKEN" "https://$YAWMI_API_HOST/v1/today" | grep -o '"code":' | wc -l

EVENT="{\"events\":[{\"id\":\"$(cat /proc/sys/kernel/random/uuid)\",\"type\":\"app_opened\",\"payload\":{},\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}"
curl -sS -X POST "https://$YAWMI_API_HOST/v1/events" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$EVENT"; echo
curl -sS -X POST "https://$YAWMI_API_HOST/v1/events" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$EVENT"; echo

curl -sS -H "Authorization: Bearer $TOKEN" "https://$YAWMI_API_HOST/v1/habits" | grep -o '"code":' | wc -l

docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin revoke --id "$DEVICE_ID"
docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin devices
unset TOKEN DEVICE_ID EVENT
```

- **المطبوع المتوقع، بالترتيب:** معرّف الجهاز (UUID) ثم `3` (رمز الوصول ثلاثة أجزاء)؛ ثم `200` لـ`/v1/today` ثم `10` (عشر عادات في `habits_due`)؛ ثم `{"accepted":1,"duplicates":0}` لأول إرسال للحدث و`{"accepted":0,"duplicates":1}` لتكراره (الحدث نفسه بمعرّفه نفسه، فلا يُخزَّن مرتين)؛ ثم `10` لـ`/v1/habits`؛ ثم في مخرج الأخطاء «أُبطل الجهاز وحُذفت اشتراكات إشعاراته»؛ ثم جدول الأجهزة وفيه `curl-smoke` بعمود `revoked_at` مملوء.
- **إن فشل:** `500` في أي طلب ← غالباً صلاحية ناقصة للدور أو عمود لا يطابق: `docker logs --tail 50 yawmi-api` يسمّي الخطأ، ويُسجَّل في `FAILURES.md` ويُوقف النشر. `401` ← الرمز لم يُقرأ من رد الإقران (الكود انتهى أو استُهلك: يُعاد من أول سطر بكود جديد).
- **ما يبقى:** حدث `app_opened` واحد وصف جهاز `curl-smoke` مُبطَل، ولا يُحذفان (الدور لا يحذف من `events`). ورمز الوصول المنسوخ يبقى صالحاً حتى 15 دقيقة بعد الإبطال لأنه عديم الحالة، ثم ينتهي، ولا رمز تحديث يُجدّده.
- **التراجع:** لا شيء غير الإبطال الذي يتم في الفحص نفسه.

## الخطوة 10 · رمز خدمة

**يحتاج موافقة عبدالله المستقلة.** **عند الحاجة فقط، لا ضمن التسلسل:** لا workflow يستدعي الخدمة اليوم، وإبطال جهاز يتم بالأداة `yawmi-admin revoke` (9أ) بلا رمز. الحاجة الوحيدة المعروفة فحص المفتاح العام في 11هـ. والرمز يُحفظ في متغير في طرفية الخادم، ولا يُطبع:

```sh
SERVICE_TOKEN="$(docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin service-token --name on-demand --ttl-hours 1)"
printf '%s' "$SERVICE_TOKEN" | awk -F. '{print NF}'
```

- **المطبوع المتوقع:** في مخرج الأخطاء: «سُجّل جهاز الخدمة، والرمز صالح 1 ساعة، ولا يُعرض مرة ثانية»، ثم `3` (الرمز ثلاثة أجزاء تفصلها نقطتان). ولا رمز تحديث له. وبعد الاستعمال: `unset SERVICE_TOKEN`.
- **لا يُخزَّن** في n8n ولا في ملف ولا في المحادثة. وإن احتاج workflow لاحقاً رمزاً دائماً فذلك قرار مستقل.
- **التراجع:** لا يوجد إبطال لرمز خدمة بعينه. الرمز عديم الحالة: يتحقق منه الخادم بالتوقيع والانتهاء وحدهما دون قراءة القاعدة، فحذف صف الجهاز أو إبطاله لا يقطعه قبل انتهائه. **السبيل الوحيد لإبطاله هو تدوير `YAWMI_JWT_SECRET`** في واجهة Hostinger ثم إعادة نشر `yawmi-api`، وهذا يُسقط رموز كل الأجهزة والخدمات معاً فتُقرن الأجهزة من جديد. لذلك صلاحيته ساعة واحدة: بعدها ينتهي من تلقاء نفسه.

## الخطوة 11 · الويب (`yawmi-web`) على المضيف نفسه

**كل عملية فرعية يحتاج موافقة عبدالله المستقلة. لم يُنفَّذ منها شيء. 11أ و11ب تسبقان الخطوة 7، لأن ملف المشروع يحوي خدمة `yawmi-web`.** تُخدَم الحزمة الأمامية من حاوية nginx غير مميّزة (منفذ 8080، مستخدم 101) على مضيف الواجهة نفسه: Traefik يوجّه `/v1` إلى `yawmi-api` (الأولوية 100، و200 للإقران) وكل ما عداه إلى `yawmi-web` (الأولوية 1). فلا CORS ولا مضيف ثانٍ ولا متغير جديد: الخدمة بلا volume ولا بيئة، وتستعمل `YAWMI_API_HOST` و`N8N_NETWORK` و`TRAEFIK_*` الموجودة.

القواعد التي تفرضها `web/nginx.conf` (ويفحصها `web/tests/nginx.test.ts`):

- `/sw.js` و`/index.html` و`/manifest.webmanifest` وكل ملف خارج `/assets/`: `Cache-Control: no-cache`، فيصل الإصدار الجديد عند أول فتح.
- `/assets/` (ملفات ببصمة المحتوى): `public, max-age=31536000, immutable`، والملف الناقص يعيد 404 لا `index.html`.
- `/v1` لا يُخدَم هنا أبداً: إن وصل طلب إليه فالرد 404 (خطأ توجيه ظاهر، لا قشرة التطبيق).
- **HSTS** (`Strict-Transport-Security`) لا تُرسله حاوية الويب، لأن TLS ينتهي عند Traefik: يجب أن يأتي من Traefik (وسيط ترويسات) إن أُريد، وهو تعديل على الخادم يحتاج موافقة مستقلة ولم يُجرَ.
- على كل رد: `Content-Security-Policy` (`default-src 'self'` و`connect-src 'self'` و`frame-ancestors 'none'`…) و`X-Content-Type-Options: nosniff` و`Referrer-Policy: no-referrer`.

**11أ · الوسم والبناء.** (موافقة، دفع وسم) `git tag web-v0.1.0 && git push origin web-v0.1.0`، والوسم على commit مدموج في `main` (يرفض سير العمل غيره قبل البناء). يبني `.github/workflows/web-image.yml` الصورة (ومرحلة البناء تفشل إن تجاوز جافاسكربت التحميل الأول 80 كيلوبايت gzip)، ثم يشغّلها ويفحص الترويسات وقواعد التخزين المؤقت وuid 101 قبل الدفع إلى `ghcr.io/nexgen94/yawmi-web:0.1.0`. القيد القائم: Actions معطّل (Issue #5) ولا Docker على جهاز التطوير، فإلى أن يُحل لا تُبنى الصورة. التراجع: حذف الحزمة والوسم (`git push origin :refs/tags/web-v0.1.0`).

**11ب · السحب.** (موافقة) يتم داخل الخطوة 6، في نافذة الدخول والخروج نفسها لصورة `yawmi-api`: `docker login ghcr.io` بـPAT قراءة فقط يكتبه عبدالله بنفسه، ثم `docker pull ghcr.io/nexgen94/yawmi-web:0.1.0`، ثم `docker logout ghcr.io` فوراً. التراجع: `docker logout ghcr.io` وإلغاء الرمز من GitHub، و`docker rmi ghcr.io/nexgen94/yawmi-web:0.1.0` (على ألا يكون مشروع قائم يستعملها).

**11ج · التحديث اللاحق.** (موافقة) أول نشر للويب يحدث مع المشروع في الخطوة 7. وإصدار الويب التالي: وسم `web-vX.Y.Z` جديد، ثم سحبه (11ب) ثم تغيير وسم `yawmi-web` في الملف وتحديث المشروع. التراجع: إعادة الوسم السابق وتحديث المشروع (والصورة السابقة ما زالت محلية). وللتراجع عن الخدمة نفسها: حذف خدمة `yawmi-web` من الملف وتحديث المشروع، فيعود المضيف إلى الواجهة البرمجية وحدها. وإن بقيت حاوية `yawmi-web` تعمل بعد التحديث (قد يترك مدير Hostinger الحاويات اليتيمة) فتُوقف وتُحذف: `docker rm -f yawmi-web`، **بموافقة مستقلة**. ولا أثر على القاعدة ولا على n8n.

**11د · فحص (قراءة فقط، موافقة):**

```sh
curl -sSI "https://$YAWMI_API_HOST/"            | grep -i -e '^HTTP' -e '^cache-control' -e '^content-security-policy'
curl -sSI "https://$YAWMI_API_HOST/sw.js"       | grep -i -e '^HTTP' -e '^cache-control'
curl -sS  "https://$YAWMI_API_HOST/v1/health/live"
```

- **المطبوع المتوقع:** `200` و`cache-control: no-cache` وسياسة CSP للأولين، و`{"ok":true}` للثالث (لو عاد 404 من nginx فتوجيه `/v1` خاطئ: قاعدة `yawmi-api` أو أولويتها).
- **إن فشل:** `404` على `/` ← قاعدة `yawmi-web` أو `YAWMI_API_HOST`؛ وعودة 404 من Traefik نفسه (لا من nginx) تعني غالباً أن الحاوية ليست `healthy` فسقط موجّهها، و`502` أن الشبكة خاطئة؛ ويُفحص الاثنان بـ`docker ps --filter name=yawmi-web` و`docker logs yawmi-web`.

**11هـ · الإشعارات (موافقة لكل عملية):** شيفرة الإشعارات في الصورة الأولى أصلاً، فلا وسم جديد: ملف `deploy/compose/yawmi-vapid-keygen.yml` يسمّي وسم صورة `yawmi-api` نفسه الذي في `yawmi-api.api.yml` (`0.1.0`، المسحوبة في الخطوة 6)، ويُغيَّر الوسم في الملفين معاً عند كل إصدار. تشغيل مشروع لمرة واحدة من `deploy/compose/yawmi-vapid-keygen.yml` (الصورة نفسها، بلا شبكة، ويقرأ ويكتب volume الأسرار فقط؛ ومسار المفتاح من متغير `YAWMI_VAPID_PRIVATE_KEY_FILE` في الملف نفسه، لا من سطر الأوامر، ويُرفض أي مسار خارج `/run/yawmi`): يكتب `vapid_private.pem` (P-256، المالك root والمجموعة 10001، الوضع 0640) إن غاب ويبقيه إن وُجد، ويطبع المفتاح العام فقط، ولا يطبع الخاص ولا يسجّله؛ وتكراره آمن. ثم يضيف عبدالله بيده في متغيرات المشروع `YAWMI_VAPID_SUBJECT` (بالصيغة `mailto:` ببريد على نطاق حقيقي مملوك) و`YAWMI_PUSH_ENABLED=true` (الملف يمرّرهما ومسار المفتاح `/run/yawmi/vapid_private.pem`)؛ والخدمة ترفض الإقلاع إن فُعّلت الإشعارات والمفتاح أو العنوان غائب. والتحقق: `GET /v1/push/vapid-public-key` بترويسة `Authorization: Bearer "$SERVICE_TOKEN"` ورمز خدمة صالح ساعة يُصدَر لهذا الغرض (الخطوة 10؛ أي رمز جهاز غير ملغى يصلح؛ ومن دونه 401)، يبقى في متغير في طرفية الخادم ولا يُلصق في المحادثة، فيعيد المفتاح نفسه الذي طُبع. خدمات الدفع المسموح بها قائمة في متغير المشروع الاختياري `YAWMI_PUSH_HOSTS` (يمرّره الملف؛ فارغاً يبقى الافتراضي: Apple وFCM وMozilla وWindows؛ وإن كُتب فقائمة أسماء نطاقات مفصولة بفواصل، كل اسم بحرفين أو أكثر من المقاطع وبلا نجمة)، ولا يتصل الخادم بغيرها ولا بعنوان غير عام؛ واسم مشوّه فيها يمنع الإقلاع والإشعارات مفعّلة، ويُهمَل وهي معطّلة. التراجع: حذف المتغيرين من المشروع وإعادة النشر (يبقى مفتاح VAPID الخاص في volume الأسرار ولا يُطبع)، وحذف مشروع `yawmi-vapid-keygen` المنتهي.

**11و · على الآيفون (عبدالله):** Safari ← المضيف ← مشاركة ← «إضافة إلى الشاشة الرئيسية». **من الأيقونة لا من Safari** (التخزين منفصل). ولا شاشة إقران بعد، فالإقران من الجهاز ينتظرها؛ وحين توجد يُصدَر له كود جديد بالخطوة 9 بنوع `web` (الكود الأول استهلكه فحص 9أ). لا شاشة تطلب إذن الإشعارات بعد (الواجهة مؤجلة)، فتفعيلها ينتظر الشاشة التي تستدعي `enablePush()`. وحين توجد، تُفحص على الجهاز قبل الاعتماد عليها: (1) يظهر الإشعار والتطبيق مغلق، ويُقرأ من اليمين إلى اليسار؛ (2) أي طريق عرضه: الصيغة التصريحية (يعرضه Safari دون العامل) أم العامل الاحتياطي؛ (3) النقر يفتح التطبيق على `/`؛ (4) شارة الأيقونة تعرض العدد الصحيح، مع العلم بقبول هذا عن قصد: لا شاشة تمسح الشارة بعد، فتبقى حتى الإشعار التالي؛ (5) حذف التطبيق من الشاشة الرئيسية يجعل الإرسال التالي 410 ويُحذف صف الاشتراك. وإن فشل النقر أو الشارة، فالبديل: `navigate` مطلق مبني من أصل عام مُعدّ، و`app_badge` نصاً، ثم إعادة الفحص. التراجع: حذف التطبيق من الشاشة الرئيسية، ثم معرفة معرّف الجهاز بـ`docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin devices` وإبطاله بـ`docker exec yawmi-api /usr/local/bin/yawmi-entrypoint yawmi-admin revoke --id <المعرّف>` (بلا رمز خدمة)، فتُحذف اشتراكاته معه في المعاملة نفسها.

## ملحق أ · تحديث الصورة

وسم جديد `api-vX.Y.Z` (الخطوة 5)، ثم تغيير الوسم في سطر `image:` من `yawmi-api.api.yml` ومن `yawmi-vapid-keygen.yml` معاً (وسم واحد في الملفين)، و`docker pull` للوسم الجديد بتسجيل دخول جديد ثم خروج (الخطوة 6: 2 و3 و4)، ثم تحديث مشروع `yawmi-api` في واجهة Hostinger. **يحتاج موافقة مستقلة.** التراجع: إعادة الوسم السابق وتحديث المشروع.

## ملحق ب · إعادة توليد المحمّلين

بعد أي تعديل في `api/db/migrations/*.sql` أو `api/db/seed/habits.sql`:

```sh
python -I deploy/tools/build_loaders.py          # يكتب الملفات الثلاثة
python -I deploy/tools/build_loaders.py --check  # يفشل إن اختلفت البصمات
python -I deploy/tools/check_compose.py deploy/compose
```

يحذف المولّد أسطر التعليقات والفراغات وحدها (وإلا لم يتسع الملفان لثمانية آلاف حرف) ويضغط ويرمّز base64. ويرفض ملفاً فيه `/* */` أو سطر تعليق داخل نص مقتبس. ولا يُخزَّن في الملفين أي سر.

## ملحق ج · التعافي وتدوير كلمة المرور

- **ضياع الـvolume `yawmi_secrets`:** الـvolume خارجي فلا يُعاد إنشاؤه من compose. يُنشأ من جديد بأمر 3أ، ثم يُشغَّل محمّل 1 فيولّد كلمة مرور جديدة، ثم محمّل 2 فيضبطها على الدور، ثم تُعاد تشغيل `yawmi-api`. (**موافقة مستقلة لكل عملية.**)
- **تدوير كلمة المرور عن قصد:** حذف الملف `yawmi_api_pw` من الـvolume (أو إعادة إنشاء الـvolume) ثم التعافي بالخطوتين السابقتين: محمّل 1 ثم محمّل 2.
- **تدوير `YAWMI_JWT_SECRET`:** يُسقط كل الرموز الصادرة (الأجهزة المقرونة ورموز الخدمة).
