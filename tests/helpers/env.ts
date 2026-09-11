/**
 * تجهيز بيئة الاختبارات — يجب أن يكون أول استيراد في ملف الاختبار
 * لأن config يُقرأ مرة واحدة عند التحميل.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = process.env.DB_PATH ?? path.join(os.tmpdir(), `mureeh-test-${process.pid}-${Date.now()}.db`);
process.env.DEMO_MODE = 'true';
process.env.DB_PATH = dbPath;
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mureeh-data-'));
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* تجاهل */ }
}

export const TEST_DB_PATH = dbPath;
