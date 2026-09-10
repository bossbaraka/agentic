import type { RestaurantProfile } from '../types.js';
import { getPlan, perTableMonthly, type PlanId } from './plans.js';

/**
 * مسار التجهيز للإطلاق (Onboarding):
 * جمع تفاصيل المطعم ← تصور كامل جاهز للإطلاق ← تأكيد الطلب ← تحويل لمدير المنصة.
 *
 * كل النصوص هنا حتمية (deterministic) من البيانات الرسمية — لا تخمين ولا هلوسة:
 * الأسعار من plans.ts، والتفاصيل من ملف المطعم الذي جمعه البوت.
 */

export type ProfileField =
  | 'full_name'
  | 'restaurant_name'
  | 'city'
  | 'branches'
  | 'tables'
  | 'preferred_plan'
  | 'menu_items'
  | 'has_logo';

/** الحقول الأساسية التي لا يكتمل التصور بدونها — بالترتيب المنطقي للسؤال */
export const REQUIRED_FIELDS: ProfileField[] = [
  'full_name',
  'restaurant_name',
  'city',
  'tables',
  'preferred_plan',
];

/** السؤال البشري المقترح لكل حقل (سؤال واحد فقط في كل رد) */
export const FIELD_QUESTIONS: Record<ProfileField, string> = {
  full_name: 'شو اسمك؟',
  restaurant_name: 'واسم المطعم؟',
  city: 'بأي مدينة المطعم؟',
  branches: 'كم فرع عندك؟ (لو فرع واحد اكتب 1)',
  tables: 'كم طاولة تشتغل عندك؟',
  preferred_plan: 'أي باقة نثبت عليها: الأساسية، الاحترافية، ولا المؤسسات؟',
  menu_items: 'تقريبًا كم صنف في المنيو؟ (رقم تقريبي يكفي)',
  has_logo: 'الشعار والألوان جاهزين عندك؟ (نعم/لا — ولو لا نجهز لك هوية من عندنا)',
};

/** الحقول الأساسية الناقصة من الملف */
export function missingRequired(profile: RestaurantProfile): ProfileField[] {
  const miss: ProfileField[] = [];
  if (!profile.full_name?.trim()) miss.push('full_name');
  if (!profile.restaurant_name?.trim()) miss.push('restaurant_name');
  if (!profile.city?.trim()) miss.push('city');
  if (!profile.tables || profile.tables <= 0) miss.push('tables');
  if (!profile.preferred_plan) miss.push('preferred_plan');
  return miss;
}

/** هل الملف جاهز لبناء التصور؟ */
export function isProfileReady(profile: RestaurantProfile): boolean {
  return missingRequired(profile).length === 0;
}

/** أول سؤال ناقص (يوجه النموذج لأهم خطوة تالية) */
export function nextQuestion(profile: RestaurantProfile): string | null {
  const miss = missingRequired(profile);
  if (miss.length === 0) return null;
  return FIELD_QUESTIONS[miss[0]!];
}

const PLAN_AR: Record<PlanId, string> = {
  starter: 'الأساسية',
  pro: 'الاحترافية',
  enterprise: 'المؤسسات',
};

/**
 * بناء «التصور الكامل الجاهز للإطلاق» — نص يُعرض على العميل للمراجعة
 * قبل التأكيد. كل الأرقام من البيانات الرسمية.
 */
export function buildBlueprintText(profile: RestaurantProfile): string {
  const plan = getPlan((profile.preferred_plan ?? 'pro') as PlanId);
  const tables = profile.tables ?? 0;
  const branches = profile.branches && profile.branches > 0 ? profile.branches : 1;
  const perTable = tables > 0 ? ` (~*${perTableMonthly(plan, tables)} ₪* للطاولة)` : '';

  const setup: string[] = [
    `• بطاقات QR أنيقة لكل طاولة${tables > 0 ? ` (${tables} بطاقة)` : ''}`,
    `• المنيو الرقمي بالصور + كاشير وتصفية فواتير`,
  ];
  if (plan.id === 'pro' || plan.id === 'enterprise') {
    setup.push('• شاشة المطبخ الحية KDS بتنبيهات صوتية + نقطة بيع POS');
    setup.push('• تحليلات المبيعات + الهوية البصرية (شعارك وألوانك)');
  }
  if (plan.id === 'enterprise') {
    setup.push(`• إدارة ${branches > 1 ? `${branches} فروع` : 'الفروع'} + نطاق خاص + مدير حساب`);
  }
  if (!profile.has_logo && (plan.id === 'pro' || plan.id === 'enterprise')) {
    setup.push('• تجهيز هوية بصرية مؤقتة حتى يجهز شعارك');
  }
  setup.push('• حسابات الطاقم بدخول PIN (نادل/شيف/كاشير)');

  const lines = [
    `🚀 *تصور الإطلاق — ${profile.restaurant_name ?? 'مطعمك'}*`,
    `${profile.city ?? ''}${branches > 1 ? ` · ${branches} فروع` : ''}${tables > 0 ? ` · ${tables} طاولة` : ''}`,
    '',
    `*الباقة:* ${plan.name}${plan.mostPopular ? ' (الأكثر طلبًا)' : ''}`,
    `*السعر:* *${plan.priceMonthly} ₪/شهر*${perTable} — ثابت وبدون رسوم مخفية`,
    `*السنوي:* ${plan.priceYearly} ₪ دفعة واحدة — توفير *${plan.yearlySavings} ₪*`,
    '',
    '*وش بنجهز لك:*',
    ...setup,
    '',
    '*خطوات الإطلاق:*',
    '1. تأكيد الطلب منك (أنت هنا الآن 👇)',
    '2. مدير المنصة يستلم ملفك ويجهز نسختك — خلال دقائق عادة',
    '3. تجربة طلب حي من طاولة حقيقية قبل الافتتاح الرسمي',
    '',
    'بدون بطاقة للبدء، وترقية/إلغاء مرنة بأي وقت.',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** سطر الطلب المختصر (يُحفظ مع الطلب المؤكد) */
export function orderSummaryLine(profile: RestaurantProfile, orderRef: string): string {
  const plan = getPlan((profile.preferred_plan ?? 'pro') as PlanId);
  return (
    `${orderRef} | ${profile.restaurant_name ?? '—'} (${profile.city ?? '—'}) | ` +
    `${profile.tables ?? '؟'} طاولة | ${PLAN_AR[plan.id]} ${plan.priceMonthly}₪/شهر | ` +
    `${profile.full_name ?? '—'} ${profile.whatsapp_number ?? ''}`.trim()
  );
}

/**
 * رسالة مدير المنصة — الملف الكامل للطلب المؤكد.
 * تُرسل واتساب لرقم المدير فور تأكيد العميل.
 */
export function managerOrderMessage(
  profile: RestaurantProfile,
  orderRef: string,
  sessionKey: string,
): string {
  const plan = getPlan((profile.preferred_plan ?? 'pro') as PlanId);
  const tables = profile.tables ?? 0;
  const branches = profile.branches && profile.branches > 0 ? profile.branches : 1;

  const lines = [
    `🚀 *طلب إطلاق جديد مؤكد* ${orderRef}`,
    '',
    `👤 العميل: ${profile.full_name ?? '—'}`,
    `🍽️ المطعم: ${profile.restaurant_name ?? '—'} — ${profile.city ?? '—'}`,
    `📍 الفروع: ${branches} · الطاولات: ${tables || '—'} · الأصناف: ${profile.menu_items ?? '—'}`,
    `📦 الباقة: *${plan.name}* — *${plan.priceMonthly} ₪/شهر*` +
      (tables > 0 ? ` (~${perTableMonthly(plan, tables)} ₪/طاولة)` : ''),
    `💳 السنوي المتاح: ${plan.priceYearly} ₪ (توفير ${plan.yearlySavings} ₪)`,
    `🎨 الشعار: ${profile.has_logo === true ? 'جاهز عند العميل' : profile.has_logo === false ? 'غير جاهز — جهزوا هوية مؤقتة' : 'غير معروف'}`,
    `📱 واتساب العميل: ${profile.whatsapp_number ?? sessionKey}`,
    `🔑 الجلسة: ${sessionKey}`,
  ];
  if (profile.notes?.trim()) lines.push(`📝 ملاحظات: ${profile.notes.trim().slice(0, 300)}`);
  lines.push('', 'المحادثة حُوّلت لك — أكمل مع العميل تجهيز النسخة.');
  return lines.join('\n');
}

/** استخراج اسم الباقة من نص حر (يُستخدم عند تأكيد العميل الشفهي) */
export function planIdFromText(text: string): PlanId | null {
  const t = (text ?? '').toLowerCase();
  if (/مؤسس|enterprise|سلاسل/.test(t)) return 'enterprise';
  if (/احتراف|pro|المتكامل/.test(t)) return 'pro';
  if (/أساس|starter/.test(t)) return 'starter';
  return null;
}
