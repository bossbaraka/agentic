/**
 * حالة العميل الدائمة — منفصلة عن الجلسة الحالية.
 *
 * أربعة مفاهيم لا تُخلط:
 *   1. المعرفة (Knowledge)        حقائق مُريح — knowledge/*.md
 *   2. ذاكرة العميل (Profile)     بيانات مطعمه المؤكدة — store.profile
 *   3. سياق المحادثة (Session)    رسائل الجلسة الحالية وملخصها
 *   4. حالة العميل (هذا الملف)    أين وصل في رحلة البيع — مرحلة/ألم/اعتراض/نقاط
 *
 * الحالة تُحفظ مع الجلسة (sessions.json) وتُطابق في SQLite (customers.agent_state)
 * ليبقى التاريخ معادًا حتى لو أعيد بناء الجلسة، وتظهر في لوحة التحكم.
 */
import { normalize } from './intent.js';
import { computeLeadScore, signalsFromIntent, signalsFromPains, objectionSignal } from './leadScore.js';
import { advanceStage, STAGE_LABELS_AR } from './salesStage.js';
import { detectPainPoints, PAIN_LABELS_AR } from './painPoints.js';
import { detectObjections, objectionPolicy, OBJECTION_LABELS_AR } from './objections.js';
import { classifyIntent } from './intent.js';
import type {
  CustomerState,
  Intent,
  PainPoint,
  ObjectionKind,
  TurnAnalysis,
} from './types.js';

export * from './types.js';
export { classifyIntent, normalize } from './intent.js';
export { detectPainPoints, PAIN_LABELS_AR } from './painPoints.js';
export { detectObjections, objectionPolicy, OBJECTION_LABELS_AR } from './objections.js';
export { computeLeadScore, categoryOf, SIGNALS, NEGATIVE_SIGNALS } from './leadScore.js';
export { advanceStage, STAGE_LABELS_AR, stagePolicy } from './salesStage.js';

export const INITIAL_STAGE: CustomerState['stage'] = 'DISCOVERY';

/** حالة جديدة نظيفة — لا افتراضات عن العميل */
export function newCustomerState(now = Date.now()): CustomerState {
  return {
    stage: INITIAL_STAGE,
    painPoints: [],
    objections: [],
    purchaseIntent: false,
    leadScore: 8,
    leadCategory: 'cold',
    updatedAt: now,
  };
}

/** كشف طابع النشاط من نص حر (مطعم/كافيه/سلسلة...) — يُخزن فقط عند اليقين النسبي */
export function detectBusinessType(text: string): CustomerState['businessType'] | undefined {
  const t = normalize(text);
  if (/سلسله|سلاسل|فروع كثيره|عدة فروع|شبكه مطاعم/.test(t)) return 'chain';
  if (/فندق|منتجع/.test(t)) return 'hotel';
  if (/كافيه|كفيه|مقهى|قهوه|coffee|cafe/.test(t)) return 'cafe';
  if (/مطعم|مطبخ|شاورما|بيتزا|برجر|مشاوي|حلويات/.test(t)) return 'restaurant';
  return undefined;
}

export interface ApplyInput {
  state: CustomerState;
  analysis: TurnAnalysis;
  profile: { restaurantName?: string; tables?: number; branches?: number; preferredPlan?: string };
  /** أدوات نجحت في هذه الدورة — تحدد مراحل قسرية */
  toolFacts?: { launchConfirmed?: boolean; bookingCreated?: boolean; supportTicket?: boolean };
  now?: number;
}

/**
 * دمج نتيجة التحليل في الحالة الدائمة — النقطة الوحيدة التي تتغير فيها الحالة.
 * المبادئ: لا نحذف معرفة سابقة، الألم والاعتراضات تتراكم بلا تكرار،
 * والنقاط حتمية من computeLeadScore.
 */
export function applyAnalysis(input: ApplyInput): CustomerState {
  const { state, analysis, profile } = input;
  const now = input.now ?? Date.now();
  const next: CustomerState = { ...state, updatedAt: now };

  // 1) النية الأخيرة + هدف المحادثة
  next.lastIntent = analysis.intent.intent;
  next.conversationGoal = goalFor(analysis.intent.intent);

  // 2) الألم — تراكم بلا تكرار، الأحدث أولًا في الترتيب
  const painSet = new Set<PainPoint>(analysis.pains.map((p) => p.pain));
  next.painPoints = [...painSet, ...state.painPoints.filter((p) => !painSet.has(p))].slice(0, 5);

  // 3) الاعتراضات — تراكم مع وقت آخر ظهور (بدون تعديل حالة الإدخال نفسها)
  const prevObj = state.objections.map((o) => ({ ...o }));
  for (const o of analysis.objections) {
    const existing = prevObj.find((x) => x.kind === o.kind);
    if (existing) {
      existing.at = now;
      if (o.note) existing.note = o.note;
    }
  }
  const fresh = analysis.objections.filter((o) => !prevObj.some((x) => x.kind === o.kind));
  next.objections = [...fresh.map((o) => ({ ...o, at: now })), ...prevObj]
    .slice(0, 4)
    .sort((a, b) => b.at - a.at);

  // 4) نية الشراء — نعم لصقًا (لا ننزعها لاحقًا؛ الرجوع يُدار بالمراحل)
  if (analysis.purchaseIntent) next.purchaseIntent = true;

  // 5) طابع النشاط
  const bt = detectBusinessType(analysis.combined);
  if (bt && !next.businessType) next.businessType = bt;

  // 6) المرحلة
  let stage = advanceStage(state.stage, {
    intent: analysis.intent.intent,
    profile,
    newObjection: analysis.objections.length > 0,
    newPain: analysis.pains.length > 0,
    supportMode: analysis.supportMode,
  });
  if (input.toolFacts?.launchConfirmed) stage = 'ONBOARDING';
  else if (input.toolFacts?.bookingCreated) stage = 'ONBOARDING';
  else if (input.toolFacts?.supportTicket) stage = 'CUSTOMER_SUPPORT';
  next.stage = stage;

  // 7) النقاط الحتمية
  const signals = [
    ...analysis.scoreSignals,
    ...signalsFromIntent(analysis.intent.intent),
    ...signalsFromPains(analysis.pains),
  ];
  // أداة نجحت فعلًا (طلب مؤكد/حجز منشأ) = أعمق إشارة تنفيذ، لا مجرد كلام
  if (input.toolFacts?.launchConfirmed || input.toolFacts?.bookingCreated) signals.push('requested_onboarding');
  if (input.toolFacts?.supportTicket) signals.push('asked_implementation');
  const repeated = (k: ObjectionKind) => state.objections.some((o) => o.kind === k);
  for (const o of analysis.objections) signals.push(...objectionSignal(o.kind, repeated(o.kind)));
  if (analysis.intent.intent !== 'unclear' && state.returningAfterGap) signals.push('returned_with_intent');
  const score = computeLeadScore(next, signals, profile);
  next.leadScore = score.score;
  next.leadCategory = score.category;

  // 8) طي الاعتراضات بعد نية شراء صريحة ومعالجة (لا نحذفها — الأرشيف يبقى في objections)
  if (next.purchaseIntent && next.stage === 'PURCHASE_INTENT' && analysis.intent.intent === 'purchase_intent') {
    next.objections = next.objections.slice(0, 3);
  }

  return next;
}

function goalFor(intent: Intent): string | undefined {
  switch (intent) {
    case 'pricing': return 'يفهم الأسعار';
    case 'plan_comparison': case 'competitor_comparison': return 'يقارن الخيارات';
    case 'recommendation': return 'يريد توصية مناسبة';
    case 'restaurant_qualification': return 'يقدم بيانات نشاطه';
    case 'purchase_intent': case 'onboarding': return 'يريد التفعيل';
    case 'booking': return 'يريد حجز موعد تفعيل';
    case 'booking_modification': return 'يريد تعديل حجز';
    case 'booking_cancellation': return 'يريد إلغاء حجز';
    case 'support': case 'complaint': return 'يحتاج دعمًا';
    case 'human_request': return 'يريد موظفًا بشريًا';
    case 'feature_question': return 'يستكشف المزايا';
    case 'product_information': case 'service_information': return 'يتعرف على الخدمات';
    case 'technical_question': return 'سؤال تقني';
    case 'existing_customer': return 'مشترك حالي';
    default: return undefined;
  }
}

/**
 * تجهيز كتلة CURRENT_CONTEXT للحالة — تُحقن في الـ system prompt.
 * قصيرة وكثيفة إشارة فقط: لا تسرّب استدلالًا ولا نصوصًا طويلة.
 */
export function renderStateContext(
  state: CustomerState,
  opts: {
    profile: { restaurantName?: string; tables?: number; branches?: number; preferredPlan?: string };
    hoursSinceLastContact?: number;
    painQuestion?: string;
    objectionKinds?: ObjectionKind[];
  },
): string {
  const lines: string[] = [];

  lines.push(`- مرحلة العميل في الرحلة: ${state.stage} — اتبع سياسة المرحلة أدناه حرفيًا.`);
  if (state.lastIntent && state.lastIntent !== 'unclear') {
    lines.push(`- آخر نية مرصودة: ${state.lastIntent}${state.conversationGoal ? ` (${state.conversationGoal})` : ''}.`);
  }
  if (opts.profile.preferredPlan) {
    lines.push(`- آخر عرض/باقة معروضة عليه: ${opts.profile.preferredPlan} — لا تكرر التوصية نفسها ولا تعرض باقة مغايرة بلا سبب واضح ذكره هو.`);
  }
  if (state.painPoints.length > 0) {
    const labels = state.painPoints.map((p) => PAIN_LABELS_AR[p]).join('، ');
    lines.push(`- ألم تشغيلي معروف لديه: ${labels} — ابنِ على هذا الألم ولا تسأل عنه من جديد.`);
    if (opts.painQuestion && state.stage === 'PROBLEM_IDENTIFICATION') {
      lines.push(`- سؤال التأهيل المنطقي التالي لهذا الألم (سؤال واحد إن احتجت السؤال): ${opts.painQuestion}`);
    }
  }
  if (opts.objectionKinds && opts.objectionKinds.length > 0) {
    const labels = opts.objectionKinds.map((k) => OBJECTION_LABELS_AR[k]).join('، ');
    lines.push(`- اعتراض قائم لم يُحل بعد: ${labels} — عالجه قبل أي دعوة تفعيل، ولا تكرر الحجة التي سبق رفضها.`);
  }
  if (state.returningAfterGap && opts.hoursSinceLastContact !== undefined && opts.hoursSinceLastContact >= 1) {
    const h = Math.round(opts.hoursSinceLastContact);
    const ago = h < 48 ? `${h} ساعة` : `${Math.round(h / 24)} يوم`;
    lines.push(`- العميل عاد بعد انقطاع (~${ago}). رحّب بلطف بجملة واحدة ثم أكمل من آخر نقطة (المرحلة أعلاه) — لا تعيد التعريف ولا الاكتشاف من الصفر.`);
  }
  if (state.purchaseIntent) {
    lines.push('- لديه نية شراء معلنة سابقًا: لا تعود لأسئلة الاكتشاف — قدّم الخطوة العملية التالية مباشرة.');
  }

  return lines.join('\n');
}
