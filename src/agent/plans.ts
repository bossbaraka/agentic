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
    tagline: 'للمطاعم والكافيهات الواعدة',
    priceMonthly: 149,
    priceYearly: 1490,
    priceYearlyPerMonth: Math.round(1490 / 12), // 124
    yearlySavings: 149 * 12 - 1490, // 298
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
    name: 'الباقة الاحترافية',
    tagline: 'الحل المتكامل لإدارة الصالات وشاشة المطبخ والـ POS — الأكثر طلبًا',
    priceMonthly: 299,
    priceYearly: 2990,
    priceYearlyPerMonth: Math.round(2990 / 12), // 249
    yearlySavings: 299 * 12 - 2990, // 598
    mostPopular: true,
    features: [
      'جميع مزايا الباقة الأساسية بالكامل',
      'شاشة المطبخ الحية (KDS) بتنبيهات صوتية فورية',
      'نقطة بيع POS متطورة وتصنيفات الصالات',
      'تحليلات مبيعات تفاعلية وتخصيص الهوية البصرية (ألوان، شعار، غلاف)',
      'إدارة العروض والكومبو وشارات الترويج',
    ],
  },
  {
    id: 'enterprise',
    name: 'باقة المؤسسات والسلاسل',
    tagline: 'لسلاسل المطاعم والفنادق والمنتجعات والفروع المتعددة',
    priceMonthly: 799,
    priceYearly: 7990,
    priceYearlyPerMonth: Math.round(7990 / 12), // 666
    yearlySavings: 799 * 12 - 7990, // 1598
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
 * مثال: الاحترافية (299₪) ÷ 25 طاولة ≈ 12₪ للطاولة — «أقل من سعر وجبة».
 */
export function perTableMonthly(plan: MureehPlan, tables: number): number {
  if (!tables || tables <= 0) return plan.priceMonthly;
  return Math.max(1, Math.round(plan.priceMonthly / tables));
}

/** سطر القيمة المقسّطة الجاهز للردود (يُستخدم في التوصيات والإقناع) */
export function valueLine(plan: MureehPlan, tables?: number): string {
  if (tables && tables > 0) {
    return `*${plan.priceMonthly} ₪/شهر* فقط — يعني ~*${perTableMonthly(plan, tables)} ₪* للطاولة الواحدة`;
  }
  return `*${plan.priceMonthly} ₪/شهر* فقط`;
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
    /فرع|فروع|سلسلة|سلاسل|شبكة|multi|branch/i.test(needs) || tables > 50;

  if (wantsBranches) {
    return {
      plan: getPlan('enterprise'),
      reason:
        tables > 50
          ? 'مطعم كبير (أكثر من 50 طاولة) يحتاج سعة مفتوحة'
          : 'إدارة فروع متعددة وسلاسل تحتاج الباقة المصممة لها',
    };
  }

  const wantsPro =
    tables >= 15 ||
    /kds|مطبخ|شاشة مطبخ|pos|كاشير متقدم|تحليلات|هوية|بصرية|شعار|ألوان|تخصيص|عروض|كومبو|صالات/i.test(needs);

  if (wantsPro) {
    return {
      plan: getPlan('pro'),
      reason:
        tables >= 15
          ? `عدد الطاولات (${tables}) يستحق شاشة المطبخ والتحليلات التي توفر الوقت والمال`
          : 'المزايا المطلوبة (شاشة المطبخ/التحليلات/الهوية البصرية) متوفرة في الباقة الاحترافية',
    };
  }

  return {
    plan: getPlan('starter'),
    reason: 'لنبدأ بمنيو رقمي احترافي يعمل فورًا — ويمكن الترقية لاحقًا في أي وقت',
  };
}
