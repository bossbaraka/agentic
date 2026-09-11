/**
 * نقاط الجودة (Lead Score) — حتمية وشفافة، بلا LLM.
 *
 * كل إشارة لها وزن معلن. النتيجة 0–100 وفئتها:
 *   0–30 cold | 31–60 warm | 61–80 qualified | 81–100 hot
 * النموذج اللغوي لا يخترع النقاط إطلاقًا — هذا الملف هو المصدر الوحيد.
 */
import type { CustomerState, Intent, PainPoint, ObjectionKind, SalesStage } from './types.js';

/** نبضة واحدة مع وزنها — التسمية تُستخدم في السجلات والمقاييس */
export interface ScoreSignal {
  id: string;
  points: number;
}

/** إشارات إيجابية للرسالة الحالية — وزن كل إشارة يُطبق مرة واحدة (التكرار لا يتراكم) */
export const SIGNALS: Record<string, number> = {
  business_identified: 12,      // ذكر مطعم/كافيه/سلسلة
  size_identified: 10,          // عدد طاولات/فروع معروف
  pain_point_shared: 14,        // ألم تشغيلي صريح
  asked_pricing: 8,             // سأل عن السعر
  asked_comparison: 8,          // قارن الباقات
  asked_recommendation: 6,      // طلب توصية
  asked_implementation: 10,     // سأل عن التفعيل/الخطوات/التجهيز
  asked_payment: 8,             // سأل عن الدفع/الفواتير
  requested_booking: 16,        // طلب حجز موعد تفعيل
  purchase_intent: 10,          // نية شراء صريحة (هذه الرسالة — الزكام الدائم في أسفل)
  requested_onboarding: 18,     // بدأ مسار التجهيز (بيانات/تصور)
  returned_with_intent: 6,      // عائد بعد غياب وبنية واضحة
};

/**
 * وزن المرحلة — المكوّن الأهم للذاكرة: المرحلة تتقدم للأمام فقط،
 * لذا تضمن أن النقاط لا تنهار بين الرسائل (المسار الحتمي 16).
 */
export const STAGE_SCORE: Partial<Record<SalesStage, number>> = {
  QUALIFICATION: 4,
  PROBLEM_IDENTIFICATION: 8,
  SOLUTION_MAPPING: 12,
  RECOMMENDATION: 14,
  CONSIDERATION: 16,
  OBJECTION_HANDLING: 10,
  PURCHASE_INTENT: 26,
  ONBOARDING: 30,
};

/** إشارات سلبية — خصم */
export const NEGATIVE_SIGNALS: Record<string, number> = {
  casual_curiosity: -4,         // فضول عابر بلا سؤال جاد
  unrelated_topic: -8,          // موضوع خارج النشاط
  rejection_signal: -10,        // رفض متكرر واضح
};

const CAP = 100;

/**
 * حساب النقاط = قاعدة أولية
 *   + مكونات العلاقة المتراكمة (مرحلة، نية شراء، ألم، اعتراضات، بروفايل، عودة)
 *   + إشارات الرسالة الحالية (زخم اللحظة)
 * كل مكون يُحسب مرة واحدة — النتيجة حتمية 100% لنفس المدخلات.
 */
export function computeLeadScore(
  state: Pick<CustomerState, 'painPoints' | 'objections' | 'purchaseIntent' | 'stage' | 'returningAfterGap'>,
  newSignals: string[],
  profile: { restaurantName?: string; tables?: number; branches?: number; preferredPlan?: string },
): { score: number; category: CustomerState['leadCategory']; applied: ScoreSignal[] } {
  let score = 10; // قاعدة: كل من بدأ محادثة لديه اهتمام أولي

  const applied: ScoreSignal[] = [];
  const appliedIds = new Set<string>();
  const add = (id: string, pts?: number) => {
    const p = pts ?? SIGNALS[id];
    if (!p || appliedIds.has(id)) return;
    appliedIds.add(id);
    score += p;
    applied.push({ id, points: p });
  };

  // ── العلاقة المتراكمة (من الحالة المخزنة — لا تختفي بين الرسائل) ──
  if (state.purchaseIntent) add('relationship_purchase_intent', 30);
  if (state.painPoints.length > 0) add('relationship_pains', 6 * Math.min(state.painPoints.length, 3));
  if (state.objections.length > 0) add('relationship_objections', 6 * Math.min(state.objections.length, 2));
  if (state.returningAfterGap) add('relationship_returning', 8);

  if (profile.restaurantName) add('profile_restaurant', 5);
  if (profile.tables) add('profile_size', profile.tables >= 50 ? 16 : profile.tables >= 20 ? 12 : 8);
  if (profile.branches && profile.branches >= 2) add('profile_branches', 15);
  if (profile.preferredPlan) add('profile_plan', 12);

  const stagePts = STAGE_SCORE[state.stage];
  if (stagePts) add('relationship_stage', stagePts);

  // ── إشارات الرسالة الحالية ──
  for (const s of newSignals) {
    if (SIGNALS[s] !== undefined) add(s);
    else if (NEGATIVE_SIGNALS[s] !== undefined) {
      score += NEGATIVE_SIGNALS[s]!;
      applied.push({ id: s, points: NEGATIVE_SIGNALS[s]! });
    }
  }

  if (state.purchaseIntent) add('purchase_intent');
  if (state.objections.length > 0 && state.purchaseIntent) {
    // اعتراض + نية شراء = قريب من القرار لكن بحاجة معالجة — ليست عقوبة
    applied.push({ id: 'objection_active', points: 0 });
  }

  score = Math.max(0, Math.min(CAP, Math.round(score)));
  return { score, category: categoryOf(score), applied };
}

export function categoryOf(score: number): CustomerState['leadCategory'] {
  if (score >= 81) return 'hot';
  if (score >= 61) return 'qualified';
  if (score >= 31) return 'warm';
  return 'cold';
}

/** إشارات مرتبطة بنوايا — جسر بين المصنّف والنقاط */
export function signalsFromIntent(intent: Intent): string[] {
  switch (intent) {
    case 'pricing': return ['asked_pricing'];
    case 'plan_comparison': case 'competitor_comparison': return ['asked_comparison'];
    case 'recommendation': return ['asked_recommendation'];
    case 'onboarding': return ['asked_implementation'];
    case 'purchase_intent': return ['purchase_intent'];
    case 'booking': return ['requested_booking'];
    case 'restaurant_qualification': return ['business_identified'];
    case 'unrelated': return ['unrelated_topic'];
    default: return [];
  }
}

/** إشارة ألم → نبضة نقاط */
export function signalsFromPains(pains: { pain: PainPoint }[]): string[] {
  return pains.length > 0 ? ['pain_point_shared'] : [];
}

/** إشارة اعتراض — لا خصم تلقائي: الاعتراض اهتمام، الرفض المتكرر فقط يخصم */
export function objectionSignal(kind: ObjectionKind, repeated: boolean): string[] {
  return repeated && (kind === 'timing' || kind === 'value') ? ['rejection_signal'] : [];
}
