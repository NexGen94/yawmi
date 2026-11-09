# CLAUDE.md · مستودع «يومي»

> قواعد ثابتة لكل وكيل يعمل هنا. تعديل هذا الملف يحتاج موافقة عبدالله.

## المشروع
متابعة يومية للأهداف والعادات، بالعربية وRTL: `api/` خدمة FastAPI، و`web/` تطبيق PWA، و`YawmiKit/` حزمة Swift، و`openapi/` المواصفة المثبّتة، و`contracts/domain-vectors/v1/` المتجهات المشتركة، و`deploy/` ملفات النشر. بايثون هو التنفيذ المرجعي لقواعد النطاق، وعلى TypeScript وSwift اجتياز ملفات المتجهات نفسها.

## المرجع
مسارات نسبية إلى مستودع الخطة، ولا يُنسخ محتواها هنا:
- المواصفة: `docs/superpowers/specs/2026-11-09-yawmi-ios-architecture.md`
- البرومبت: `docs/superpowers/specs/2026-11-09-yawmi-app-brief.md`
- الخطة: `docs/superpowers/plans/2026-11-09-yawmi-phase0-1.md`

## المهارات الواجبة (قاعدة D-056)
| المجال | المهارات |
|---|---|
| Python/FastAPI | `fastapi` و`api-design-principles` |
| الويب | `frontend-design:frontend-design` و`web-design-guidelines` و`design:accessibility-review` |
| Swift | `swift-concurrency` و`swiftui-expert-skill` |
| أي خطأ | `superpowers:systematic-debugging` |
| قبل قول «تم» | `superpowers:verification-before-completion` |

## القيود العامة
- **النصوص:** كل نص يراه المستخدم بالعربية، بلا مخاطبة بجنس.
- **الأسرار:** لا مفتاح ولا توكن ولا IP ولا اسم خادم في أي ملف. تُقرأ الأسرار من volume `yawmi_secrets` أو من بيئة الحاوية فقط.
- **compose:** كل ملف ≤ 8192 حرفاً، بنهايات LF، وبلا وسم `latest`.
- **Postgres:** مخطط `yawmi` داخل قاعدة `raqib`. `timestamptz` دائماً، ولا `serial`. معرّفات الأحداث UUIDv7 من العميل مع `ON CONFLICT (id) DO NOTHING`.
- **الزمن:** اليوم بتوقيت `Asia/Riyadh`، و`week_start = sun`.
- **الواجهة البرمجية:** كل المسارات تحت `/v1`.
- **الذكاء الاصطناعي:** Anthropic افتراضياً: `claude-haiku-5-5` يومياً و`claude-sonnet-5-5` أسبوعياً. المخرجات مقيّدة بمخطط، وسطران كحد أقصى، وأي `source_id` خارج الحمولة يُرفض.
- **الويب:** ≤ 80 KB gzip للتحميل الأول، وخصائص CSS المنطقية فقط.
- **Swift:** لا استيراد Apple في `Domain` و`SyncClient`.

## سير العمل في Git/GitHub (D-061)
- فرع لكل مهمة باسم `task/NN-slug`.
- رسائل commit بصيغة Conventional Commits بالإنجليزية، مثل `feat(db): …`.
- PR لكل مهمة بوصف ونتائج الاختبار، ودمج squash بعد المراجعة.
- Issue لكل خطأ أو طريق مسدود.
- CI في GitHub Actions.
- لا push إلى `main` مباشرة بعد الـcommit الأول.
- لا أسرار في الـcommits.

## التحقق قبل «تم»
```bash
cd api && uv run pytest -q
cd api && uv run ruff check .
```
