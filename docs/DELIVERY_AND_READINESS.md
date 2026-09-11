# التسليم النهائي وحكم الجاهزية للإنتاج — MUREEH Agent

## 1. ملخص المعمارية (Architecture Summary)

قناة الاستقبال (تيليجرام webhook/polling أو واتساب Cloud API موقّع HMAC) تدخل
**موزّعًا واحدًا** (`src/telegram/dispatcher.ts`): أوامر/أزرار الإدارة →
`TelegramAdminHandler` (RBAC)، قوائم النظام → `TelegramMenuRouter`
(لوحات inline/reply، ترقيم صفحات، حوارات حجز/طلب)، والنص الحر فقط →
**الوكيل الذكي** القائم (Orchestrator + LLM + Function Calling).

النموذج لا ينفذ عمليات أعمال؛ كل الاستدعاءات تمر عبر سجل موحّد
(`toolRegistry`: تحقق صارم → رفض غير المسجّل → تدقيق → التقاط استثناءات) ثم
عبر **طبقة خدمات** هي المصدر الوحيد للحقيقة:
`catalogService · bookingService · orderService · ticketService · handoffService ·
notificationService · adminService` فوق مستودعات رفيعة وقاعدة SQLite
(14 جدولًا، قيد فريد جزئي لمنع ازدواج الفتحات، معاملات `BEGIN IMMEDIATE`).

مخزن الجلسات JSON بقي يعمل كذاكرة محادثة حيّة، مع جسر مزامنة دفاعي إلى DB
(`conversationBridge`) — فلا الميزات القديمة كُسرت ولا هناك منطقان متنافسان.

## 2. الملفات المتغيّرة/المضافة (Files Changed)

**جديدة — قاعدة البيانات:** `src/db/{client,migrations,types,seed,legacyImport}.ts`
و`src/db/repos/{users,catalog,bookings,commerce,conversations,notifications,system}.ts`.
**جديدة — الخدمات:** `src/services/{rbac,errors,catalogService,bookingService,
orderService,ticketService,handoffService,notificationService,adminService,
conversationBridge}.ts`.
**جديدة — الوكيل:** `src/agent/toolRegistry.ts`, `src/agent/tools-types.ts`
(و`src/lib/i18n.ts`).
**جديدة — تيليجرام:** `src/telegram/{keyboards,menus,router,admin,dispatcher}.ts`.
**جديدة — اختبارات وبنية تحتية:** `tests/` (4 ملفات + helpers، 30 اختبارًا)،
`.github/workflows/ci.yml`، تحديث `Dockerfile` (node:22-slim)،
`docker-compose.yml`, `render.yaml`, `.env.example`, `package.json`.
**معدّلة:** `src/agent/{agent,tools}.ts`, `src/telegram/client.ts`,
`src/server.ts`, `src/config.ts`, `src/dashboard/index.html`.

## 3. تغييرات قاعدة البيانات (Database Changes)

مخطط SQLite **v1**: users, customers, admins, categories, services, bookings,
orders, payments, conversations, messages, support_tickets, notifications,
audit_logs, metric_events (+schema_migrations). الترحيل تلقائي عند الإقلاع.
أبرز القيود: منع الحجز المزدوج بفهرس فريد جزئي على
`(slot_date, slot_time) WHERE status IN ('PENDING','CONFIRMED')`، مفاتيح
ثبات على bookings/orders، `messages.external_id UNIQUE` لمنع تكرار الويب هوك.
استيراد JSON القديم idempotent عبر `DB_IMPORT_LEGACY`.

## 4. متغيرات البيئة (Environment Variables — الجديدة)

`DB_PATH`, `DB_IMPORT_LEGACY`, `ADMIN_TELEGRAM_IDS`, `NOTIFICATIONS_ENABLED`,
`NOTIFICATIONS_WORKER_INTERVAL_MS`, `NOTIFICATIONS_MAX_ATTEMPTS`,
`BOOKING_REMINDER_HOURS`, `TELEGRAM_WEBHOOK_SECRET` (يُتحقق منه الآن من ترويسة
`X-Telegram-Bot-Api-Secret-Token` بمقارنة زمنية ثابتة). كامل القائمة في
`.env.example`. لا أسرار ولا أسعار في الكود.

## 5. المراجعة الأمنية (Security Review)

- Webhooks: HMAC-SHA256 على الجسم الخام (واتساب) + secret_token (تيليجرام،
  **أُصلح** لقراءة الترويسة الصحيحة + مقارنة ثابتة الزمن)؛ فحص يدوي: 401 بلا/خطأ
  السر، 200 بالسر الصحيح أو query المتوافق.
- RBAC صريح default-deny لأربعة أدوار، مغطى باختبارات ومحقق عبر تيليجرام
  (غريب يضغط زر الإدارة يرجع "⛔ للموظفين فقط").
- Prompt Injection: تعليمات نظام صارمة + قائمة أدوات ثابتة + رفض وتدقيق أي
  أداة غير مسجّلة + العمليات الحساسة في الطبقة الموثوقة مع تحقق وملكية وتدقيق.
- Rate limiter لكل محادثة، حد حجم جسم 8MB، كلمة مرور لوحة + كوكي HttpOnly،
  نقطة المحاكاة مقفلة خارج التجربة.

## 6. الاختبارات المُنفّذة (Tests Performed)

- `npm test` — **30/30 ناجح**: الحجوزات (ازدواج/idempotency/ملكية/دورة حياة/
  تذكيرات)، الأدوات (رفض غير المسجّل، تحقق فاسد، ملكية)، موجّه تيليجرام
  (مسارات أزرار كاملة، ازدواج، لغة)، RBAC (كل الأدوار).
- `npm run typecheck` — 0 أخطاء.
- `npm run test:flow` — 14/14 (عدم كسر التدفق القديم).
- دخان حي (`scripts/smoke-menu.ts` ضد خادم): حجز كامل، منع ازدواج، إلغاء،
  طلب خدمة، دعم، trespass، وطابور تنبيهات الفريق فُعِل ورُصد في السجلات.
- إقلاع نظيف: ترحيل/بذر/استيراد legacy/عامل إشعارات/صحة + CI على Node 22.

## 7. قيود معروفة (Known Limitations)

- Rate limiting في الذاكرة لكل عملية (مناسب لبوت قناة واحدة؛ يحتاج Redis عند
  التوسع الأفقي).
- SQLite على باقة Render المجانية لا يستمر عبر إعادة النشر (موثّق؛ الحل قرص/
  volume على باقة مدفوعة أو Docker volume).
- لا تكامل دفع فعّال بعد (جدول payments جاهز؛ التنفيذ خارج النطاق).
- كلمة مرور لوحة ويب واحدة (متعدد الموظفين الإداريين متاح حاليًا عبر تيليجرام).

## 8. تعليمات النشر (Deployment Instructions)

1. `cp .env.example .env` واضبط: `TELEGRAM_BOT_TOKEN`، `TELEGRAM_WEBHOOK_URL`
   (أو اتركه فارغًا للـ polling) و`TELEGRAM_WEBHOOK_SECRET`
   (`openssl rand -hex 32`)، `ADMIN_TELEGRAM_IDS`، `DASHBOARD_PASSWORD`،
   مفاتيح LLM.
2. `npm ci && npm test && DEMO_MODE=false npm start`.
3. Docker: `docker build -t mureeh-agent . && docker run -d -p 3000:3000
   --env-file .env -v mureeh-data:/app/data --name mureeh-agent mureeh-agent`
   (أو `docker compose up -d`).
4. عند الإقلاع: ترحيل تلقائي، بذر الكتالوج، استيراد لمرة واحدة من JSON،
   ضبط أوامر البوت، بدء عامل الإشعارات. النشر عبر Render من `render.yaml`
   (Node 22).

## 9. الحكم النهائي (Final Production Readiness Verdict)

**جاهز للإنتاج للإطلاق الموجّه (pilot/GA لبوت قناة واحدة):** مسار الأعمال
الحرج (كتالوج ديناميكي، حجز بمنع ازدواج حقيقي، دورة حالات خمس، تعديل/إلغاء،
تذكيرات، طلبات، تذاكر، تحويل بشري يصمت البوت، RBAC، تدقيق) مبني على قاعدة
علائقية وخدمات موثوقة، ومغطى باختبارات آلية ودخان حي وضوابط أمان متحقق منها،
بدون كسر الميزات القائمة.
**قبل إطلاق واسع متعدد النسخ:** قرص دائم مؤكّد، تقييد معدل مشترك (Redis)،
وتكامل الدفع عند الحاجة.
