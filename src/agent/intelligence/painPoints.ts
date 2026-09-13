/**
 * ذكاء نقاط الألم — يفهم المشكلة خلف سؤال العميل.
 *
 * «النادل عندي بتأخر كثير» ليست سؤال ميزات — إنها ألم تشغيلي له
 * حل معروف في المنصة وسؤال تأهيل منطقي. هذا الملف يحوّل العبارات
 * الطبيعية (بالعامية والفصحى) إلى {ألم، حل، سؤال التأهيل التالي}.
 * الاستدلال نفسه لا يُعرض للعميل — فقط النتيجة المفيدة.
 */
import { normalize } from './intent.js';
import type { PainPoint, PainPointHit } from './types.js';

interface PainRule {
  pain: PainPoint;
  solution: PainPointHit['solution'];
  qualificationQuestion: string;
  patterns: RegExp[];
}

/** قواعد الألم — ⚠️ كلها بصلامط مطبَّع (ا لا أ/إ/آ — ه لا ة — ي لا ى/ئ) على نص مطبَّع */
const RULES: PainRule[] = [
  {
    pain: 'slow_waiter',
    solution: 'waiter_requests',
    qualificationQuestion: 'التأخير أكثر وقت الذروة ولا على طول؟',
    patterns: [
      /(?:نادل|النادل|الجرسون|الويتر).{0,20}(?:بطيء|تاخر|بيتاخر|متاخر|بطي|ما بيجي|ما بيرد|ما بيلحق|زحمه)/i,
      /(?:بطيء|تاخير|بيتاخر|متاخر).{0,20}(?:نادل|الخدمه|الطلبات|التقديم)/i,
      /(?:الزباين|الزبائن).{0,20}(?:ينادون|ينادو|بيدوروا على النادل|عم ينادوا)/i,
      /waiter.{0,20}(?:slow|late|never)/i,
    ],
  },
  {
    pain: 'lost_orders',
    solution: 'kds',
    qualificationQuestion: 'كم طلب تقريبًا بيضيع أو بينخلط باليوم وقت الذروة؟',
    patterns: [
      /(?:طلبات|الطلبات|اوردرات).{0,25}(?:تضيع|بتضيع|ضاعت|بينخلط|تنخلط|ما توصل|ما بتوصل|غلط)/i,
      /ضياع.{0,15}(?:طلبات|اوردار)/i,
      /(?:ورقه|ورق).{0,25}(?:تضيع|بتضيع|ضاعت|كتير)/i,
      /(?:الجرسون|النادل).{0,20}(?:بينسي|ينسي|نسي)/i,
      /(?:lost|missing).{0,15}orders?/i,
    ],
  },
  {
    pain: 'kitchen_delays',
    solution: 'kds',
    qualificationQuestion: 'المطبخ بيعرف ترتيب الطلبات لحظة وصولها ولا في تراكم؟',
    patterns: [
      /(?:مطبخ|المطبخ|الكيتشن).{0,25}(?:بطيء|يتاخر|بيتاخر|زدحمه|تراكم|فوضى|فوضه|ما يعرف)/i,
      /الطلبات.{0,20}(?:تتراكم|تراكم|متاخره بالمطبخ)/i,
      /kitchen.{0,20}(?:slow|delay|backed up)/i,
    ],
  },
  {
    pain: 'paper_menu',
    solution: 'qr_menu',
    qualificationQuestion: 'كم مرة بتغير المنيو أو الأسعار بالشهر؟',
    patterns: [
      /(?:منيو|المنيو|قائمه|القائمه|ليسته|الليسته).{0,25}(?:ورق|ورقي|ورقيه|يطبع|نطبع|نغير|تغير|تحديث|قديمه|قديم|مبلله|ممزقه|مكلفه)/i,
      /(?:طباعه|نطبع).{0,20}(?:منيو|قوائم|اسعار)/i,
      /paper menu|printed menu/i,
    ],
  },
  {
    pain: 'manual_accounting',
    solution: 'analytics',
    qualificationQuestion: 'كم وقت بياخذ تسوية حسابات آخر اليوم تقريبًا؟',
    patterns: [
      /(?:حسابات|الحسابات|الحساب).{0,30}(?:يدوي|يدويه|باليد|دفتر|الدفتر|اخر اليوم|تسويه|مش دقيقه|بالورق)/i,
      /(?:اكسل|excel|شيت)/i,
      /اخر اليوم.{0,20}(?:فوضى|تعبان|ساعات|مشاكل)/i,
      /manual (?:accounting|billing)|end of day/i,
    ],
  },
  {
    pain: 'order_errors',
    solution: 'qr_menu',
    qualificationQuestion: 'الأخطاء أكثر من الزحام ولا حتى الأوقات الهادئة؟',
    patterns: [
      /(?:طلبات|الطلبات).{0,25}(?:غلط|بغلط|خاطئه|مكرره|ناقصه|بالتغليط)/i,
      /النادل.{0,20}(?:يكتب غلط|يسجل غلط|بالتغليط)/i,
      /(?:مسببات|مكونات).{0,20}(?:حساسيه|خطا)/i,
      /wrong order|order mistakes/i,
    ],
  },
  {
    pain: 'peak_crowding',
    solution: 'waiter_requests',
    qualificationQuestion: 'وقت الذروة كم زبون تقريبًا بنفس اللحظة؟',
    patterns: [
      /(?:ذروه|زحمه|ازدحام|الجمعه|ويكند|weekend).{0,30}(?:زحمه|ضغط|ما نلحق|ما تلحق|بطء|فوضى|فوضه)/i,
      /(?:وقت الذروه|وقت الزحمه).{0,30}(?:ضيق|تعب|تاخير)/i,
      /(?:ما نلحق|ما نقدر نلحق).{0,20}(?:الطلبات|الزباين|خدمه)/i,
      /rush hour|peak time|too busy/i,
    ],
  },
  {
    pain: 'table_management',
    solution: 'pos',
    qualificationQuestion: 'بتديروا الطاولات على ورقة ولا في طريقة ثانية؟',
    patterns: [
      /(?:طاولات|الطاولات).{0,25}(?:فوضى|فوضه|تتضرب|محجوزه غلط|مش منظم|تنظيم|نسيان)/i,
      /(?:فاتوره|الفاتوره).{0,25}(?:غلط طاوله|على طاوله غلط|تختلط)/i,
      /table management|table chaos/i,
    ],
  },
  {
    pain: 'customer_experience',
    solution: 'qr_menu',
    qualificationQuestion: 'وصلتك شكاوى من الزبائن على الانتظار أو الطلب؟',
    patterns: [
      /(?:الزباين|الزبائن|العملاء).{0,25}(?:يزعلوا|زعلانين|يمشوا|بيمشوا|ما يرجعوا|تشكوى|تشكوا|مش راضيين)/i,
      /(?:تجربه).{0,20}(?:سيئه|ضعيفه|مش حلوه)/i,
      /(?:تقييمات|التقييمات).{0,20}(?:نازله|سيئه)/i,
      /customers (?:leave|complain)|bad reviews/i,
    ],
  },
  {
    pain: 'multi_branch',
    solution: 'multi_branch',
    qualificationQuestion: 'كم فرع عندك حاليًا وكيف بتتابع مبيعات كل واحد؟',
    patterns: [
      /(?:فرعين|ثلاث فروع|عدة فروع|اكتر من فرع|فروع كثيره|سلسله|سلاسل|شبكه مطاعم)/i,
      /(?:متابعه|تسيير|اداره).{0,20}(?:الفروع|كل فرع)/i,
      /multiple (?:branches|locations)|chain of restaurants/i,
    ],
  },
  {
    pain: 'no_website',
    solution: 'website',
    qualificationQuestion: 'الموقع لعرض النشاط، ولا لحجز أو طلب أونلاين؟',
    patterns: [
      /(?:ما عندي موقع|بدون موقع|محتاج موقع|بدي موقع|ابي موقع|موقع قديم|الموقع ضعيف|الموقع بطيء)/i,
      /(?:ما حد يلاقينا|ما بطلع جوجل|ما في صفحه)/i,
      /no website|need a (?:website|site)|outdated (?:website|site)/i,
    ],
  },
  {
    pain: 'missed_messages',
    solution: 'whatsapp_agent',
    qualificationQuestion: 'تقريبًا كم محادثة توصلكم باليوم، وأي قناة أكثر: واتساب ولا إنستغرام؟',
    patterns: [
      /(?:واتساب|الواتس|رسائل).{0,25}(?:ما نرد|ما برد|ما بلحق|بتتراكم|متراكمه|بالليل|ضايعه|ما نلحق)/i,
      /(?:الرسائل|الدرشه|الدرشات).{0,20}(?:كثيره|ما نرد|متراكمه)/i,
      /missed (?:messages|chats)|whatsapp.{0,20}(?:unanswered|overwhelmed)/i,
    ],
  },
  {
    pain: 'social_chaos',
    solution: 'social',
    qualificationQuestion: 'أي منصات نركّز عليها أولًا، وكم منشور تبي بالشهر؟',
    patterns: [
      /(?:انستغرام|انستا|تيك توك|سوشال|التواصل).{0,25}(?:ما ننشر|واقف|فوضى|فوضه|ما حد يدير|محتوى ضعيف)/i,
      /(?:ما عندي وقت).{0,20}(?:انستا|سوشال|محتوى)/i,
      /social media.{0,20}(?:mess|chaos|no time)/i,
    ],
  },
  {
    pain: 'no_booking_system',
    solution: 'booking_system',
    qualificationQuestion: 'الحجوزات لمواعيد خدمة ولا لطاولات/شاليهات؟',
    patterns: [
      /(?:الحجز|الحجوزات|المواعيد).{0,25}(?:ورقه|واتساب|بتتعارض|مزدوج|تنسى|فوضى|فوضه|يدوي)/i,
      /(?:حجزين بنفس|حجز مزدوج|نسينا موعد)/i,
      /double book|no booking system|appointments on whatsapp/i,
    ],
  },
];

/**
 * اكتشاف نقاط الألم في نص العميل — يعيد حتى 3 ألفات مرتبة بالقوة.
 * لا يخترع ألمًا: لا إشارة → قائمة فارغة.
 */
export function detectPainPoints(text: string): PainPointHit[] {
  const t = normalize(text);
  if (!t) return [];
  const hits: PainPointHit[] = [];
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(t))) {
      hits.push({
        pain: rule.pain,
        solution: rule.solution,
        qualificationQuestion: rule.qualificationQuestion,
      });
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

/** وصف عربي قصير للألم (للسجلات وسياق النموذج — لا يُعرض للعميل كما هو) */
export const PAIN_LABELS_AR: Record<PainPoint, string> = {
  slow_waiter: 'تأخر استجابة النادل',
  lost_orders: 'ضياع أو اختلاط الطلبات',
  kitchen_delays: 'تأخر وتراكم المطبخ',
  paper_menu: 'منيو ورقي مكلف للتغيير',
  manual_accounting: 'حسابات يدوية آخر اليوم',
  order_errors: 'أخطاء في الطلبات',
  peak_crowding: 'ضغط وقت الذروة',
  table_management: 'فوضى إدارة الطاولات',
  customer_experience: 'تجربة زبائن ضعيفة',
  multi_branch: 'إدارة فروع متعددة',
  no_website: 'لا موقع / حضور ضعيف أونلاين',
  missed_messages: 'رسائل واتساب بلا رد',
  social_chaos: 'منصات تواصل بلا إدارة',
  no_booking_system: 'حجوزات يدوية أو متعارضة',
};
