/**
 * عميل قاعدة البيانات العلائقية.
 *
 * - SQLite عبر `node:sqlite` المدمج في Node 22+ (صفر اعتماديات native).
 * - تهيئة كسولة (lazy singleton): أول نداء يفتح الملف، يُنشئ المجلد،
 *   ويُطبّق الهجرات داخل معاملات. نفس السلوك في الخادم والسكربتات والاختبارات.
 * - كل الكتابات المتعددة الأسطر تمر عبر transaction — أمان ضد Race Conditions.
 * - الواجهة هنا متعمدة رفيعة وSQL صريح؛ المستودعات هي الطبقة الوحيدة المستهلكة.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from '../config.js';
import { log } from '../lib/utils.js';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, unknown>;

let dbInstance: DatabaseSync | null = null;
let dbPathResolved = '';
let migrated = false;

/** المسار الفعلي لملف القاعدة (DB_PATH من env أو الافتراضي داخل DATA_DIR) */
export function defaultDbPath(): string {
  return config.db.PATH || path.join(config.paths.DATA_DIR, 'mureeh.sqlite');
}

/** فتح القائمة وتهييرها مرة واحدة (أو فتح ملف محدد في الاختبارات) */
export function openDb(filePath?: string, opts: { reset?: boolean } = {}): DatabaseSync {
  const target = filePath || defaultDbPath();

  if (dbInstance) {
    if (!opts.reset && target === dbPathResolved) return dbInstance;
    try { dbInstance.close(); } catch { /* تجاهل */ }
    dbInstance = null;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=8000;');
  db.exec('PRAGMA synchronous=NORMAL;');

  dbInstance = db;
  dbPathResolved = target;
  migrated = false;
  runMigrations(db);
  return db;
}

/** نسخة القائمة الحالية (تفتحها إن لزم) */
export function db(): DatabaseSync {
  if (!dbInstance) return openDb();
  return dbInstance;
}

/** هل القائمة مفتوحة فعلًا؟ (للفحص الصحي وإغلاق الاختبارات) */
export function isOpen(): boolean {
  return dbInstance !== null;
}

export function dbFile(): string {
  return dbPathResolved || defaultDbPath();
}

/** تطبيق الهجرات الناقصة — كل واحدة في transaction مستقلة */
function runMigrations(database: DatabaseSync): void {
  if (migrated) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set<number>(
    (database.prepare('SELECT version FROM schema_migrations').all() as Row[]).map((r) => Number(r.version)),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = database.prepare('BEGIN IMMEDIATE');
    try {
      tx.run();
      database.exec(m.sql);
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, Date.now());
      database.exec('COMMIT');
      log.ok(`🗄️ هجرة قاعدة البيانات ${m.version} (${m.name}) — تمت`);
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* تجاهل */ }
      throw new Error(`فشلت الهجرة ${m.version} (${m.name}): ${(err as Error).message}`);
    }
  }
  migrated = true;
}

export function migrationVersion(): number {
  const row = db().prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as Row | undefined;
  return Number(row?.v ?? 0);
}

// ───────────────────────── مساعدات الاستعلام ─────────────────────────

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
  const r = db().prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * ينفّذ كتابة داخل BEGIN IMMEDIATE ⇆ COMMIT/ROLLBACK.
 * يضمن أن فحص السعة ثم الإدخال في الحجوزات يحدثان ذريًّا (لا double-booking تحت السباق).
 */
export function transaction<T>(fn: (database: DatabaseSync) => T): T {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* تجاهل */ }
    throw err;
  }
}

/** جملة محضّرة قابلة لإعادة الاستخدام داخل transaction مخصّص */
export function prepare(sql: string): StatementSync {
  return db().prepare(sql);
}

/** تحويل JSON بأمان (مع قيمة افتراضية) */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

/** إغلاق نظيف (للاختبارات وإيقاف الخادم) */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch { /* تجاهل */ }
    try { dbInstance.close(); } catch { /* تجاهل */ }
    dbInstance = null;
    migrated = false;
  }
}

/** فحص صحّي سريع للقاعدة */
export function dbHealth(): { ok: boolean; file: string; version: number } {
  try {
    const row = get('SELECT 1 AS ok');
    return { ok: Number(row?.ok) === 1, file: dbFile(), version: migrationVersion() };
  } catch (err) {
    return { ok: false, file: dbFile(), version: 0 };
  }
}
