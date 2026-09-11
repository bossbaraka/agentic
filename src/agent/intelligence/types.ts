/**
 * أنواع طبقة الذكاء الحتمية (Deterministic Intelligence Layer).
 *
 * هذه الطبقة لا تُبدّل فهم النموذج اللغوي — بل تضيف طبقة قرارات حتمية
 * قابلة للاختبار حولها: تصنيف النية، مرحلة البيع، الألم، الاعتراض،
 * ونقاط الجودة (Lead Score). كل شيء هنا كود صرف بلا LLM.
 */

/** النوايا المعتمدة — القائمة الكاملة من مواصفة الوكيل */
export type Intent =
  | 'greeting'
  | 'product_information'
  | 'service_information'
  | 'pricing'
  | 'plan_comparison'
  | 'recommendation'
  | 'restaurant_qualification'
  | 'feature_question'
  | 'technical_question'
  | 'booking'
  | 'booking_modification'
  | 'booking_cancellation'
  | 'onboarding'
  | 'purchase_intent'
  | 'objection_price'
  | 'objection_value'
  | 'objection_trust'
  | 'objection_complexity'
  | 'objection_timing'
  | 'competitor_comparison'
  | 'complaint'
  | 'support'
  | 'human_request'
  | 'existing_customer'
  | 'unrelated'
  | 'unclear';

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentResult {
  intent: Intent;
  confidence: IntentConfidence;
  /** كل النوايا المرشحة بترتيب القوة — للتشخيص والمقاييس */
  candidates: { intent: Intent; score: number }[];
}

/** مراحل رحلة البيع */
export type SalesStage =
  | 'DISCOVERY'
  | 'QUALIFICATION'
  | 'PROBLEM_IDENTIFICATION'
  | 'SOLUTION_MAPPING'
  | 'RECOMMENDATION'
  | 'OBJECTION_HANDLING'
  | 'CONSIDERATION'
  | 'PURCHASE_INTENT'
  | 'CONVERSION'
  | 'ONBOARDING'
  | 'CUSTOMER_SUPPORT';

export const SALES_STAGES: SalesStage[] = [
  'DISCOVERY', 'QUALIFICATION', 'PROBLEM_IDENTIFICATION', 'SOLUTION_MAPPING',
  'RECOMMENDATION', 'OBJECTION_HANDLING', 'CONSIDERATION', 'PURCHASE_INTENT',
  'CONVERSION', 'ONBOARDING', 'CUSTOMER_SUPPORT',
];

/** أنواع الألم التشغيلية التي يعالجها نظام مُريح */
export type PainPoint =
  | 'slow_waiter'
  | 'lost_orders'
  | 'kitchen_delays'
  | 'paper_menu'
  | 'manual_accounting'
  | 'order_errors'
  | 'peak_crowding'
  | 'table_management'
  | 'customer_experience'
  | 'multi_branch';

export interface PainPointHit {
  pain: PainPoint;
  /** الحل المرتبط من قدرات المنصة (مصطلح داخلي — لا يُعرض للعميل كما هو) */
  solution: 'qr_menu' | 'waiter_call' | 'kds' | 'pos' | 'analytics' | 'multi_branch' | 'waiter_requests';
  /** سؤال التأهيل المنطقي التالي لهذا الألم */
  qualificationQuestion: string;
}

export type ObjectionKind = 'price' | 'value' | 'trust' | 'complexity' | 'timing' | 'competitor';

export interface ObjectionHit {
  kind: ObjectionKind;
  /** اقتباس/وصف قصير لما قاله العميل (للحالة، لا للعميل) */
  note?: string;
}

/** حالة العميل الدائمة — تُحفظ في الجلسة وتُطابق في SQLite (أعمدة agent_state) */
export interface CustomerState {
  /** مرحلة رحلة البيع الحالية */
  stage: SalesStage;
  lastIntent?: Intent;
  /** عدد مرات اكتشاف كل ألم (الترتيب = الأهم أولًا) */
  painPoints: PainPoint[];
  /** الاعتراضات المرصودة (النوع + آخر ظهور) */
  objections: { kind: ObjectionKind; at: number; note?: string }[];
  /** هل أبدى نية شراء صريحة في هذه العلاقة؟ */
  purchaseIntent: boolean;
  /** نقاط الجودة 0–100 + الفئة */
  leadScore: number;
  leadCategory: 'cold' | 'warm' | 'qualified' | 'hot';
  /** آخر توصية باقة أعطيت للعميل */
  lastOffer?: 'starter' | 'pro' | 'enterprise';
  /** آخر سؤال طرحه البوت (يمنع السؤال المكرر ويُفهم الأجوبة القصيرة) */
  lastQuestion?: string;
  /** هدف المحادثة الحالي (يُستخرج من النية) */
  conversationGoal?: string;
  /** حالة مسار التجهيز للإطلاق (مرآة مختصرة لـ launch.status) */
  onboardingStatus?: 'not_started' | 'collecting' | 'awaiting_confirmation' | 'confirmed';
  /** هل العميل عائد بعد غياب؟ (يُحسب عند كل رسالة) */
  returningAfterGap?: boolean;
  /** طابع النشاط عند معرفته */
  businessType?: 'restaurant' | 'cafe' | 'chain' | 'hotel' | 'other';
  /** وقت آخر تفاعل (epoch ms) */
  updatedAt: number;
}

/** نتيجة التحليل الحتمي الكامل لدفعة رسائل */
export interface TurnAnalysis {
  intent: IntentResult;
  pains: PainPointHit[];
  objections: ObjectionHit[];
  /** نبضات نقاط الجودة المستخلصة من هذه الرسائل (تُدمج في الحالة) */
  scoreSignals: string[];
  /** تحديثات مقترحة للحالة (تُدمج عبر applyAnalysis) */
  purchaseIntent: boolean;
  humanRequest: boolean;
  supportMode: boolean;
  /** نص مجمع للرسائل (بعد التطبيع) */
  combined: string;
}
