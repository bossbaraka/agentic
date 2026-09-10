/**
 * بيانات باقات منصة مُريح — المصدر الوحيد لأرقام الباقات.
 *
 * ⚠️ عند تغيير أي سعر أو ميزة: عدّل هنا فقط.
 * هذه البيانات تتطابق مع صفحة الباقات في الموقع (SaaSLandingPage).
 * الأداة get_plan_details والـ mock engine يقرآن من هنا لضمان الدقة.
 */

export type PlanId = 'starter' | 'pro' | 'enterprise';

export interface MureehPlan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthly: number;
  priceYearly: number;
  /** السعر الشهري المكافئ عند الدفع السنوي */
  priceYearlyPerMonth: number;
  /** الموفر عند الدفع السنوي (₪) */
  yearlySavings: number;
  features: string[];
  mostPopular?: boolean;
}

export const MUREEH_PLANS: MureehPlan[] = [
  {
    id: 'starter',
    name: 'الباقة الأساسية',
    tagline: 'للمطاعم والكافيهات الواعدة — منيو QR تفاعلي فاخر وكاشير واستدعاء نادل',
    priceMonthly: 300,
    priceYearly: 3000,
    priceYearlyPerMonth: 250,
    yearlySavings: 600, // شهرين مجانًا
    features: [
      'منيو رقمي فاخر وتفاعلي عبر رمز الـ QR',
      'طلب فوري مباشر من الطاولة بدون أي تطبيق',
      'زر استدعاء النادل وإدارة طلبات الخدمة',
      'نظام كاشير أساسي وتصفية الفواتير',
      'لوحة تحكم ودعم فني من منصة مريح',
    ],
  },
  {
    id: 'pro',
    name: 'الباقة الاحترافية (الأكثر طلباً)',
    tagline: 'الحل المتكامل لإدارة الصالات وشاشة المطبخ والـ POS — الأكثر طلباً للمطاعم الفاخرة',
    priceMonthly: 550,
    priceYearly: 5500,
    priceYearlyPerMonth: Math.round(5500 / 12), // 458
    yearlySavings: 1100, // شهرين مجانًا
    mostPopular: true,
    features: [
      'جميع مزايا الباقة الأساسية بالكامل',
      'شاشة المطبخ الحية (KDS) بتنبيهات صوتية فورية',
      'نقطة بيع POS متطورة وتصنيفات الصالات',
      'تحليلات مبيعات تفاعلية وتخصيص الهوية البصرية',
      'إدارة العروض والكومبو وشارات الترويج',
    ],
  },
  {
    id: 'enterprise',
    name: 'باقة المؤسسات والسلاسل',
    tagline: 'لسلاسل المطاعم والفنادق والمنتجعات والفروع المتعددة',
    priceMonthly: 850,
    priceYearly: 8500,
    priceYearlyPerMonth: Math.round(8500 / 12), // 708
    yearlySavings: 1700, // شهرين مجانًا
    features: [
      'سعة مفتوحة للفروع والأصناف والطلبات',
      'إدارة الفروع المتعددة (Multi-Branch System)',
      'ربط نطاق خاص لموقعك (Custom Domain)',
      'مدير حساب خاص ودعم أولوية قصوى 24/7',
    ],
  },
];

export function getPlan(id: PlanId): MureehPlan {
  return MUREEH_PLANS.find((p) => p.id === id) ?? MUREEH_PLANS[0]!;
}

/**
 * تكلفة الطاولة الواحدة شهريًا — أقوى جملة إقناع سعرية.
 * مثال: الاحترافية (550₪) ÷ 25 طاولة ≈ 22₪ للطاولة — «أقل من سعر وجبة واحدة أو فنجان قهوة».
 */
export function perTableMonthly(plan: MureehPlan, tables: number): number {
  if (!tables || tables <= 0) return plan.priceMonthly;
  return Math.max(1, Math.round(plan.priceMonthly / tables));
}

/** سطر القيمة المقسّطة الجاهز للردود (يُستخدم في التوصيات والإقناع) */
export function valueLine(plan: MureehPlan, tables?: number): string {
  if (tables && tables > 0) {
    return `*${plan.priceMonthly} ₪/شهر* فقط — يعني ~*${perTableMonthly(plan, tables)} ₪* للطاولة الواحدة (أقل من وجبة أو فنجان قهوة بالشهر)`;
  }
  return `*${plan.priceMonthly} ₪/شهر* فقط (يمكن الترقية أو الإلغاء بأي وقت وبدون بطاقة للبدء)`;
}

export interface RecommendInput {
  /** عدد الطاولات في المطعم */
  tables?: number;
  /** كلمات عن الاحتياجات: "شاشة مطبخ", "فروع", "هوية بصرية"... */
  needs?: string[];
}

export interface PlanRecommendation {
  plan: MureehPlan;
  reason: string;
}

/**
 * توصية حتمية (deterministic) بالباقة المناسبة —
 * نفس المنطق الذي يجب أن يتبعه النموذج، لكن بالأرقام الدقيقة من هنا.
 */
export function recommendPlan(input: RecommendInput): PlanRecommendation {
  const tables = input.tables ?? 0;
  const needs = (input.needs ?? []).join(' ');
  const wantsBranches =
    /فرع|فروع|سلسلة|سلاسل|شبكة|فنادق|منتجع|multi|branch/i.test(needs) || tables > 40;

  if (wantsBranches) {
    return {
      plan: getPlan('enterprise'),
      reason:
        tables > 40
          ? `مطعم كبير (${tables} طاولة) أو فروع متعددة يحتاج سعة مفتوحة وإدارة الفروع المتعددة ونطاقًا خاصًا`
          : 'إدارة فروع متعددة وسلاسل وفنادق تحتاج باقة المؤسسات بسعة مفتوحة ودعم 24/7',
    };
  }

  const wantsPro =
    tables >= 12 ||
    /kds|مطبخ|شاشة مطبخ|pos|كاشير متقدم|تحليلات|هوية|بصرية|شعار|ألوان|تخصيص|عروض|كومبو|صالات|فاخر/i.test(needs);

  if (wantsPro) {
    return {
      plan: getPlan('pro'),
      reason:
        tables >= 12
          ? `لـ${tables} طاولة شاشة المطبخ الحية KDS ونقطة البيع POS والتحليلات تمنع ضياع أي طلب وتزيد سرعة تدوير الطاولات`
          : 'المزايا المطلوبة (شاشة المطبخ KDS/نقطة البيع POS/الهوية البصرية والعروض) مشمولة بالكامل في الباقة الاحترافية',
    };
  }

  return {
    plan: getPlan('starter'),
    reason: 'منيو رقمي فاخر وتفاعلي وكاشير واستدعاء نادل من الطاولة — انطلاقة قوية ومرنة ويمكن الترقية بأي وقت',
  };
}
