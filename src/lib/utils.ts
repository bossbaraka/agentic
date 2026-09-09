/** أدوات مساعدة عامة: نوم، إعادة محاولة، تقسيم نص، معرّفات */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** إعادة محاولة مع تراجع أُسّي (exponential backoff) */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 600;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (!retryable || attempt === retries) break;
      const delay = base * 2 ** attempt + Math.floor(Math.random() * 150);
      log.warn(`${opts.label ?? 'عملية'} فشلت (محاولة ${attempt + 1}/${retries + 1}) — إعادة بعد ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * تقسيم نص طويل إلى أجزاء لا تتجاوز حداً معيناً،
 * مع احترام نهايات الجمل والأسطر قدر الإمكان.
 * مهم لأن حد رسالة واتساب الواحدة = 4096 حرفًا،
 * والرسائل القصيرة المتعددة أفضل تجربة من جدار نص واحد.
 */
export function splitText(text: string, max = 900): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const out: string[] = [];
  let buf = '';

  // نقسّم أولًا على الأسطر، ثم على الجمل إذا لزم
  const blocks = clean.split('\n');

  for (const block of blocks) {
    const line = block.trimEnd();

    if (!line) {
      if (buf) buf += '\n';
      continue;
    }

    if ((buf + (buf ? '\n' : '') + line).length <= max) {
      buf += (buf ? '\n' : '') + line;
      continue;
    }

    // السطر وحده يتجاوز الحد → قصّه على حدود الجمل
    if (line.length > max) {
      if (buf) { out.push(buf); buf = ''; }
      const sentences = line.match(/[^.!?؟。]+\s*[.!?؟。]?/g) ?? [line];
      let piece = '';
      for (const s of sentences) {
        if ((piece + s).length <= max) {
          piece += s;
        } else {
          if (piece) out.push(piece.trim());
          piece = s.length > max ? hardCut(s, max) : s;
          if (piece.length > max) { out.push(piece.trim()); piece = ''; }
        }
      }
      buf = piece.trim();
      continue;
    }

    out.push(buf);
    buf = line;
  }

  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function hardCut(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice) + '…';
}

/** إزالة محارف تحكم غير مرئية قد تكسر JSON */
export function sanitizeForJson(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * استخراج أول كائن JSON من نص قد يحتوي على شرح قبل/بعد JSON.
 * يتجاهل أسوار ```json الشائعة.
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;
  let t = text.trim();

  // إزالة أسوار الكود
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // محاولة مباشرة
  try { return JSON.parse(t); } catch { /* نتابع */ }

  // أول { إلى آخر }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch { /* نتابع */ }
  }

  // أول [ إلى آخر ]
  const fa = t.indexOf('[');
  const la = t.lastIndexOf(']');
  if (fa !== -1 && la > fa) {
    try { return JSON.parse(t.slice(fa, la + 1)); } catch { /* نتابع */ }
  }

  return null;
}

/** توليد معرّف قصير فريد */
export function uid(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** اقتطاع نص للسجلات */
export function truncate(s: string, n = 80): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n) + '…';
}

/** تنسيق مدة مقروءة */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** تاريخ/وقت بالعربية (منطقة زمنية قابلة للضبط) */
export function nowHuman(tz = 'Asia/Jerusalem'): string {
  try {
    return new Intl.DateTimeFormat('ar', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

// ─────────────────────────── مسجّل الأحداث ───────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.blue}ℹ${COLORS.reset} ${msg}`, ...rest),
  ok: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.green}✔${COLORS.reset} ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) =>
    console.warn(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.yellow}⚠${COLORS.reset} ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) =>
    console.error(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.red}✖${COLORS.reset} ${msg}`, ...rest),
  wa: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.green}🟢 واتساب${COLORS.reset} ${msg}`, ...rest),
  ai: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.magenta}🤖 ذكاء${COLORS.reset} ${msg}`, ...rest),
  tool: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.cyan}🔧 أداة${COLORS.reset} ${msg}`, ...rest),
  http: (msg: string, ...rest: unknown[]) =>
    console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${COLORS.dim}🌐 ${msg}${COLORS.reset}`, ...rest),
  raw: (msg: string) => console.log(msg),
};
