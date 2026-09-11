/**
 * سياسة الاستجابة — تحقق حتمي نهائي قبل وصول أي رسالة للعميل.
 *
 * شبكة أمان مستقلة عن النموذج تلتقط الأخطاء عالية الأثر:
 *   1. حارس الأسعار: كل رقم يُعرض كسعر شهري يجب أن يأتي من plans.ts
 *      أو من حسبة مشتقة مسموحة (قسط الطاولة/الفرع). الانتهاك يُسجَّل
 *      ويُصحَّح حيث يمكن تحديده بدقة (رقم باقة معروفة).
 *   2. حارس CTA: منع إلحاح التفعيل — لا نفس دعوة الاشتراك في ردين
 *      متتاليين، ولا دعوة بيع في رسالة دعم/شكوى.
 *   3. حارس تسرب الاستدلال الداخلي (طبقات تحليل/وسوم المرحلة).
 *
 * كل فحص يعيد تقريرًا — لا يُرمى خطأ أبدًا، والتعديل محافظ (لا يعيد
 * صياغة كلام سليم).
 */
import { MUREEH_PLANS, perTableMonthly } from './plans.js';
import { log } from '../lib/utils.js';
import { normalize } from './intelligence/intent.js';

export interface PolicyFinding {
  kind: 'price_violation' | 'cta_repeat' | 'premature_cta' | 'reasoning_leak';
  /** وصف للسجلات/المقاييس */
  detail: string;
  /** هل تم إصلاح تلقائي؟ */
  repaired: boolean;
}

export interface PolicyReport {
  parts: string[];
  findings: PolicyFinding[];
}

// ─────────────────────────── حارس الأسعار ───────────────────────────

const OFFICIAL_MONTHLY = new Set(MUREEH_PLANS.map((p) => p.priceMonthly));
const OFFICIAL_YEARLY = new Set(MUREEH_PLANS.map((p) => p.priceYearly));
const OFFICIAL_PER_MONTH_EQUIV = new Set(MUREEH_PLANS.map((p) => p.priceYearlyPerMonth));
const OFFICIAL_SAVINGS = new Set(MUREEH_PLANS.map((p) => p.yearlySavings));

/** كل أقساط الطاولة الممكنة 300/550/850 ÷ (1..300) — مضبوطة بالتقريب */
const PER_TABLE_ALLOWED = (() => {
  const s = new Set<number>();
  for (const p of MUREEH_PLANS) {
    for (let t = 1; t <= 300; t++) s.add(perTableMonthly(p, t));
  }
  return s;
})();

const PLAN_NAME_TO_MONTHLY: { re: RegExp; price: number }[] = [
  { re: /احترافية|احترافيه|pro\b/i, price: 550 },
  { re: /أساسية|اساسية|أساسيه|starter/i, price: 300 },
  { re: /مؤسسات|المؤسسات|enterprise/i, price: 850 },
];

/** أرقام يُسمح بها بجانب «₪» أو «شيكل» عمومًا (سنوي/توفير/مكافئ شهري) */
function isOfficialCurrencyNumber(n: number): boolean {
  return (
    OFFICIAL_MONTHLY.has(n) ||
    OFFICIAL_YEARLY.has(n) ||
    OFFICIAL_PER_MONTH_EQUIV.has(n) ||
    OFFICIAL_SAVINGS.has(n) ||
    PER_TABLE_ALLOWED.has(n)
  );
}

/**
 * فحص أرقام العملة في نص الرد. القاعدة: أي «X₪/شهر» (تأكيد سعر شهري)
 * يجب أن يكون سعرًا رسميًا أو قسطًا محسوبًا. إن ذُكر اسم باقة مع رقم
 * خاطئ → تصحيح مباشر للرقم. غير ذلك → تسجيل فقط (بدون تحريف محتوى).
 */
export function checkPrices(parts: string[]): { parts: string[]; findings: PolicyFinding[] } {
  const findings: PolicyFinding[] = [];
  const out = parts.map((part) => {
    // نمط سعر شهري صريح: «550 ₪/شهر» أو «550₪ شهريا»
    return part.replace(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:₪|شيكل|شكل)(?:\s*)?(?:\/\s*شهر|\/شهر|شهريا|شهريًا|في الشهر)/g, (full, numStr: string) => {
      const n = Number(String(numStr).replace(',', ''));
      if (!Number.isFinite(n)) return full;
      if (isOfficialCurrencyNumber(n)) return full;
      // رقم غير رسمي كسعر شهري — نحاول تحديد الباقة من نفس الجزء
      const idx = part.indexOf(full);
      const window = part.slice(Math.max(0, idx - 120), idx + 120);
      for (const { re, price } of PLAN_NAME_TO_MONTHLY) {
        if (re.test(window)) {
          findings.push({ kind: 'price_violation', detail: `سعر شهري غير رسمي (${n}) قرب اسم باقة — صُحّح إلى ${price}`, repaired: true });
          return full.replace(String(numStr), String(price));
        }
      }
      findings.push({ kind: 'price_violation', detail: `رقم عملة غير معتمد ظهر كسعر شهري: ${n} (بدون اسم باقة — سُجل فقط)`, repaired: false });
      return full;
    });
  });
  return { parts: out, findings };
}

// ─────────────────────────── حارس CTA ───────────────────────────

/** أنماط CTA — بصلامط مطبَّع (ا لا أ — ه لا ة)، وتُختبر على نص مطبَّع دائمًا */
const CTA_PATTERNS: RegExp[] = [
  /تبين?ي اجهز لك التفعيل|تحب اجهز لك التفعيل|اج?:هز لك التفعيل|جهز لك التفعيل\?/i,
  /ابدا التفعيل|نبدا التفعيل/i,
  /هل تريد الاشتراك|هل تبغى اشتراك|تبي تشترك|تحب تشترك|تحب نثبت|نثبت على/i,
  /جاهز نبدا|يلا نبدا|خلنا نجهزها/i,
];

function containsCta(text: string): boolean {
  const t = normalize(text);
  return CTA_PATTERNS.some((p) => p.test(t));
}

/** استخراج الجملة الأخيرة (سؤال/CTA) من نص */
function lastSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/([^\n؟?!.]+[؟?!.]*)\s*$/);
  return (m?.[1] ?? t).trim();
}

/**
 * منع الإلحاح:
 *  1. دعم/شكوى → أي دعوة بيع تُحذف فورًا (بلا شروط).
 *  2. تكرار نفس الدعوة من الرد السابق مع بلا نية شراء → تُحذف الجملة الختامية.
 * نية شراء صريحة تُبقي الدعوة (العميل لم يجب بعد) — مرة واحدة.
 */
export function checkCtaRepeat(
  parts: string[],
  previousOutboundText: string | undefined,
  opts: { purchaseIntent: boolean; supportMode: boolean; intentUnclear: boolean },
): { parts: string[]; findings: PolicyFinding[] } {
  const findings: PolicyFinding[] = [];
  const lastIdx = parts.length - 1;
  const lastPart = parts[lastIdx] ?? '';
  if (!containsCta(lastPart)) return { parts, findings };

  const stripLastCta = (reason: PolicyFinding): { parts: string[]; findings: PolicyFinding[] } => {
    const stripped = stripTrailingCta(lastPart);
    if (stripped === lastPart) {
      findings.push({ ...reason, repaired: false, detail: `${reason.detail} — لم يمكن حذفه آمنًا، سُجل فقط` });
      return { parts, findings };
    }
    findings.push(reason);
    const out = [...parts];
    if (stripped.trim()) out[lastIdx] = stripped;
    else out.splice(lastIdx, 1);
    return { parts: out.filter((p) => p.trim().length > 0), findings };
  };

  // 1) دعم/شكوى: البيع ممنوع قطعًا — بلا أي شرط آخر
  if (opts.supportMode) {
    return stripLastCta({ kind: 'premature_cta', detail: 'دعوة بيع في رسالة دعم/شكوى', repaired: true });
  }

  // نية شراء صريحة؟ إذًا التكرار منطقي (العميل لم يجب بعد) — نسمح مرة
  if (opts.purchaseIntent || !previousOutboundText) return { parts, findings };

  // 2) نفس دعوة الرد السابق تقريبًا → حذف جملة الدعوة الأخيرة
  const prevHadCta = containsCta(previousOutboundText);
  if (!prevHadCta) return { parts, findings };

  const prevCtaSentence = lastSentence(previousOutboundText);
  const curCtaSentence = lastSentence(lastPart);
  const similar =
    similarity(prevCtaSentence, curCtaSentence) > 0.5 ||
    CTA_PATTERNS.some((p) => p.test(normalize(prevCtaSentence)) && p.test(normalize(curCtaSentence)));

  if (similar) {
    return stripLastCta({ kind: 'cta_repeat', detail: `تكرار دعوة تفعيل من الرد السابق («${curCtaSentence.slice(0, 60)}»)`, repaired: true });
  }

  return { parts, findings };
}

/** حذف جملة CTA الختامية من نص (آخر سؤال/أمر بيعي) */
export function stripTrailingCta(text: string): string {
  let t = text.trim();
  // حتى جملتين ختاميتين بيعيتين متتاليتين
  for (let i = 0; i < 2; i++) {
    const m = t.match(/([^\n.!?؟]*[.!?؟])\s*$/);
    if (!m) break;
    const sentence = m[1]!.trim();
    if (!CTA_PATTERNS.some((p) => p.test(normalize(sentence)))) break;
    t = t.slice(0, t.length - m[0].length).trim();
  }
  return t;
}

/** تشابه بسيط بالثنائيات الحرفية — كافٍ لكشف إعادة الصياغة القريبة */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bi = (s: string) => {
    const set = new Set<string>();
    const words = s.split(' ');
    for (let i = 0; i < words.length - 1; i++) set.add(words[i]! + ' ' + words[i + 1]!);
    return set;
  };
  const sx = bi(x), sy = bi(y);
  let inter = 0;
  for (const v of sx) if (sy.has(v)) inter++;
  const union = new Set([...sx, ...sy]).size || 1;
  return inter / union;
}

// ─────────────────────── حارس تسرب الاستدلال ───────────────────────

const LEAK_PATTERNS: RegExp[] = [
  /^\s*(?:تحليل داخلي|استدلال|تفكيري|نيّة مرصودة|نية مرصودة|المرحلة:|Stage:|Intent:|intent detected|deterministic)/gim,
  /\[[^\]\n]{0,80}(?:دليل بيعي|تنبيه ذاكرة|حارس متابعة|سياسة المرحلة)[^\]\n]*\]/g,
];

export function checkReasoningLeak(parts: string[]): { parts: string[]; findings: PolicyFinding[] } {
  const findings: PolicyFinding[] = [];
  const out = parts.map((p) => {
    let t = p;
    for (const re of LEAK_PATTERNS) {
      t = t.replace(re, '');
    }
    if (t !== p) findings.push({ kind: 'reasoning_leak', detail: 'تسرب استدلال داخلي — نُظّف', repaired: true });
    return t.trim();
  });
  return { parts: out.filter((p) => p.length > 0), findings };
}

// ─────────────────────────── التطبيق الكامل ───────────────────────────

export interface PolicyInput {
  parts: string[];
  previousOutboundText?: string;
  purchaseIntent: boolean;
  supportMode: boolean;
  intentUnclear: boolean;
  /** مصدر الرد — لا نطبق حارس الأسعار على المحرك الوهمي المحلي (أرقامه من plans.ts أصلًا) */
  engine: string;
  sessionKey: string;
}

/**
 * تطبيق كل الفحوصات على أجزاء الرد. يعيد الأجزاء النهائية + التقارير
 * (تُستخدم للمقاييس والسجلات).
 */
export function applyResponsePolicy(input: PolicyInput): PolicyReport {
  let parts = [...input.parts];
  const findings: PolicyFinding[] = [];

  if (parts.length === 0) return { parts, findings };

  const price = checkPrices(parts);
  parts = price.parts;
  findings.push(...price.findings);

  const cta = checkCtaRepeat(parts, input.previousOutboundText, {
    purchaseIntent: input.purchaseIntent,
    supportMode: input.supportMode,
    intentUnclear: input.intentUnclear,
  });
  parts = cta.parts;
  findings.push(...cta.findings);

  const leak = checkReasoningLeak(parts);
  parts = leak.parts;
  findings.push(...leak.findings);

  for (const f of findings) {
    const tag = f.repaired ? '🛡️ أُصلح' : '⚠️ مُسجل';
    log.info(`${tag} [سياسة الاستجابة] (${input.sessionKey}) ${f.kind}: ${f.detail}`);
  }

  return { parts, findings };
}
