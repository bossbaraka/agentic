/**
 * آلة حالات رحلة البيع — حتمية، بلا LLM.
 *
 * القاعدة الأساسية: الوكيل لا يقفز إلى CONVERSION بدون نية شراء صريحة،
 * ولا يبدأ DISCOVERY من جديد مع من تجاوزها. الحالة تُحدَّث من إشارات
 * النية + بيانات الملف + نتائج الأدوات (أوامر مؤكدة/حجوزات).
 */
import type { CustomerState, Intent, SalesStage } from './types.js';

export interface StageContext {
  intent: Intent;
  /** بيانات الملف المعروفة */
  profile: { restaurantName?: string; tables?: number; branches?: number; preferredPlan?: string };
  launchStatus?: 'collecting' | 'awaiting_confirmation' | 'confirmed';
  /** هل رُصدت اعتراضات في هذه الرسالة؟ */
  newObjection: boolean;
  /** شكوى/دعم صريح */
  supportMode: boolean;
  /** ألم جديد في هذه الرسالة */
  newPain: boolean;
  hasActiveBooking?: boolean;
}

/** هل المرحلة أعمق من الأخرى (ترتيب الرحلة)؟ */
const DEPTH: Record<SalesStage, number> = {
  DISCOVERY: 0,
  QUALIFICATION: 1,
  PROBLEM_IDENTIFICATION: 2,
  SOLUTION_MAPPING: 3,
  RECOMMENDATION: 4,
  CONSIDERATION: 5,
  OBJECTION_HANDLING: 5.5,
  PURCHASE_INTENT: 6,
  CONVERSION: 7,
  ONBOARDING: 8,
  CUSTOMER_SUPPORT: 9,
};

/** ترقية فقط إذا أعمق — منع الرجوع للخلف إلا للاعتراض/الدعم */
function deepen(current: SalesStage, next: SalesStage): SalesStage {
  if (DEPTH[next] > DEPTH[current]) return next;
  return current;
}

/**
 * تحديث المرحلة من سياق الرسالة. دالة نقية: تأخذ الحالة وتعيد الجديدة.
 */
export function advanceStage(current: SalesStage, ctx: StageContext): SalesStage {
  const { intent } = ctx;

  // الدعم والشكاوى لها مسارها الخاص — أعلى أولوية
  if (intent === 'complaint' || intent === 'support' || ctx.supportMode) return 'CUSTOMER_SUPPORT';

  // طلب بشري لا يغيّر مرحلة البيع
  if (intent === 'human_request') return current;

  // مسار التجهيز المنفَّذ فعليًا له الكلمة الأخيرة (أداة نجحت = الحقيقة)
  if (ctx.launchStatus === 'confirmed') return 'ONBOARDING';
  if (ctx.launchStatus === 'awaiting_confirmation') return deepen(current, 'PURCHASE_INTENT');
  if (ctx.launchStatus === 'collecting' && (intent === 'onboarding' || intent === 'restaurant_qualification')) {
    return deepen(current, 'PURCHASE_INTENT');
  }

  // ألغى/عدّل حجزًا قائمًا = عميل داخل مسار التفعيل
  if (intent === 'booking_cancellation' || intent === 'booking_modification') return deepen(current, 'ONBOARDING');

  // طلبات حجز موعد تفعيل = onboarding عملي
  if (intent === 'booking' && (ctx.profile.preferredPlan || ctx.hasActiveBooking)) return deepen(current, 'ONBOARDING');

  // أسئلة التجهيز/الخطوات = يستعد للإطلاق
  if (intent === 'onboarding') return deepen(current, 'PURCHASE_INTENT');

  // نية شراء صريحة
  if (intent === 'purchase_intent') return deepen(current, 'PURCHASE_INTENT');

  // اعتراض نشط
  if (ctx.newObjection || intent.startsWith('objection_')) {
    // الاعتراض بعد التوصية يعيده لمعالجة الاعتراض دون فقدان العمق المنطقي
    return DEPTH[current] >= DEPTH.RECOMMENDATION ? 'OBJECTION_HANDLING' : deepen(current, 'OBJECTION_HANDLING');
  }

  // ألم صريح = وصلنا لجو المشكلة
  if (ctx.newPain) return deepen(current, 'PROBLEM_IDENTIFICATION');

  switch (intent) {
    case 'pricing':
      // سؤال سعر بعد تأهيل = ربط حلّي؛ قبل التأهيل يبقى اكتشافًا لكن مع إذن إجابة سعر مباشرة
      return ctx.profile.tables ? deepen(current, 'SOLUTION_MAPPING') : deepen(current, 'DISCOVERY');
    case 'plan_comparison':
    case 'competitor_comparison':
      return deepen(current, 'CONSIDERATION');
    case 'recommendation':
    case 'feature_question':
      return deepen(current, 'SOLUTION_MAPPING');
    case 'restaurant_qualification':
      return deepen(current, 'QUALIFICATION');
    case 'booking':
      return deepen(current, 'ONBOARDING');
    case 'product_information':
    case 'service_information':
    case 'greeting':
    case 'unclear':
    case 'unrelated':
    case 'existing_customer':
    case 'technical_question':
      return current; // لا تغيير — الأدوار العامة لا تحرك الرحلة
    default:
      return current;
  }
}

/** تسمية عربية للمرحلة (للسجلات ولوحة التحكم) */
export const STAGE_LABELS_AR: Record<SalesStage, string> = {
  DISCOVERY: 'اكتشاف',
  QUALIFICATION: 'تأهيل',
  PROBLEM_IDENTIFICATION: 'تحديد المشكلة',
  SOLUTION_MAPPING: 'ربط الحل',
  RECOMMENDATION: 'توصية',
  OBJECTION_HANDLING: 'معالجة اعتراض',
  CONSIDERATION: 'تفكير/مقارنة',
  PURCHASE_INTENT: 'نية شراء',
  CONVERSION: 'تحويل/إتمام',
  ONBOARDING: 'تفعيل ودعم إعداد',
  CUSTOMER_SUPPORT: 'دعم عميل',
};

/**
 * سياسة الرد الخاصة بكل مرحلة — نص موجز يُحقن في CURRENT_CONTEXT.
 * هذا ما يمنع «هل تريد الاشتراك؟» في مرحلة الاكتشاف.
 */
export function stagePolicy(stage: SalesStage): string {
  switch (stage) {
    case 'DISCOVERY':
      return 'المرحلة: اكتشاف. هدفك: افهم نشاطه وحجمه وألمه بسؤال واحد لطيف. ممنوع البيع أو دعوة تفعيل في هذه المرحلة. إن سأل عن السعر أجب بالأسعار الرسمية مباشرة ثم سؤال تأهيل واحد فقط.';
    case 'QUALIFICATION':
      return 'المرحلة: تأهيل. لديك معلومات جزئية عن نشاطه. اربط ما ذكره بحل ملموس واحد واسأل عن نقطة النقص الأهم فقط (طاولات/ألم/مدينة) دون قائمة أسئلة.';
    case 'PROBLEM_IDENTIFICATION':
      return 'المرحلة: تحديد المشكلة. الألم واضح الآن — اشرح كيف يعالجه الحل المناسب بنتيجة تشغيلية واحدة ملموسة، ثم سؤال تأهيل واحد يقود للتوصية. لا تسرد كل المزايا.';
    case 'SOLUTION_MAPPING':
      return 'المرحلة: ربط الحل. اربط الألم بالباقة المناسبة منطقيًا (استخدم recommend_plan إن لم تكن واضحة) واشرح القيمة بالأرقام الرسمية. دعوة تفعيل واحدة مسموحة هنا إذا كان الاهتمام واضحًا.';
    case 'RECOMMENDATION':
      return 'المرحلة: توصية. عرضك مقدم — لا تكرر التوصية نفسها ولا تضغط. انتظر ردوده وعالج ما يثيره؛ إن صمت فسؤال متابعة خفيف واحد.';
    case 'OBJECTION_HANDLING':
      return 'المرحلة: معالجة اعتراض. اتبع سياسة الاعتراض أعلاه حرفيًا: اعترف، افهم السبب، قيمة بأرقام، بديل مناسب إن وجد، بلا أي ضغط أو تكرار CTA.';
    case 'CONSIDERATION':
      return 'المرحلة: تفكير/مقارنة. يجمع معلومات — أجب بدقة وحياد، أدرج فروقًا واضحة بين الخيارات، ولا تسرعه. سؤال خفيف واحد في النهاية على الأكثر.';
    case 'PURCHASE_INTENT':
      return 'المرحلة: نية شراء صريحة. توقف عن الاكتشاف فورًا — لا مزيد أسئلة تأهيل. ابدأ مسار التجهيز مباشرة: جمع بيانات الإطلاق سؤالًا واحدًا في كل رد، أو حجز موعد تفعيل.';
    case 'CONVERSION':
      return 'المرحلة: إتمام. التصور معروض/الطلب يؤكد — نفّذ الخطوة العملية (تأكيد/حجز) وأخبره بما سيحدث بعد التأكيد بالضبط. لا بيع إضافي الآن.';
    case 'ONBOARDING':
      return 'المرحلة: تفعيل ومتابعة. العميل داخل مسار التنفيذ — ساعده في الخطوات وحجوزاته، وأبلغ الفريق عند الحاجة. لا تكرر عروض البيع.';
    case 'CUSTOMER_SUPPORT':
      return 'المرحلة: دعم. تعاطف أولًا، ثم شخّص واجمع التفاصيل وافتح تذكرة عند الحاجة وحوّل للفريق. ممنوع أي عرض بيعي في هذه الرسالة.';
  }
}
