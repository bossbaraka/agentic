/**
 * مقاييس جودة الوكيل — فقط ما يمكن قياسه فعليًا من الكود.
 *
 * ممنوع اختراع مقياس لا يوجد له مقياس آلي حقيقي (مثل «نسبة الهلوسة»).
 * القابل للقياس هنا:
 *   - fallback_rate        نسبة الردود من خارج النموذج الأساسي (مفيدة للإنذار)
 *   - tool_success_rate    نجاح/فشل استدعاءات الأدوات
 *   - intent_distribution  توزيع النوايا الحتمية + تطابقها مع نية النموذج
 *   - handoff_rate         نسبة الرسائل المحوّلة لبشري
 *   - response_latency_ms  زمن توليد الرد (يُسجل أيضًا في metric_events)
 *   - price_violations     أرقام أسعار غير رسمية رصدها حارس الأسعار
 *   - cta_repairs          دعوات بيع كبحها حارس الإلحاح
 *   - premature_cta        دعوات بيع في سياق دعم/اكتشاف
 */
import { recordMetric } from '../db/repos/system.js';

export interface AiQualitySnapshot {
  replies: number;
  repliesByEngine: Record<string, number>;
  fallbacks: number;
  fallbackRatePct: number;
  toolCalls: number;
  toolFailures: number;
  toolSuccessRatePct: number;
  handoffs: number;
  handoffRatePct: number;
  intentTotal: number;
  intentCounts: Record<string, number>;
  intentAgreementTotal: number;
  intentAgreementPct: number;
  priceViolations: number;
  ctaRepairs: number;
  prematureCta: number;
  avgLatencyMs: number;
}

interface Counters {
  replies: number;
  repliesByEngine: Record<string, number>;
  fallbacks: number;
  toolCalls: number;
  toolFailures: number;
  handoffReplies: number;
  intentTotal: number;
  intentCounts: Record<string, number>;
  intentAgreement: number;
  priceViolations: number;
  ctaRepairs: number;
  prematureCta: number;
  latencySumMs: number;
  latencyCount: number;
}

const counters: Counters = {
  replies: 0,
  repliesByEngine: {},
  fallbacks: 0,
  toolCalls: 0,
  toolFailures: 0,
  handoffReplies: 0,
  intentTotal: 0,
  intentCounts: {},
  intentAgreement: 0,
  priceViolations: 0,
  ctaRepairs: 0,
  prematureCta: 0,
  latencySumMs: 0,
  latencyCount: 0,
};

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

export const aiMetrics = {
  /** رد مكتمل — يستدعى مرة لكل دورة رد */
  recordReply(o: {
    engine: string;
    degraded?: boolean;
    aiStatus?: string;
    latencyMs: number;
    handoff?: boolean;
    toolsCalled?: { name: string; ok: boolean }[];
    detectedIntent?: string;
    modelIntent?: string;
    intentsAgree?: boolean;
  }): void {
    counters.replies++;
    bump(counters.repliesByEngine, o.engine);
    if (o.degraded || o.aiStatus === 'ai_unavailable' || o.aiStatus === 'demo_mode') counters.fallbacks++;
    counters.latencySumMs += o.latencyMs;
    counters.latencyCount++;
    if (o.handoff) counters.handoffReplies++;
    for (const t of o.toolsCalled ?? []) {
      counters.toolCalls++;
      if (!t.ok) counters.toolFailures++;
    }
    if (o.detectedIntent) {
      counters.intentTotal++;
      bump(counters.intentCounts, o.detectedIntent);
      if (o.intentsAgree) counters.intentAgreement++;
    }
    if (counters.replies % 10 === 0) {
      recordMetric('ai_replies', { value: counters.replies });
    }
  },

  recordPriceViolation(repaired: boolean): void {
    counters.priceViolations++;
    recordMetric('price_violation', { value: repaired ? 1 : 0 });
  },

  recordCtaRepair(kind: 'cta_repeat' | 'premature_cta'): void {
    if (kind === 'cta_repeat') counters.ctaRepairs++;
    else counters.prematureCta++;
  },

  snapshot(): AiQualitySnapshot {
    return {
      replies: counters.replies,
      repliesByEngine: { ...counters.repliesByEngine },
      fallbacks: counters.fallbacks,
      fallbackRatePct: pct(counters.fallbacks, counters.replies),
      toolCalls: counters.toolCalls,
      toolFailures: counters.toolFailures,
      toolSuccessRatePct: counters.toolCalls > 0 ? pct(counters.toolCalls - counters.toolFailures, counters.toolCalls) : 100,
      handoffs: counters.handoffReplies,
      handoffRatePct: pct(counters.handoffReplies, counters.replies),
      intentTotal: counters.intentTotal,
      intentCounts: { ...counters.intentCounts },
      intentAgreementTotal: counters.intentAgreement,
      intentAgreementPct: pct(counters.intentAgreement, counters.intentTotal),
      priceViolations: counters.priceViolations,
      ctaRepairs: counters.ctaRepairs,
      prematureCta: counters.prematureCta,
      avgLatencyMs: counters.latencyCount > 0 ? Math.round(counters.latencySumMs / counters.latencyCount) : 0,
    };
  },
};
