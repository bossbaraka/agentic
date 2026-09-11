# خطة معمارية — MUREEH Telegram AI Agent (Production Upgrade)

> هذه الوثيقة كُتبت **قبل كتابة أي كود** بعد فحص كامل للمستودع، ثم نُفّذت كما هي.

## 1. ما الموجود وما يُعاد استخدامه (لا يُعاد كتابته)

| المكوّن | الحالة | القرار |
|---|---|---|
| Fastify + ESM + tsx | مستقر | يبقى |
| محركا Gemini/OpenAI + حلقة Function Calling + JSON fallback + سلسلة موديلات | مستقر | يبقى، مع تمرير سياق صلاحيات جديد |
| منطق التوفر والحجوزات النقي (`src/agent/bookings.ts`) | سليم | يبقى كمنطق domain خالص، ويُنقل التخزين إلى DB |
| قناة واتساب (Cloud API + HMAC + وسائط) | موقوفة مؤقتًا لكن سليمة | **تبقى تعمل** |
| اللوحة + WebSocket | مستقرة | تبقى، وتُضاف لها مؤشرات DB ومسارات قراءة جديدة |
| نظام الشخصية/System Prompt/الحقن | متقدم جدًا | يبقى وتُضاف كتلة الأدوات الجديدة |
| مخزن الجلسات JSON | يعمل | يبقى ذاكرة محادثة حيّة، وتُنسخ البيانات الجوهرية إلى DB (مصدر الحقيقة للأعمال) |
| معدل الكبح، التجميع، منع التكرار، إعادة المحاولة | مستقرة | تبقى |

## 2. الفجوات الحرجة (لماذا التغيير)

1. **لا توجد قاعدة بيانات علائقية** — الحجوزات/الطلبات/التذاكر ملفات JSON: لا قيود مفاتيح،
   لا أمان ضد Double Booking على مستوى التخزين، لا استعلامات إدارية، لا تكامل بيانات.
2. **الخدمات ثابتة في الكود** (`plans.ts`) والمطلوب خدمات ديناميكية من قاعدة البيانات.
3. **واجهة تيليجرام نصية فقط** — لا قوائم/أزرار/صفحات/حوارات تأكيد.
4. **لا RBAC ولا إدارة موظفين** ولا أدوار.
5. حالات الحجز 3 فقط بدل 5 المطلوبة (PENDING/CONFIRMED/COMPLETED/CANCELLED/NO_SHOW).
6. لا طابور إشعارات ولا تذكيرات مواعيد.
7. الأدوات لا تملك تحققًا/تفويضًا/تدقيقًا/idempotency موحدًا.
8. لا اختبارات آلية (خاصة التزامن والاختراق).
9. لا CI/CD.

## 3. المعمارية الجديدة (Clean / Modular)

```
Telegram / WhatsApp (Channel Adapters)
        │  raw updates (webhook signature verified)
        ▼
Telegram Dispatcher ──► Menu Router (inline/reply/pagination/wizards)
        │                   └─ Admin Handler (RBAC)
        │ (النص الحر فقط)
        ▼
Agent Orchestrator (Conversation router, debounce, dedup)
        │
        ▼
LLM (Intent / NLU / FAQ / recommendation) ──► Tool Registry
        │                                       (validate → authorize → audit → execute, idempotent)
        ▼
Services (Business Logic — المصدر الوحيد للعمليات الحساسة)
  CatalogService · BookingService · OrderService · TicketService
  HandoffService · NotificationService · AdminService · MetricsService
        │
        ▼
Repositories (SQL, transactions, constraints)
        ▼
SQLite (node:sqlite, WAL) — قابل للاستبدال بـ Postgres عبر نفس واجهة المستودعات
        │
        └─► Notification Worker (queue, retries/backoff, reminders scheduler)
```

قاعدة ذهبية: **الـ LLM لا ينفّذ عملية حساسة أبدًا**؛ يقترح استدعاء أداة فقط، والأداة
تعيد التحقق + التفويض + تنفذ عبر Service داخل transaction.

## 4. قاعدة البيانات (SQLite عبر `node:sqlite` المدمج في Node 22 — صفر اعتماديات native)

الجداول: `users, customers, admins, categories, services, bookings, orders, payments,
conversations, messages, support_tickets, notifications, audit_logs, metric_events`
+ `schema_migrations`.

- FKs مفعّلة (`PRAGMA foreign_keys=ON`)، قيود CHECK، فهارس، قيود UNIQUE.
- **منع Double Booking على مستوى قاعدة البيانات**: فهرس UNIQUE جزئي على
  `(slot_date, slot_time)` للحالات PENDING/CONFIRMED (السعة الافتراضية 1)، مع
  فحص عدّاد السعة داخل `BEGIN IMMEDIATE` للسعات الأكبر.
- الرسائل `external_id UNIQUE` = طبقة منع تكرار ثانية للتحديثات المكررة.
- migrations مرقّمة داخل transaction، و seed idempotent، واستيراد لمرة واحدة من JSON القديم.
- كل التواريخ بالعرض `YYYY-MM-DD`/`HH:MM` بمنطقة `Asia/Jerusalem`، والتذكيرات تُحسب
  بفارق توقيت المنطقة الصحيح (DST-aware) وتُخزّن `run_at` بالـ epoch.

> اختيار SQLite: يلائم النشر الحالي (عملية واحدة، volume دائم في Docker/Render) ويمنع
> إدخال اعتمادية native معطّلة للبناء. المستودعات معزولة في طبقة واحدة فالترحيل إلى
> Postgres لاحقًا مسألة تبديل تنفيذ المستودعات فقط (موثّق في Known Limitations).

## 5. الأدوات (عقد موحد)

`get_services · get_service_details · check_availability · create_booking ·
update_booking · cancel_booking · get_customer_bookings · get_order_status ·
create_support_ticket · handoff_to_human` + أدوات الباقات/التجهيز القائمة.

كل أداة: `{roles, schema(validate), idempotent, audit}` — والعميل لا يصل إلا لأدوات
دور customer؛ لا يرى أدوات staff إطلاقًا (لا تُمرّر للنموذج أصلًا).

## 6. الأمان

RBAC: SUPER_ADMIN > ADMIN > MANAGER > STAFF بمصفوفة صلاحيات صريحة؛ التحقق من ملكية
الحجز/الطلب في كل أداة وكل callback؛ Admin IDs تُحقن من `ADMIN_TELEGRAM_IDS`؛ أسرار من
.env فقط؛ HMAC للواتساب و secret_token للتيليجرام؛ تعقيم المخرجات + اعتبار رسالة
المستخدم بيانات (مطَبّقان سابقًا ومغطّى باختبارات اختراق)؛ Audit لكل عملية حساسة.

## 7. الاختبارات (`node:test` + tsx)

وحدات (توفر، لغة، كتالوج) · تكامل (دورة حجز كاملة + حالات الخمس) · تزامن (سباق نفس
الموعد عبر عملاء متوازين) · تفويض (تعديل/إلغاء حجز غير مملوك) · أدوات (وسيطات غير
صالحة/أدوات ممنوعة) · حقن تعليمات · قائمة تيليجرام (ملكية + ترقيم صفحات) · طابور
الإشعارات. CI: typecheck + الاختبارات على Node 22.
