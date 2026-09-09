import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/utils.js';

/**
 * لوحة التحكم — تُقرأ من ملف HTML مستقل وقت التشغيل.
 *
 * لماذا ملف مستقل بدل قالب داخل TypeScript؟
 *  1. لا صراع مع backticks و ${ الخاصة بجافاسكربت اللوحة (هرَب لا ينتهي).
 *  2. تقدر تعدّل اللوحة وتنعش الصفحة فورًا بدون إعادة تشغيل الخادم.
 *  3. أي محرر يعطيك تلوين HTML/JS صحيح.
 *
 * الملف: src/dashboard/index.html
 * الرابط: http://localhost:3000/admin
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.join(here, 'index.html'),          // تشغيل عبر tsx من المصدر
  path.join(here, '..', '..', 'src', 'dashboard', 'index.html'), // تشغيل من dist
  path.join(process.cwd(), 'src', 'dashboard', 'index.html'),
];

let cached: string | null = null;
let cachedAt = 0;

/** هل نعيد القراءة من القرص؟ (يسمح بالتعديل الحي) */
const HOT_RELOAD = process.env.DASHBOARD_HOT_RELOAD !== 'false';

export function getDashboardHtml(): string {
  if (cached && HOT_RELOAD && Date.now() - cachedAt < 3000) return cached;

  for (const file of CANDIDATES) {
    try {
      if (fs.existsSync(file)) {
        const html = fs.readFileSync(file, 'utf8');
        if (html.includes('<!doctype html>') || html.includes('<!DOCTYPE html>')) {
          cached = html;
          cachedAt = Date.now();
          return html;
        }
      }
    } catch {
      /* جرّب المسار التالي */
    }
  }

  log.error('تعذّر العثور على src/dashboard/index.html — تأكد من مجلد المشروع');
  cached = FALLBACK_HTML;
  cachedAt = Date.now();
  return cached;
}

/** صفحة احتياطية لو ضاع الملف — توضح المشكلة بدل شاشة بيضاء */
const FALLBACK_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>اللوحة غير متاحة</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf3;display:grid;
place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;line-height:2}
code{background:#1b2942;padding:2px 8px;border-radius:6px;direction:ltr;display:inline-block}</style>
</head><body><div>
<h1>⚠️ ملف اللوحة مفقود</h1>
<p>لم يجد الخادم <code>src/dashboard/index.html</code>.</p>
<p>تأكد أنك تشغّل الأمر من داخل مجلد المشروع، وأن الملف موجود.</p>
<p>الخادم نفسه يعمل بشكل طبيعي — جرّب <code>/health</code>.</p>
</div></body></html>`;
