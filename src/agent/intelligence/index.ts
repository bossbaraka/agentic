/**
 * محرك التحليل الحتمي — نقطة الدخول الوحيدة للطبقة الذكية.
 *
 * يستقبل دفعة رسائل العميل (مدمجة) + سياقًا خفيفًا، ويعيد TurnAnalysis:
 * النية، الألم، الاعتراضات، نبضات النقاط، ونية الشراء/الدعم.
 * يُنفَّذ قبل بناء الـ prompt وبعده (للتحقق) — رخيص جدًا (regex فقط).
 */
import { classifyIntent, normalize } from './intent.js';
import { detectPainPoints } from './painPoints.js';
import { detectObjections } from './objections.js';
import { signalsFromIntent, signalsFromPains } from './leadScore.js';
import type { TurnAnalysis } from './types.js';

export * from './customerState.js';

const HUMAN_RE = /(?:بشري|انسان|موظف|حقيقي|agent|human)/i;
const SUPPORT_RE = /(?:مش شغال|ما تشتغل|عطل|تعطل|error|مشكله تقني|في مشكله|ما بظهر|زعلان|مقرف|سيئه)/i;
const PURCHASE_RE = /(?:بدي اشترك|ابغى اشترك|نبدأ التفعيل|خلينا نجهزها|جهز لي|ابدا التفعيل|اشترك|سجلني|فعلني|اكد الطلب|تاكيد الطلب|نثبت على|بدي اجرب)/i;

export interface AnalyzeInput {
  /** نص الرسائل المدمجة للدفعة */
  combined: string;
  /** آخر رسالة صادرة من البوت — لتفسير الأجوبة القصيرة */
  lastBotMessage?: string;
  hasKnownBusiness?: boolean;
}

export function analyzeMessages(input: AnalyzeInput): TurnAnalysis {
  const raw = (input.combined ?? '').trim();
  const norm = normalize(raw);
  const intent = classifyIntent(raw, {
    lastBotMessage: input.lastBotMessage,
    hasKnownBusiness: input.hasKnownBusiness,
  });
  const pains = detectPainPoints(norm);
  const objections = detectObjections(norm);

  const scoreSignals = [
    ...signalsFromIntent(intent.intent),
    ...signalsFromPains(pains),
  ];

  return {
    intent,
    pains,
    objections,
    scoreSignals,
    purchaseIntent: intent.intent === 'purchase_intent' || PURCHASE_RE.test(norm),
    humanRequest: intent.intent === 'human_request' || HUMAN_RE.test(norm),
    supportMode: intent.intent === 'complaint' || intent.intent === 'support' || SUPPORT_RE.test(norm),
    combined: raw,
  };
}
