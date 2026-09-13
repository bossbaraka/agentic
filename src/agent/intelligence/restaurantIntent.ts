/**
 * Restaurant Operations Intent Classification — deterministic, no LLM.
 * Supports Arabic, Palestinian Arabic, English, Arabizi.
 * Intents: INFORMATION, ANALYTICS, OPERATIONS, RECOMMENDATIONS, ACTIONS, SUPPORT, UNKNOWN/AMBIGUOUS
 */

export type RestaurantIntent =
  | 'INFORMATION' // menu, product, order status, restaurant stats, table status
  | 'ANALYTICS' // best-selling, slow products, peak times, trends, revenue, performance
  | 'OPERATIONS' // pending orders, delayed orders, occupied tables, waiter requests
  | 'RECOMMENDATIONS' // suggest offers, recommend products, menu improvements, operational improvements
  | 'ACTIONS' // update order state, create/update product, modify category, create offer, manage settings
  | 'SUPPORT' // explain how Mureeh works, features, guide managers
  | 'UNKNOWN';

export type RestaurantIntentDetail =
  | 'menu_info'
  | 'product_info'
  | 'order_status'
  | 'restaurant_stats'
  | 'table_status'
  | 'best_selling'
  | 'slow_products'
  | 'peak_times'
  | 'revenue_summary'
  | 'performance'
  | 'pending_orders'
  | 'delayed_orders'
  | 'occupied_tables'
  | 'waiter_requests'
  | 'bill_requested'
  | 'suggest_offer'
  | 'recommend_product'
  | 'menu_improvement'
  | 'operational_improvement'
  | 'update_order'
  | 'create_product'
  | 'update_product'
  | 'delete_product'
  | 'create_category'
  | 'update_category'
  | 'create_offer'
  | 'update_settings'
  | 'explain_feature'
  | 'guide_manager'
  | 'unknown';

export interface RestaurantIntentResult {
  intent: RestaurantIntent;
  detail: RestaurantIntentDetail;
  confidence: 'high' | 'medium' | 'low';
  entities: {
    timeframe?: 'today' | 'week' | 'month' | 'yesterday';
    productName?: string;
    categoryName?: string;
    tableNumber?: number;
    orderId?: string;
    branchName?: string;
  };
  requiresClarification: boolean;
  clarificationQuestion?: string;
  clarificationQuestionAr?: string;
}

interface PatternRule {
  intent: RestaurantIntent;
  detail: RestaurantIntentDetail;
  weight: number;
  patterns: RegExp[];
  timeframe?: RestaurantIntentResult['entities']['timeframe'];
}

const RULES: PatternRule[] = [
  // INFORMATION
  {
    intent: 'INFORMATION',
    detail: 'menu_info',
    weight: 8,
    patterns: [
      /شو\s+المنيو|ما\s+المنيو|عرض\s+المنيو|اعرض\s+المنيو|قائمة\s+الطعام|menu|قائمة\s+الأصناف/i,
      /كم\s+صنف\s+عندنا|عدد\s+الأصناف|اصناف\s+المطعم/i,
    ],
  },
  {
    intent: 'INFORMATION',
    detail: 'product_info',
    weight: 8,
    patterns: [
      /شو\s+سعر\s+.*|كم\s+سعر\s+.*|سعر\s+ال.*|product\s+.*\s+price|معلومات\s+عن\s+صنف|تفاصيل\s+منتج/i,
      /هل\s+.*\s+متوفر|متوفر\s+.*\?|available/i,
    ],
  },
  {
    intent: 'INFORMATION',
    detail: 'order_status',
    weight: 9,
    patterns: [
      /حالة\s+الطلب|وضع\s+الطلب|طلب\s+رقم|order\s+status|order\s+#?\d+|طلب\s+.*\s+وين\s+وصل/i,
      /كم\s+طلب\s+عندنا\s+الآن\?*|عدد\s+الطلبات\s+الآن|current\s+orders|orders\s+now/i,
    ],
  },
  {
    intent: 'INFORMATION',
    detail: 'table_status',
    weight: 8,
    patterns: [
      /حالة\s+الطاولات|وضع\s+الطاولات|طاولة\s+رقم|table\s+status|طاولات\s+مشغولة|طاولات\s+فاضية|available\s+tables|occupied\s+tables/i,
    ],
  },
  {
    intent: 'INFORMATION',
    detail: 'restaurant_stats',
    weight: 7,
    patterns: [
      /احصائيات\s+المطعم|إحصائيات|stats|statistics|ملخص\s+اليوم|أداء\s+اليوم/i,
    ],
  },

  // ANALYTICS
  {
    intent: 'ANALYTICS',
    detail: 'best_selling',
    weight: 10,
    patterns: [
      /أكثر\s+وجبة\s+انطلبت|أكثر\s+صنف\s+انطلب|أكثر\s+صنف\s+مبيعا|أكثر\s+منتج\s+مبيعا|أكثر\s+الأصناف\s+مبيعا|best\s+selling|top\s+selling|most\s+ordered/i,
      /شو\s+أكثر\s+صنف|شو\s+اكثر\s+وجبة|اكثر\s+شي\s+انباع|اكثر\s+شي\s+مبيعا/i,
    ],
  },
  {
    intent: 'ANALYTICS',
    detail: 'slow_products',
    weight: 10,
    patterns: [
      /الأصناف\s+اللي\s+مبيعاتها\s+ضعيفة|منتجات\s+ضعيفة|slow\s+products|أقل\s+مبيعا|أقل\s+الأصناف|منتجات\s+ما\s+بتنباع/i,
      /ما\s+هي\s+المنتجات\s+اللي\s+تحتاج\s+تعديل\s+سعر|منتجات\s+تحتاج\s+تعديل|التي\s+تحتاج\s+تعديل\s+سعر/i,
    ],
  },
  {
    intent: 'ANALYTICS',
    detail: 'peak_times',
    weight: 8,
    patterns: [
      /أكثر\s+فترة\s+ضغط|ساعات\s+الذروة|peak\s+times|peak\s+hours|أوقات\s+الذروة|متى\s+أكثر\s+طلبات/i,
    ],
  },
  {
    intent: 'ANALYTICS',
    detail: 'revenue_summary',
    weight: 9,
    patterns: [
      /كم\s+المبيعات\s+اليوم|مبيعات\s+اليوم|revenue\s+today|مجموع\s+المبيعات|إيرادات\s+اليوم|sales\s+today/i,
      /كم\s+دخلنا\s+اليوم|قديش\s+بعنا\s+اليوم/i,
    ],
  },
  {
    intent: 'ANALYTICS',
    detail: 'performance',
    weight: 8,
    patterns: [
      /ملخص\s+أداء\s+المطعم|أداء\s+المطعم|performance\s+report|تقرير\s+أداء|تحليل\s+أداء|حلل\s+أداء/i,
      /اعمللي\s+تقرير\s+عن\s+أداء|اعطيني\s+تقرير/i,
    ],
  },

  // OPERATIONS
  {
    intent: 'OPERATIONS',
    detail: 'pending_orders',
    weight: 10,
    patterns: [
      /كم\s+طلب\s+عندنا\s+الآن|طلبات\s+معلقة|pending\s+orders|طلبات\s+قيد\s+الانتظار|طلبات\s+لم\s+تبدأ/i,
      /شو\s+في\s+طلبات\s+جديدة|طلبات\s+جديدة/i,
    ],
  },
  {
    intent: 'OPERATIONS',
    detail: 'delayed_orders',
    weight: 10,
    patterns: [
      /هل\s+في\s+طلبات\s+متأخرة|طلبات\s+متأخرة|delayed\s+orders|طلبات\s+تأخرت|ليش\s+الطلبات\s+متأخرة|الطلبات\s+تتأخر/i,
      /طلبات\s+بطيئة|slow\s+orders|متأخر/i,
    ],
  },
  {
    intent: 'OPERATIONS',
    detail: 'occupied_tables',
    weight: 9,
    patterns: [
      /طاولات\s+مشغولة|كم\s+طاولة\s+مشغولة|occupied\s+tables|طاولات\s+فيها\s+زباين/i,
    ],
  },
  {
    intent: 'OPERATIONS',
    detail: 'waiter_requests',
    weight: 9,
    patterns: [
      /طلبات\s+النادل|استدعاء\s+النادل|waiter\s+requests|نداء\s+النادل|كم\s+واحد\s+طالب\s+النادل/i,
    ],
  },
  {
    intent: 'OPERATIONS',
    detail: 'bill_requested',
    weight: 10,
    patterns: [
      /أي\s+طاولة\s+طلبت\s+الحساب|طاولات\s+طالبة\s+الحساب|طاولة\s+طلبت\s+الحساب|طاولات\s+طلبت\s+الفاتورة|bill\s+requested|طلبت\s+الحساب|طالبة\s+الحساب/i,
    ],
  },

  // RECOMMENDATIONS
  {
    intent: 'RECOMMENDATIONS',
    detail: 'suggest_offer',
    weight: 9,
    patterns: [
      /اقترحلي\s+عرض|اقترح\s+عرض|اقتراح\s+عرض|suggest\s+offer|اعمل\s+عرض|بدي\s+اعمل\s+عرض/i,
    ],
  },
  {
    intent: 'RECOMMENDATIONS',
    detail: 'recommend_product',
    weight: 8,
    patterns: [
      /اقترح\s+منتج|توصية\s+منتج|recommend\s+product|شو\s+أضيف\s+على\s+المنيو/i,
    ],
  },
  {
    intent: 'RECOMMENDATIONS',
    detail: 'menu_improvement',
    weight: 8,
    patterns: [
      /تحسين\s+المنيو|تطوير\s+المنيو|menu\s+improvement|كيف\s+أحسن\s+المنيو/i,
    ],
  },
  {
    intent: 'RECOMMENDATIONS',
    detail: 'operational_improvement',
    weight: 8,
    patterns: [
      /تحسين\s+العمليات|كيف\s+أحسن\s+الأداء|operational\s+improvement|ليش\s+المطبخ\s+عليه\s+ضغط|kitchen\s+overload/i,
    ],
  },

  // ACTIONS
  {
    intent: 'ACTIONS',
    detail: 'update_order',
    weight: 9,
    patterns: [
      /حدث\s+حالة\s+الطلب|غير\s+حالة\s+الطلب|update\s+order\s+status|الطلب\s+جاهز|الطلب\s+تم\s+تقديمه/i,
      /احذف\s+الطلب|الغي\s+الطلب|cancel\s+order/i,
    ],
  },
  {
    intent: 'ACTIONS',
    detail: 'create_product',
    weight: 9,
    patterns: [
      /أنشئ\s+منتج|أضف\s+منتج|create\s+product|اضافة\s+صنف|أضف\s+صنف\s+جديد/i,
    ],
  },
  {
    intent: 'ACTIONS',
    detail: 'update_product',
    weight: 8,
    patterns: [
      /عدل\s+سعر\s+.*|غير\s+سعر\s+.*|update\s+product|تعديل\s+منتج|حدث\s+سعر/i,
    ],
  },
  {
    intent: 'ACTIONS',
    detail: 'create_offer',
    weight: 8,
    patterns: [
      /أنشئ\s+عرض|اعمل\s+عرض\s+جديد|create\s+offer|عرض\s+جديد/i,
    ],
  },

  // SUPPORT
  {
    intent: 'SUPPORT',
    detail: 'explain_feature',
    weight: 7,
    patterns: [
      /كيف\s+يعمل\s+.*|شرح\s+.*|how\s+does\s+.*\s+work|اشرحلي\s+.*|ما\s+هو\s+.*\?|what\s+is/i,
    ],
  },
];

function extractTimeframe(text: string): RestaurantIntentResult['entities']['timeframe'] {
  const lower = text.toLowerCase();
  if (/اليوم|today|النهارده|اليوم/i.test(lower)) return 'today';
  if (/هذا\s+الأسبوع|هذا\s+الاسبوع|this\s+week|الأسبوع/i.test(lower)) return 'week';
  if (/هذا\s+الشهر|this\s+month|الشهر/i.test(lower)) return 'month';
  if (/امبارح|أمس|yesterday/i.test(lower)) return 'yesterday';
  return undefined;
}

function extractTableNumber(text: string): number | undefined {
  const match = text.match(/طاولة\s+رقم\s*(\d+)|table\s+#?(\d+)|طاولة\s+(\d+)/i);
  if (match) {
    const numStr = match[1] || match[2] || match[3];
    const num = Number(numStr);
    if (Number.isInteger(num) && num > 0 && num < 1000) return num;
  }
  return undefined;
}

function extractOrderId(text: string): string | undefined {
  const match = text.match(/(?:طلب|order)\s*(?:رقم\s*)?#?([A-Z0-9-]{4,20})/i);
  if (match) return match[1];
  return undefined;
}

export function classifyRestaurantIntent(rawText: string): RestaurantIntentResult {
  const text = (rawText || '').trim();
  if (!text) {
    return {
      intent: 'UNKNOWN',
      detail: 'unknown',
      confidence: 'low',
      entities: {},
      requiresClarification: true,
      clarificationQuestion: 'Could you please clarify what you need?',
      clarificationQuestionAr: 'ممكن توضح شو بتحتاج بالضبط؟',
    };
  }

  const scores = new Map<string, { rule: PatternRule; score: number }>();

  for (const rule of RULES) {
    let best = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        best = Math.max(best, rule.weight);
      }
    }
    if (best > 0) {
      const key = `${rule.intent}:${rule.detail}`;
      scores.set(key, { rule, score: best });
    }
  }

  const ranked = Array.from(scores.values()).sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    // Check for ambiguous "شو أكثر صنف؟"
    if (/شو\s+أكثر\s+صنف|أكثر\s+صنف|اكثر\s+صنف/i.test(text) && !extractTimeframe(text)) {
      return {
        intent: 'ANALYTICS',
        detail: 'best_selling',
        confidence: 'medium',
        entities: {},
        requiresClarification: true,
        clarificationQuestion: 'Do you mean best selling today, this week, or this month?',
        clarificationQuestionAr: 'تقصد الأكثر مبيعاً اليوم، هذا الأسبوع، أم هذا الشهر؟',
      };
    }

    return {
      intent: 'UNKNOWN',
      detail: 'unknown',
      confidence: 'low',
      entities: {},
      requiresClarification: true,
      clarificationQuestion: 'I did not understand. Could you rephrase?',
      clarificationQuestionAr: 'ما فهمت طلبك، ممكن توضح أكثر؟',
    };
  }

  const top = ranked[0];
  const secondScore = ranked[1]?.score ?? 0;
  const confidence: 'high' | 'medium' | 'low' =
    top.score >= 9 && top.score - secondScore >= 2 ? 'high' : top.score >= 7 ? 'medium' : 'low';

  const timeframe = extractTimeframe(text);
  const tableNumber = extractTableNumber(text);
  const orderId = extractOrderId(text);

  // Ambiguity detection for best-selling without timeframe
  let requiresClarification = false;
  let clarificationQuestion: string | undefined;
  let clarificationQuestionAr: string | undefined;

  if (top.rule.detail === 'best_selling' && !timeframe) {
    // If query is exactly "شو أكثر صنف؟" without timeframe, ask clarification
    if (/^شو\s+أكثر\s+صنف[؟?]?$|^اكثر\s+صنف[؟?]?$|شو\s+أكثر\s+وجبة[؟?]?$|^شو\s+أكثر\s+صنف$/i.test(text.trim())) {
      requiresClarification = true;
      clarificationQuestion = 'Do you mean best selling today, this week, or this month?';
      clarificationQuestionAr = 'تقصد الأكثر مبيعاً اليوم، هذا الأسبوع، أم هذا الشهر؟';
    }
  }

  return {
    intent: top.rule.intent,
    detail: top.rule.detail,
    confidence,
    entities: {
      timeframe,
      tableNumber,
      orderId,
    },
    requiresClarification,
    clarificationQuestion,
    clarificationQuestionAr,
  };
}

// For combined intent with existing sales intents
export function isRestaurantOperationalQuery(text: string): boolean {
  const result = classifyRestaurantIntent(text);
  return result.intent !== 'UNKNOWN' && result.confidence !== 'low';
}
