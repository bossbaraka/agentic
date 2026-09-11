/**
 * هجرات قاعدة البيانات — مرقّمة وتُنفّذ كل واحدة داخل transaction.
 *
 * قواعد:
 *  - لا تُعدّل migration نُفّذت؛ أضف migration جديدًا برقم أعلى.
 *  - كل الجداول تحمل مفاتيح أجنبية، قيود CHECK، وفهارس واضحة.
 *  - الأوقات تُخزّن بالمللي ثانية (epoch) في أعمدة *_at؛
 *    مواعيد الحجز تُخزّن نصًا YYYY-MM-DD / HH:MM بمنطقة النشاط + مشتق epoch للفهرسة والتذكير.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ───────────────────────── المستخدمون والعملاء ─────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL CHECK (channel IN ('tg','wa')),
  channel_user_id TEXT NOT NULL,
  username        TEXT,
  display_name    TEXT,
  phone           TEXT,
  language        TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en','he')),
  is_blocked      INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  UNIQUE (channel, channel_user_id)
);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code            TEXT UNIQUE,
  full_name       TEXT,
  restaurant_name TEXT,
  city            TEXT,
  tables          INTEGER CHECK (tables IS NULL OR tables > 0),
  branches        INTEGER DEFAULT 1 CHECK (branches IS NULL OR branches > 0),
  preferred_plan  TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_restaurant ON customers(restaurant_name);

CREATE TABLE IF NOT EXISTS admins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     TEXT UNIQUE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username        TEXT,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'STAFF'
                  CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','STAFF')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admins_active ON admins(is_active, role);

-- ───────────────────────── كتالوج الخدمات ─────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name_ar     TEXT NOT NULL,
  name_en     TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  slug            TEXT NOT NULL UNIQUE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL DEFAULT '',
  description_ar  TEXT NOT NULL DEFAULT '',
  description_en  TEXT NOT NULL DEFAULT '',
  price           REAL CHECK (price IS NULL OR price >= 0),
  currency        TEXT NOT NULL DEFAULT 'ILS',
  billing_period  TEXT CHECK (billing_period IS NULL OR billing_period IN ('once','monthly','yearly','hourly')),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  availability_text TEXT NOT NULL DEFAULT '',
  is_bookable     INTEGER NOT NULL DEFAULT 1 CHECK (is_bookable IN (0,1)),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','hidden')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

-- ───────────────────────── الحجوزات ─────────────────────────

CREATE TABLE IF NOT EXISTS bookings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                TEXT NOT NULL UNIQUE,
  idempotency_key    TEXT UNIQUE,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_id         INTEGER REFERENCES services(id) ON DELETE SET NULL,
  plan_slug          TEXT,
  contact_key        TEXT NOT NULL,
  full_name          TEXT,
  slot_date          TEXT NOT NULL CHECK (slot_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  slot_time          TEXT NOT NULL CHECK (slot_time GLOB '[0-9][0-9]:[0-9][0-9]'),
  slot_epoch_ms      INTEGER NOT NULL,
  duration_minutes   INTEGER NOT NULL DEFAULT 60,
  status             TEXT NOT NULL DEFAULT 'CONFIRMED'
                     CHECK (status IN ('PENDING','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
  notes              TEXT,
  cancellation_reason TEXT,
  reminded_hours     TEXT NOT NULL DEFAULT '',
  created_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
-- ★ منع Double Booking على مستوى التخزين نفسه (السعة الافتراضية 1 موعد/فتحة)
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active_slot
  ON bookings(slot_date, slot_time)
  WHERE status IN ('PENDING','CONFIRMED');
CREATE INDEX IF NOT EXISTS idx_bookings_contact ON bookings(contact_key, status);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_epoch_ms, status);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, slot_date);

-- ───────────────────────── الطلبات والمدفوعات ─────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'launch'
                CHECK (kind IN ('launch','service_inquiry','custom')),
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
  contact_key   TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  total_amount  REAL,
  currency      TEXT NOT NULL DEFAULT 'ILS',
  payload       TEXT NOT NULL DEFAULT '{}',
  assigned_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_key, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'manual',
  provider_ref  TEXT UNIQUE,
  amount        REAL NOT NULL CHECK (amount >= 0),
  currency      TEXT NOT NULL DEFAULT 'ILS',
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED','CANCELLED')),
  raw           TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ───────────────────────── المحادثات والرسائل ─────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('tg','wa')),
  contact_key     TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'bot' CHECK (state IN ('bot','human','paused')),
  summary         TEXT NOT NULL DEFAULT '',
  handoff_reason  TEXT,
  assigned_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  last_outbound_at INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(state, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id     TEXT UNIQUE,
  dir             TEXT NOT NULL CHECK (dir IN ('in','out','system')),
  type            TEXT NOT NULL DEFAULT 'text',
  body            TEXT NOT NULL DEFAULT '',
  caption         TEXT,
  tool            TEXT,
  meta            TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- ───────────────────────── تذاكر الدعم ─────────────────────────

CREATE TABLE IF NOT EXISTS support_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  contact_key     TEXT NOT NULL,
  restaurant_name TEXT,
  plan            TEXT,
  issue           TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  assigned_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  resolution      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status, priority);
CREATE INDEX IF NOT EXISTS idx_tickets_contact ON support_tickets(contact_key, status);

-- ───────────────────────── طابور الإشعارات ─────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,           -- staff_alert | customer_message | booking_reminder | ...
  channel       TEXT,                    -- tg | wa | null (أي قناة متاحة)
  target_key    TEXT,                    -- مفتاح العميل/الموظف
  subject       TEXT NOT NULL DEFAULT '',-- ملخص قصير للسجل
  payload       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_at        INTEGER NOT NULL,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, run_at);
CREATE INDEX IF NOT EXISTS idx_notifications_kind ON notifications(kind, status);

-- ───────────────────────── سجل التدقيق والقياسات ─────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type  TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('customer','admin','system','llm')),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id);

CREATE TABLE IF NOT EXISTS metric_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  ref_key     TEXT,
  value       REAL NOT NULL DEFAULT 1,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_type_time ON metric_events(type, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'customer_agent_state',
    sql: `
-- حالة الوكيل الدائمة لكل عميل (مرحلة البيع، نقاط الجودة، آخر نية،
-- والحالة الكاملة JSON: ألم، اعتراضات، آخر عرض...). أعمدة إضافية فقط —
-- لا تكسر أي مستهلك قائم، والقيم كلها nullable.
ALTER TABLE customers ADD COLUMN sales_stage TEXT;
ALTER TABLE customers ADD COLUMN lead_score INTEGER;
ALTER TABLE customers ADD COLUMN last_intent TEXT;
ALTER TABLE customers ADD COLUMN agent_state TEXT;
CREATE INDEX IF NOT EXISTS idx_customers_lead_score ON customers(lead_score);
`,
  },
];
