/**
 * مصنّف النوايا الحتمي — بلا LLM، قابل للاختبار 100%.
 *
 * يعمل على نص العميل (عربي عامي/فصيح، إنجليزي، عبري) + سياق خفيف
 * (آخر سؤال للبوت، هل البيانات التجارية معروفة). القواعد مرجّحة،
 * وعند غياب الإشارات يعيد `unclear` بدل التخمين — فالمحادثة
 * تسأل توضيحًا واحدًا ذكيًا بدل الرد الخاطئ الواثق.
 */
import type { Intent, IntentConfidence, IntentResult } from './types.js';

interface Rule {
  intent: Intent;
  weight: number;
  patterns: RegExp[];
}

/** تسهيل كتابة الأحرف العربية بلا مشاكل تطبيع */
const A = '\\u0621-\\u064A';

/** قواعد مصنّفة — الترتيب لا يهم (الترجيح بالأوزان).
 *  ⚠️ كل الأنماط مكتوبة بصلامط مطبَّع: ا لا أ/إ/آ — ه لا ة — ي لا ى/ئ — و لا ؤ */
const RULES: Rule[] = [
  // ── طلب بشري / شكوى / دعم — أعلى أولوية أمنية ──
  {
    intent: 'human_request', weight: 9,
    patterns: [
      /(?:بشري|انسان|حدا منكم|حد حقيقي|تكلم(?:وا)? مع(?:ه|ي)? واحد|بدي موظف|مع موظف|موظف منكم|احكي مع موظف|اتكلم مع موظف|مع مدير|كلم المدير|بدي احكي مع حد)/i,
      /human|real person|agent|staff|manager/i,
      /(נציג|אנושי)/,
    ],
  },
  {
    intent: 'complaint', weight: 9,
    patterns: [
      /(?:سيئه|سيء|زعلان|مقرف|كارثه|فظيع|مخزي|احتيال|استرداد|ارجع فلوسي|اسخف|اسوا|محتال|نصب)/i,
      /terrible|awful|refund|scam|worst/i,
    ],
  },
  {
    intent: 'support', weight: 7,
    patterns: [
      /(?:مش شغال|مش شغاله|ما شغاله|مو شغال|مو شغاله|ما تشتغل|ما بتشتغل|ما ظهر|ما تظهر|ما وصل|موصلش|خطا|ايرور|error|عطل|تعطل|معطل|ما اقدر ادخل|انحظر|ما يفتح|مش راضي|انحذف|ضاع الطلب|الشاشه سودا|بطيء كثير|ما بظهر|ما بيجي كل شيء)/i,
      /(?:مشكله تقني|مشكله في النظام|في مشكله|عندي مشكله|ساعدوني|محتاج مساعده|بدي مساعده في)/i,
      /not working|broken|bug|crash|cant login|can't login/i,
    ],
  },
  {
    intent: 'technical_question', weight: 5,
    patterns: [
      /(?:كيف تعمل|كيف يعمل|كيف يشتغل|كيف بيشتغل|كيف تشتغل|كيف يتم|هل يحتاج انترنت|المزامنه|يدعم|متوافق مع|يدمج|ربط مع|تكامل|مزامنه|(?:عندكم|في|هل) api|api للمطورين)/i,
      /how does it work|integration|compatible|does it support/i,
    ],
  },

  // ── نية الشراء والتفعيل ──
  {
    intent: 'purchase_intent', weight: 8,
    patterns: [
      /(?:بدي اشترك|ابغى اشترك|اريد الاشتراك|بدي الاشتراك|نبدأ التفعيل|ابدا التفعيل|نبدأ التفعيل|بدي افعل|ابغى تفعيل|بدي اجرب|اجربوا|جهز لي|جهزلى|خلينا نبدأ|خلينا نجهزها|يلا نشترك|مستعد اشترك|قررت اشترك|عايز اشترك|عاوز اشترك|سجلني|ثبت لي|فعلني|اكد الطلب|تاكيد الطلب|نثبت على|ابدا اشتراك)/i,
      /(?:رجعت|كملت).{0,20}(?:اكمل|كمل|نكمل|اشترك|الاشتراك|التفعيل)|بدي اكمل|اكمل معكم|نكمل الاشتراك|بدي اكمل الاشتراك/i,
      /subscribe|sign me up|let'?s start|i want to buy|activate(?: me)?/i,
    ],
  },

  // ── الاعتراضات ──
  {
    intent: 'objection_price', weight: 8,
    patterns: [
      /(?:غالي|غاليه|مرتفع|كثير على|اكتر من ميزانيتي|ميزانيه|ميزانيتي|مكلف|تكلفتها عاليه|كبير عليا|كتير عليا|كثير عليا|كتير شوي|بكسر حالي|خساره فلوس|(?:شيكل|جنيه|درهم|ريال|دولار)\s*(?:كتير|كثير))/i,
      /expensive|too much|pricey|over budget/i,
    ],
  },
  {
    intent: 'objection_value', weight: 7,
    patterns: [
      /(?:ما في فايده|شو بتجيب لي|شو الفايده|مو محتاجها|ما بحتاج|لشو|ليش اشترك|شو بيفرق|ما بظن|مو مقتنع|غير مقتنع|شو رح تستفيدني|فين العايد|شو بتفيدني|وين الفايده|ما شايف فايده)/i,
      /don'?t need|not convinced|what'?s the (?:value|benefit|point)/i,
    ],
  },
  {
    intent: 'objection_trust', weight: 7,
    patterns: [
      /(?:ما بثق|مو واثق|مش واثق|خايف اتحايل|هل هو امن|(?:بياناتي|زبايني).{0,25}(?:امنه|امان|محميه)|شرعي|هل الكلام صحيح|كلام صحيح ولا|تسويقات|مضمونيه|ضمان|مو متاكد منكم)/i,
      /don'?t trust|not sure (?:about )?you|is it safe/i,
    ],
  },
  {
    intent: 'objection_complexity', weight: 7,
    patterns: [
      /(?:معقد|معقده|صعب|صعبه|صعب عليا|موظفين كبار|موظفيني|كبار بالسن|كبار السن|ما بفهم تقنيه|ما بفهم بالتقنيه|مو تقني|موظفين ما بيفهموا|خايف من التعقيد|كيف الموظفين|بياخد وقت كثير|ما بعرف استخدمه|ما بعرف اشتغل عليه)/i,
      /too complicated|hard to use|my staff/i,
    ],
  },
  {
    intent: 'objection_timing', weight: 6,
    patterns: [
      /(?:خليني افكر|خلي افكر|بفكر|بعدين|لاحقا|مش هلق|مش هالوقت|مو الان|الشهر الجاي|بعد العيد|ليش الاستعجال|مش متاكد|لسه بفكر|دعني افكر|خليني افكر)/i,
      /let me think|maybe later|not right now|need time/i,
    ],
  },
  {
    intent: 'competitor_comparison', weight: 7,
    patterns: [
      /(?:المنافس|منافسين|عندي نظام|نظام ثاني|نظام تاني|شغال على|شريك ثاني|في نظم ثانيه|نظام ثاني عندي)/i,
      /competitor|other (?:system|platform)|compared to/i,
    ],
  },

  // ── الحجوزات (مواعيد التفعيل) ──
  {
    intent: 'booking_cancellation', weight: 8,
    patterns: [
      /(?:الغاء الحجز|الغي حجز|الغاء الموعد|الغي الموعد|بدي الغي|بدي الغاء)/i,
      /cancel (?:my )?(?:booking|appointment)/i,
    ],
  },
  {
    intent: 'booking_modification', weight: 8,
    patterns: [
      /(?:تعديل الحجز|اعدل حجز|اغير موعد|غير موعد|اجل الموعد|اجل الحجز|باجل موعدي|عدل موعدي|نقل الموعد|أأجل)/i,
      /(?:change|reschedule|move) (?:my )?(?:booking|appointment)/i,
    ],
  },
  {
    intent: 'booking', weight: 7,
    patterns: [
      /(?:حجز|احجز|بحجز|موعد|مواعيد|اقرب موعد|احجزلي|احجز لي|متاح وقت|ساعه فارغه|موعد تفعيل|كيف احجز)/i,
      /book(?:ing)?|appointment|available slot/i,
    ],
  },

  // ── التسعير والمقارنة والتوصية ──
  {
    intent: 'pricing', weight: 7,
    patterns: [
      /(?:قديش|اديش|بكم|كم السعر|شو السعر|شو اسعار|الاسعار|الأسعار|سعر|اسعار|التكلفه|بكاش|الدفع|اشتراك بكم|كم تشترك|قديش الاشتراك|السعر النهائي|رسوم|باقاتكم|شو الباقات|ايش الباقات|قائمه الباقات)/i,
      /(?:price|cost|pricing|how much)/i,
    ],
  },
  {
    intent: 'plan_comparison', weight: 8,
    patterns: [
      /(?:شو الفرق|ايه الفرق|وش الفرق|مقارنه|قارن|الفرق بين|افضل باقه|اي باقه افضل|اي وحده احسن|شو احسن|الفرق بين الباقات)/i,
      /difference|compare|which (?:plan|one) is better/i,
    ],
  },
  {
    intent: 'recommendation', weight: 6,
    patterns: [
      /(?:انصحني|انصحني بباقه|شو تنصح|شو بتنصح|ايش تنصح|وش تنصح|اي باقه تناسب|شو المناسب لي|الباقه المناسبه|اي وحده تناسبني|نصحني)/i,
      /(?:what do you recommend|recommend me|which plan suits|suggest)/i,
    ],
  },

  // ── مؤهلات المطعم (بيانات تجارية) ──
  {
    intent: 'restaurant_qualification', weight: 6,
    patterns: [
      /(?:عندي مطعم|لدي مطعم|عندي كافيه|عندي مقهى|عندي كفيه|مطعم كبير|عندي فرع|عندي فرعين|عندي فروع|سلسله مطاعم|عندي محل شاورما|عندي بيتزا|عندي منيو|عدد طاولاتي|طاولاتي|مطعمي)/i,
      /(?:\d{1,4}\s*(?:طاوله|طاولات|فرع|فروع|صنف|اصناف))/,
      /i (?:have|own) a restaurant|my (?:cafe|restaurant)|(?:\d+\s*tables)/i,
    ],
  },
  {
    intent: 'feature_question', weight: 6,
    patterns: [
      /(?:شو المزايا|ايش المزايا|مزايا|الميزات|ميزات|وش تحصل|شو يشمل|شو تشمل|ايش تشمل|شو تتضمن|شو الخدمات اللي|هل فيه|هل يدعم المنيو|هل يدعم شاشه|الشاشه|شاشه المطبخ|kds|pos|كاشير|منيو qr|استدعاء النادل|هل احتاج|هل يمكنني|هل يقدر|هل تقدروا|تقييم|تقارير|تحليلات|شعار|هويه|ترقيه|الغاء|اشتراك سنوي|توفير سنوي|خصم)/i,
      /features|include|what do i get|upgrade|discount|report|dashboard/i,
    ],
  },
  {
    intent: 'product_information', weight: 4,
    patterns: [
      /(?:شو عندكم|ايش عندكم|وش عندكم|شو هو مريح|شو هي مريح|عرفني|احكيلي عن|ممكن تشرح|اشرح لي|شو حلولكم|خدماتكم|شو بتقدموا|بماذا تساعدون|شو قصتكم|من منتجاتكم)/i,
      /what do you (?:offer|have)|tell me about|your services/i,
    ],
  },
  {
    intent: 'service_information', weight: 4,
    patterns: [
      /(?:موقع|مواقع|تصميم|وكيل ذكاء|ذكاء اصطناعي|تطوير|برمجه|خدمات رقميه|اداره تواصل|حلول مخصصه|احجزوا لي خدمه|الخدمات الرقميه)/i,
      /website design|digital services|custom (?:solution|development)/i,
    ],
  },
  {
    intent: 'onboarding', weight: 6,
    patterns: [
      /(?:بعد الاشتراك|كيف يبدأ|خطوات التفعيل|كيف يتم التفعيل|اعداد|التجهيز|شو الخطوات|ملف المطعم|تصور الاطلاق|onboarding|اعداد الحساب|كيف نبدأ الشغل)/i,
      /how do (?:we|i) (?:start|set up)|setup process|onboarding/i,
    ],
  },
  {
    intent: 'existing_customer', weight: 5,
    patterns: [
      /(?:انا مشترك|انا عميل|مشترك عندكم|لدي اشتراك|اشتراكي|حسابي عندكم|سجلت عنكم مسبقا)/i,
      /i'?m (?:already )?(?:a )?(?:subscriber|customer|member)/i,
    ],
  },

  // ── تحية ──
  {
    intent: 'greeting', weight: 3,
    patterns: [
      /(?:^|\s)(?:هلا|هلا والله|اهلا|اهلا وسهلا|مرحبا|مرحبتين|سلام|السلام|صباح الخير|مساء الخير|كيفك|كيف حالك|شخبارك|عامل ايه|منور|هاي|هلو|يا هلا|مسا الخير|هلا بيك)/i,
      /(?:^|\s)(hi|hello|hey|good (?:morning|evening)|whats up|what'?s up)/i,
    ],
  },
];

/** كلمات عامة تلغي تحية صريحة عندما يوجد سؤال حقيقي في نفس الرسالة */
const REAL_QUESTION = /(?:سعر|اسعار|بكم|قديش|باقه|باقات|طاول|اشترك|تفعيل|حجز|موعد|مشكله|دعم|كيف (?:بدي|ابغى|ارد|اقدر|احصل|احجز|اشترك|اشتراك|افعل)|شو الفرق|انصح|فرع|منيو|كاشير|مطبخ)/i; // مطبَّع

export interface ClassifyContext {
  /** آخر رسالة صادرة من البوت — تفسر الأجوبة القصيرة («25») */
  lastBotMessage?: string;
  /** هل لدى العميل بيانات تجارية محفوظة (مطعم/طاولات/باقة)؟ */
  hasKnownBusiness?: boolean;
  /** مرحلة الحالة الحالية — تأثير على ترجيح الأجوبة القصيرة */
  stage?: string;
  launchConfirmed?: boolean;
  hasActiveBooking?: boolean;
}

/**
 * تصنيف نية نص واحد أو دفعة مدمجة.
 * يعيد `unclear` بثقة منخفضة إذا لم تتوفر إشارات كافية — لا تخمين.
 *
 * مهم: النص يُطبَّع أولًا (همزات→ا، ة→ه، ى→ي)، لذلك كل الأنماط أدناه
 * مكتوبة بصلامط مطبَّع (بدون أ إ آ ة ى ئ ؤ) — أي حرف منها في نمط = خطأ صامت.
 */
export function classifyIntent(rawText: string, ctx: ClassifyContext = {}): IntentResult {
  const text = normalize(rawText);
  const scores = new Map<Intent, number>();

  if (!text.trim()) {
    return { intent: 'unclear', confidence: 'low', candidates: [] };
  }

  for (const rule of RULES) {
    let best = 0;
    for (const p of rule.patterns) {
      if (p.test(text)) best = Math.max(best, rule.weight);
    }
    if (best > 0) scores.set(rule.intent, best);
  }

  // رسالة قصيرة جدًا («تمام»، «25»، «أحمد») — تُفسَّر بآخر سؤال للبوت،
  // لكن فقط إذا لم تحمل الرسالة إشارة نيّة واضحة بنفسها («550 غالي» ليس جواب موضع).
  const shortAnswer = text.length <= 24 && !/[؟?]/.test(text);
  if (shortAnswer && scores.size === 0 && ctx.lastBotMessage) {
    const lastQ = normalize(ctx.lastBotMessage);
    const topic = shortAnswerTopic(lastQ);
    if (topic) {
      const mapped: Record<string, Intent> = {
        tables: 'restaurant_qualification',
        restaurant: 'restaurant_qualification',
        city: 'restaurant_qualification',
        name: 'restaurant_qualification',
        plan: 'purchase_intent',
        confirm: 'purchase_intent',
        booking_time: 'booking',
        booking_service: 'booking',
      };
      return {
        intent: mapped[topic] ?? 'unclear',
        confidence: 'medium',
        candidates: [{ intent: mapped[topic] ?? 'unclear', score: 4 }],
      };
    }
  }

  // تحية + سؤال حقيقي = السؤال يتقدم
  if (scores.has('greeting') && REAL_QUESTION.test(text)) {
    scores.set('greeting', 1);
  }

  // رد رقم مجرد («25») — تأهيل تجاري، ويُفسَّر في سياق آخر سؤال
  if (/^\s*\d{1,4}\s*$/.test(text)) {
    return {
      intent: 'restaurant_qualification',
      confidence: 'medium',
      candidates: [{ intent: 'restaurant_qualification', score: 4 }],
    };
  }

  const ranked = [...scores.entries()]
    .map(([intent, score]) => ({ intent, score }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return { intent: 'unclear', confidence: 'low', candidates: [] };
  }

  const top = ranked[0]!;
  const second = ranked[1]?.score ?? 0;
  const confidence: IntentConfidence =
    top.score >= 7 && top.score - second >= 2 ? 'high'
    : top.score >= 5 ? 'medium'
    : top.score - second >= 3 ? 'medium'
    : 'low';

  if (confidence === 'low') {
    return { intent: 'unclear', confidence, candidates: ranked };
  }

  return { intent: top.intent, confidence, candidates: ranked };
}

/** تطبيع خفيف: توحيد همزات/تاء مربوطة وإزالة التشكيل وتكرار الحروف */
export function normalize(text: string): string {
  return (text ?? '')
    .replace(/[\u064B-\u0652\u0670]/g, '')        // تشكيل
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d) >= 0 ? '٠١٢٣٤٥٦٧٨٩'.indexOf(d) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/(.)\1{2,}/g, '$1$1')                 // حروف ممددة («هلاااا»)
    .replace(/\s+/g, ' ')
    .trim();
}

/** استنتاج موضوع آخر سؤال للبوت (لتفسير الأجوبة القصيرة) */
function shortAnswerTopic(lastBotMessage: string): string | null {
  const t = lastBotMessage;
  if (/طاول|tables/i.test(t)) return 'tables';
  if (/اسم المطعم|اسم الكافيه|اسم المقهى/i.test(t)) return 'restaurant';
  if (/مدينه|بأي مدينه|city/i.test(t)) return 'city';
  if (/اسمك|الاسم/i.test(t)) return 'name';
  if (/نثبت|تاكيد الطلب|تثبيت الباقه|اي باقه/i.test(t)) return 'confirm';
  if (/بأي وقت يناسبك|اي وقت يناسبك|اي ساعه|اي يوم|الوقت المناسب/i.test(t)) return 'booking_time';
  if (/على اي باقه|باقه نحجز|لاي خدمه/i.test(t)) return 'booking_service';
  return null;
}
