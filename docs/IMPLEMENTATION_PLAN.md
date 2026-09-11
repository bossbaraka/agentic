# خطة التنفيذ — MUREEH Agent

> الخطة نُفّذت على مراحل مع الحفاظ الكامل على الميزات القائمة (واتساب، اللوحة،
> مخزن الجلسات، محرّكا LLM). أي تغيير في مستقر جرى بأقل سطح لمس آمن.

## المراحل

### صفر — فحص وتثبيت الأساسات
- فحص المستودع: Fastify، قناتا تيليجرام/واتساب، حلقة Function Calling،
  الشخصية والـ prompt، مخزن JSON، منطق التوفر النقي.
- إضافة المتغيرات والإعدادات: `DB_PATH`، `DB_IMPORT_LEGACY`،
  `ADMIN_TELEGRAM_IDS`، `NOTIFICATIONS_*`، `BOOKING_REMINDER_HOURS`.

### 1 — قاعدة البيانات
- `src/db/client.ts` (فتح/ترحيل/معاملة/فحص صحة)، `migrations.ts` (v1: 14 جدولًا
  +23 فهرسًا + قيد منع الازدواج الجزئي)، `types.ts`.
- المستودعات: `users` (ومنه admins/customers)، `catalog`، `bookings`،
  `commerce` (orders/payments/tickets)، `conversations` (ومنها messages)،
  `notifications`، `system` (audit/metrics).
- `seed.ts` (كتالوج idempotent + مشرفو ENV) و`legacyImport.ts`.

### 2 — منطق الأعمال (خدمات)
- `catalogService` (كتالوج ديناميكي، بحث، ترقيم صفحات، إيقاف/تفعيل).
- `bookingService` (إنشاء ذري، منع ازدواج، عدّاد سعة، تعديل/إلغاء مع الملكية،
  دورة الحالات الخمس، جدولة التذكيرات والتنبيهات).
- `orderService`, `ticketService`, `handoffService`, `notificationService`
  (طابور + عامل + تراجع أُسي + إلغاء تذكيرات)، `adminService` (RBAC + تدقيق +
  مقاييس)، `rbac.ts`, `errors.ts`, `conversationBridge.ts`.

### 3 — طبقة الوكيل
- `tools-types.ts` (عقد ToolContext/ToolResult)، `toolRegistry.ts`
  (تحقق صارم، تدقيق، رفض غير المسجّل، التقاط استثناءات).
- إعادة كتابة `tools.ts` عبر الخدمات فقط (19 أداة، لا مستودعات مباشرة)،
  توثيق عربي للنماذج.
- ربط `agent.ts` بالجسر (مزامنة المستخدم/المحادثة/الرسائل/اللغة/الحالات)،
  سياق قناة ولغة للأدوات، معالجة sideEffect الجديد `handoff`.

### 4 — واجهة تيليجرام
- توسعة `client.ts` (إرسال Markdown مع سقوط نص خام، لوحات inline + reply،
  تعديل/حذف، answerCallback مع alert، setMyCommands).
- `keyboards.ts` (اللوحة الدائمة، تنقل، ترقيم صفحات، منتقيات تاريخ/وقت،
  تأكيدات، إدارة حجز).
- `menus.ts` (نصوص الشاشات ar/en، حالة المعالج WizardState).
- `router.ts` (القوائم وحوارات الحجز/الطلب/التعديل بلا منطق أعمال).
- `admin.ts` (لوحة الموظفين وأوامر RBAC النصية).
- `dispatcher.ts` (نقطة قرار: إدارة ← قوائم ← وكيل ذكي).
- ربط الإقلاع في `server.ts`: openDb + seed + استيراد legacy + عامل الإشعارات +
  setMyCommands، والموزّج للـ webhook والـ polling والـ simulate.

### 5 — الإدارة والتحليلات
- لوحة الموظف داخل تيليجرام (إحصائيات، حجوزات، طلبات، تذاكر، خدمات، عملاء،
  موظفون، سجل تدقيق) + أوامر نصية (`/admin`, `/addstaff`, `/take`...).
- لوحة الويب: بطاقات مؤشرات DB جديدة في `/api/sessions` ومؤشرات الصحة.

### 6 — الاختبارات والتغليف
- اختبارات `node:test` (راجع `TESTING_PLAN.md`).
- `Dockerfile` على `node:22-slim`، healthcheck، volume بيانات.
- تحديث `engines`، `render.yaml` (nodeVersion + ملاحظة القرص)،
  `docker-compose.yml`, `.env.example`.

## مبادئ التغيير الآمن المتبعة

- لا حذف لمسارات واتساب ولا لشاشات اللوحة؛ الجديد يُضاف ويُربط بجانب القديم.
- مخزن JSON يبقى ذاكرة المحادثة الحية؛ DB مصدر حقائق الأعمال، والجسر دفاعي
  يفشل بهدوء فلا يكسر الرد على العميل.
- كل عملية حساسة في خدمة واحدة موثقة ومدققة؛ الواجهات والنماذج عملاء لها فقط.

## النشر

1. اضبط البيئة: `cp .env.example .env` ثم املأ التوكنات و`ADMIN_TELEGRAM_IDS`
   و`DASHBOARD_PASSWORD` و`TELEGRAM_WEBHOOK_SECRET` (ولّده: `openssl rand -hex 32`).
2. محليًا: `npm ci && npm test && DEMO_MODE=false npm start`.
3. Docker:
   ```bash
   docker build -t mureeh-agent .
   docker run -d -p 3000:3000 --env-file .env -v mureeh-data:/app/data --name mureeh-agent mureeh-agent
   ```
   أو `docker compose up -d`.
4. على Render: `render.yaml` مع Node 22؛ اربط قرصًا دائمًا على باقة مدفوعة
   (المجانية تفقد SQLite عند إعادة النشر — قيد موثّق).
5. عند الإقلاع تُطبَّق الترحيلات تلقائيًا، تُزرع الخدمات، وتُستورد بيانات JSON
   القديمة مرة واحدة (قابل لإعادة التشغيل بأمان)، ويبدأ عامل الإشعارات وتُسجَّل
   أوامر البوت.
