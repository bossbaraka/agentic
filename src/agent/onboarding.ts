/**
 * مسار التجهيز للإطلاق (Onboarding → Launch).
 *
 * عندما يحسم العميل قرار الاشتراك، يجمع البوت تفاصيل مطعمه خطوة بخطوة،
 * ثم يبني «تصور إطلاق» كاملًا ويعرضه للتأكيد، وبعد موافقة صريحة يُرسَل
 * الملف الكامل لمدير المنصة (WHATSAPP_MANAGER_NUMBER) وتُحوَّل المحادثة إليه.
 *
 * كل الأرقام هنا تُقرأ من plans.ts حصرًا — لا تخمين ولا أسعار خارجية.
 */

import type { LaunchProfile } from '../types.js';
import { getPlan, perTableMonthly, type MureehPlan, type PlanId } from './plans.js';

/** ملف مطعم جاهز للتصور/الطلب — لا خانة فارغة تُخمَّن، تُعرض شرطة */
export type { LaunchProfile };

/** الباقة الافتراضية عند غياب الاختيار — الاحترافية (الأكثر طلبًا) */
const DEFAULT_PLAN: PlanId = 'pro';

/**
 * استخراج معرّف الباقة من نص عربي حر (اسم الباقة أو سعرها أو معرّفها).
 * ترتيب الفحص مهم: الأسماء الأطول أولًا حتى لا تلتهم أسماء مشابهة.
 */
export function planIdFromText(text: string | null | undefined): PlanId | null {
  const t = (text ?? '').toLowerCase();
  if (!t) return null;
  if (/مؤسسات|سلاسل|سلسلة|فروع متعددة|multi.?branch|enterprise|799/.test(t)) return 'enterprise';
  if (/احتراف|pro\b|299/.test(t)) return 'pro';
  if (/أساسية|اساسية|starter|149/.test(t)) return 'starter';
  return null;
}

/** اسم الباقة بالعربية كما يراها العميل */
export function planNameOf(id: PlanId | string | undefined): string {
  return getPlan(planIdFromText(String(id ?? '')) ?? DEFAULT_PLAN).name;
}

/** توحيد الملف قبل بناء أي نص — تنظيف نصي بسيط وتثبيت الافتراضيات */
export function normalizeProfile(p: Partial<LaunchProfile>): LaunchProfile {
  const clean = (v: unknown): string | undefined => {
    const s = String(v ?? '').trim();
    return s && s !== 'undefined' && s !== 'null' ? s : undefined;
  };
  const plan: PlanId = planIdFromText(String(p.preferred_plan ?? '')) ?? DEFAULT_PLAN;
  return {
    full_name: clean(p.full_name),
    restaurant_name: clean(p.restaurant_name),
    city: clean(p.city),
    branches: typeof p.branches === 'number' && p.branches > 0 ? Math.round(p.branches) : 1,
    tables: typeof p.tables === 'number' && p.tables > 0 ? Math.round(p.tables) : undefined,
    preferred_plan: plan,
    whatsapp_number: clean(p.whatsapp_number),
  };
}

/**
 * «تصور الإطلاق» — النص الكامل الذي يُعرض على العميل للتأكيد.
 * يُعرض كما هو حرفيًا (ممنوع تعديله أو اختصاره في الرد).
 */
export function buildBlueprintText(rawProfile: Partial<LaunchProfile>): string {
  const p = normalizeProfile(rawProfile);
  const plan = getPlan(planIdFromText(String(p.preferred_plan ?? '')) ?? DEFAULT_PLAN);
  const perTable = p.tables ? ` (~*${perTableMonthly(plan, p.tables)} ₪* للطاولة)` : '';

  const lines: string[] = [
    `🚀 *تصور الإطلاق — ${p.restaurant_name ?? 'مطعمك'}*`,
    '',
    `👤 ${p.full_name ?? '—'} · 📍 ${p.city ?? '—'}`,
    `🍽️ ${(p.branches ?? 1) > 1 ? `${p.branches} فروع` : 'فرع واحد'} · ${p.tables ? `${p.tables} طاولة` : 'عدد الطاولات —'}`,
    `💎 *${plan.name}* — *${plan.priceMonthly} ₪/شهر*${perTable}`,
    '',
    'وش يحصل عليه مطعمك:',
    ...plan.features.map((f) => `• ${f}`),
    '',
    '⏱️ التجهيز والتفعيل خلال دقائق — وبدون بطاقة ائتمانية للبدء.',
  ];
  return lines.join('\n');
}

/**
 * ملف الطلب الكامل المُرسل لمدير المنصة بعد التأكيد.
 * رسالة داخلية للفريق — لا تُرسل للعميل أبدًا.
 */
export function managerOrderMessage(
  rawProfile: Partial<LaunchProfile>,
  orderRef: string,
  sessionKey: string,
): string {
  const p = normalizeProfile(rawProfile);
  const plan: MureehPlan = getPlan(planIdFromText(String(p.preferred_plan ?? '')) ?? DEFAULT_PLAN);
  const perTable = p.tables ? ` (~${perTableMonthly(plan, p.tables)} ₪/طاولة)` : '';

  return [
    `🚀 *طلب إطلاق مؤكد* ${orderRef}`,
    '',
    `العميل: ${p.full_name ?? '—'}`,
    `المطعم: ${p.restaurant_name ?? '—'} — ${p.city ?? '—'}`,
    `الفروع: ${p.branches ?? 1} · الطاولات: ${p.tables ?? '—'}`,
    `الباقة: *${plan.name}* — ${plan.priceMonthly} ₪/شهر${perTable}`,
    `واتساب العميل: ${p.whatsapp_number ?? sessionKey}`,
    `مفتاح الجلسة: ${sessionKey}`,
    `وقت التأكيد: ${new Date().toISOString()}`,
    '',
    'المطلوب: التواصل مع العميل مباشرة وإكمال التجهيز للإطلاق.',
  ].join('\n');
}

/** توليد مرجع طلب قصير ومقروء: ORD-XXXXXX */
export function newOrderRef(): string {
  return `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
