# خطة قاعدة البيانات — MUREEH Agent (SQLite)

> كُتبت قبل التنفيذ، ووُثّقت المطابقة النهائية لكل عنصر. المصدر: `src/db/migrations.ts`.

## 1. الاختيار التقني وسببه

- **SQLite عبر `node:sqlite` المدمج في Node 22.5+** — صفر اعتماديات قاعدة بيانات خارجية،
  ملف واحد على volume دائم، معاملات فعلية (`BEGIN IMMEDIATE`)، ودعم قيود UNIQUE الجزئية.
- الوصول عبر مستودعات رفيعة (`src/db/repos/*`) لا يستدعيها أحد غير طبقة الخدمات.
- المخطط يُدار بـ **migrations مرقّمة** في جدول `schema_migrations`، تُطبَّق تلقائيًا عند
  أول فتح للقاعدة (`openDb()` في مسار إقلاع الخادم).

## 2. الجداول (14 جدول أعمال)

| الجدول | الدور | مفاتيح/قيود مهمة |
|---|---|---|
| `users` | كل هوية قناة (tg/wa) | `UNIQUE(channel, channel_user_id)`، لغة، username، هاتف |
| `customers` | ملف النشاط التجاري | FK→users (1:1)، اسم المطعم، المدينة، الطاولات، الفروع، الباقة المفضلة |
| `admins` | الموظفون وRBAC | `telegram_id UNIQUE`، `role` ∈ SUPER_ADMIN/ADMIN/MANAGER/STAFF، `is_active`، `created_by` |
| `categories` | فئات الكتالوج | `slug UNIQUE`، ترتيب، حالتا الاسم ar/en |
| `services` | الكتالوج الديناميكي | `slug UNIQUE`، FK→category، سعر/مدة/حالة/نوع حجز/metadata JSON |
| `bookings` | الحجوزات | `ref UNIQUE` (BKG-XXXXXX)، `idempotency_key UNIQUE`، **منع الازدواج (أدناه)**، حالات خمس |
| `orders` | طلبات الإطلاق/الخدمات | `ref UNIQUE`، `idempotency_key UNIQUE`، FK→service، نوع، مبلغ، payload JSON |
| `payments` | محاولات/سجلات الدفع | FK→order، مبلغ، عملة، مزوّد، حالة، مرجع خارجي |
| `conversations` | محادثة لكل مستخدم | FK→user، الحالة (bot/human/paused)، الموظف المسند، ملخص |
| `messages` | كل الرسائل | FK→conversation، `external_id UNIQUE` (منع تكرار webhook/polling)، نوع/نص/وسيط |
| `support_tickets` | تذاكر الدعم | `ref UNIQUE`، أولوية، حالة (OPEN/IN_PROGRESS/RESOLVED/CLOSED) |
| `notifications` | طابور الإشعارات | الحالة PENDING/PROCESSING/SENT/FAILED/CANCELLED، `run_at`، محاولات، خطأ، payload JSON |
| `audit_logs` | تدقيق كل العمليات الحساسة | الفاعل (admin/customer/system/tool)، الفعل، الكيان، معرّفه، payload |
| `metric_events` | مقاييس الأحداث | الاسم، ref_key، قيمة رقمية، طابع زمني |

## 3. منع الحجز المزدوج (القيد الحرج)

دفاعان متتاليان (لا يكفي أحدهما):

1. **قيد فريد جزئي على مستوى التخزين:**

```sql
CREATE UNIQUE INDEX ux_bookings_active_slot
ON bookings(slot_date, slot_time)
WHERE status IN ('PENDING','CONFIRMED');
```

2. **عدّاد سعة داخل معاملة `BEGIN IMMEDIATE`** في `createBooking`
   (`src/db/repos/bookings.ts`) يسبق الإدراج ويرمي خطأ `conflict`؛ المعاملة تقفل
   الكتابة فلا يمكن لطلبين متسابقين حجز نفس الفتحة حتى تحت التزامن.

عند الإلغاء/التعديل: يتحرر القيد تلقائيًا (شرط الحالات النشطة)، والتذكيرات القديمة
تُلغى عبر `notifications.cancelTargeted(...)`.

## 4. حالات الحجز وخريطة الانتقالات

`PENDING → CONFIRMED → COMPLETED`، ومع `CANCELLED` و`NO_SHOW`. خريطة الانتقالات
المسموحة مُفرضة في `updateStatus()` (مستودع) ومكررة في `bookingService`/`adminService`؛
أي انتقال غير مشروع يُرفض قبل الكتابة، مع `cancellation_reason`.

## 5. التوقيت (DST-aware)

- التخزيم البشري: `slot_date` (YYYY-MM-DD) + `slot_time` (HH:MM) بمنطقة
  `config.booking.TIMEZONE` (افتراضي Asia/Jerusalem).
- مشتقّ آلي: `slot_epoch_ms` يُحسب عبر `Intl.DateTimeFormat` لتفادي أخطاء التوقيت
  الصيفي/الشتوي، وتستخدمه التذكيرات.
- كل الجداول بطوابع `created_at/updated_at` بـ epoch milliseconds.
- التذكيرات: `reminded_hours` CSV (مثل `|24||1|`) يمنع إرسال نفس تذكير الساعة مرتين.

## 6. الفهارس (23 فهرسًا)

أمثلة على الفهارس الانتقائية: حجوزات حسب جهة الاتصال/التاريخ/الحالة، الطلبات حسب
المفتاح، الرسائل حسب المحادثة والزمن، التذاكر المفتوحة، الإشعارات المستحقة
(`WHERE status='PENDING' AND run_at <= ?`)، أحداث التدقيق حسب الفاعل/الزمن.

## 7. الكاتالوج الديناميكي

- الفئات والخدمات تُزرع من مصادر الحقيقة الوحيدة: خطط الاشتراك من `agent/plans.ts`
  (الأسعار 300/550/850 لا تظهر إلا هناك)، الخدمات الرقمية الست من بذر الكتالوج
  (`src/db/seed.ts`)، والبذر **idempotent** (لا يكرر ولا يمسح تعديلات الموظفين).
- الواجهة والأدوات تقرأ فقط عبر `catalogService` (مع تخزين مؤقت قصير يُبطَل عند
  تفعيل/إيقاف خدمة من لوحة الموظف).

## 8. الترحيل من JSON القديم

`src/db/legacyImport.ts` (متحكم به `DB_IMPORT_LEGACY=true`):
- يستورد المستخدمين/المحادثات/الرسائل/ملفات العملاء وطلبات الإطلاق المؤكدة.
- **idempotent**: الرسائل تأخذ `external_id = legacy:<id>`، والطلبات
  `idempotency_key = legacy-launch:<key>` — إعادة التشغيل آمنة.
- دفاعي تمامًا: ملف مفقود/تالف يُسجّل تحذيرًا ولا يوقف الإقلاع.
- مخزن JSON يبقى يعمل كذاكرة محادثة حيّة بجانب DB (جسر مزامنة في
  `services/conversationBridge.ts`) — لا كسر للميزات القائمة.

## 9. الصحة والنسخ الاحتياطي

- `/health` يعرض `database: { ok, file, version }` وعمق طابور الإشعارات.
- النسخ الاحتياطي = نسخة ملف SQLite (أو `VACUUM INTO`)؛ على Docker اربط volume،
  وعلى Render باقة مجانية بلا قرص دائم (موثّق في `render.yaml`).
