/**
 * طبقة الشخصية والتفاعل — ما يجعل الرد يبدو من إنسان ذكي لا من نموذج.
 *
 * تُستخدم من المنسّق والمحرك والـ prompt: الاسم، الوقت، مؤشر الكتابة،
 * التفاعل الذكي، والأزرار السريعة.
 */

import type { RestaurantProfile } from '../types.js';

export interface QuickReply {
  id: string;
  title: string;
}

/** أول اسم صالح للنداء — يتجاهل الأرقام ومفاتيح الجلسة */
export function firstNameOf(full: string | undefined | null): string {
  const n = (full ?? '').trim();
  if (!n) return '';
  if (n.startsWith('tg:')) return '';
  if (/^\+?\d[\d\s-]{6,}$/.test(n)) return '';
  if (/^(غير معروف|unknown)$/i.test(n)) return '';
  const first = n.split(/\s+/)[0] ?? '';
  return first.length >= 2 ? first : '';
}

export type DayPart = 'صباح' | 'ظهر' | 'مساء' | 'ليل';

export function dayPart(tz = 'Asia/Jerusalem'): DayPart {
  let hour = 12;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()),
    );
  } catch {
    hour = new Date().getHours();
  }
  if (hour >= 5 && hour < 12) return 'صباح';
  if (hour >= 12 && hour < 17) return 'ظهر';
  if (hour >= 17 && hour < 22) return 'مساء';
  return 'ليل';
}

export function greetingWord(part: DayPart = dayPart()): string {
  if (part === 'صباح') return 'صباح الخير';
  if (part === 'ظهر') return 'نهارك سعيد';
  if (part === 'مساء') return 'مساء الخير';
  return 'يا هلا';
}

/**
 * تأخير طبيعي قبل إرسال كل جزء — يحاكي الكتابة البشرية.
 * ~16ms/حرف، بحد أدنى 320ms وأقصى 1.6 ثانية.
 */
export function typingDelayMs(text: string): number {
  const n = (text ?? '').length;
  // إيقاع بشري خفيف بدون إبطاء الرد أكثر من نصف ثانية
  return Math.min(520, Math.max(160, 100 + n * 5));
}

/**
 * تفاعل إيموجي على رسالة العميل.
 * الشكاوى بلا تفاعل (احترام). الباقي خفيف وغير متكلّف.
 */
export function pickInboundReaction(body: string): string {
  const t = (body ?? '').trim().toLowerCase();
  if (!t || t.startsWith('[')) return '';
  if (/سيئة|زعلان|مقرف|استرداد|كارثة|فظيع|awful|terrible|refund|غاضب|احتيال/.test(t)) return '';
  if (/شكر|thanks|thx|ممتاز|رائع|عافية/.test(t)) return '🙌';
  if (/هلا|اهلا|أهلًا|مرحبا|سلام|صباح|مساء|hi\b|hello|hey/.test(t)) return '👋';
  if (/اشترك|أشترك|تفعيل|أبدأ|ابدأ|يلا نبدأ/.test(t)) return '🔥';
  if (/سعر|أسعار|باقة|باقات|بكم|تكلف|price|plan/.test(t)) return '💡';
  if (/مساعدة|help|دعم|مشكلة/.test(t)) return '👀';
  if (t.length <= 40) return '👍';
  return '';
}

/** قصّ عناوين الأزرار لحد واتساب (20 حرفًا) */
export function clampButtons(buttons: QuickReply[] | undefined | null): QuickReply[] {
  if (!Array.isArray(buttons)) return [];
  const seen = new Set<string>();
  const out: QuickReply[] = [];
  for (const b of buttons) {
    if (!b?.title) continue;
    const title = String(b.title).replace(/\s+/g, ' ').trim().slice(0, 20);
    const id = String(b.id || title).slice(0, 64);
    if (!title || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title });
    if (out.length >= 3) break;
  }
  return out;
}

/** أزرار احتياطية ذكية حسب النية — إذا النموذج نسي quick_replies */
/** أزرار احتياطية ذكية حسب النية ومعرفة العميل — إذا النموذج نسي quick_replies */
export function fallbackQuickReplies(intent?: string, profile?: RestaurantProfile): QuickReply[] {
  // إذا تم اختيار الباقة أو تأكيد الطلب، فلا داعي لأزرار الأسعار واقتراح الباقة العامة
  const hasPlan = Boolean(profile?.preferred_plan);
  const hasTables = Boolean(profile?.tables && profile.tables > 0);

  switch (intent) {
    case 'تحية':
    case 'عام':
      if (hasPlan || hasTables) {
        return [
          { id: 'qr:activate', title: 'أكمل التفعيل' },
          { id: 'qr:human', title: 'أريد موظف' },
        ];
      }
      return [
        { id: 'qr:prices', title: 'الأسعار والباقات' },
        { id: 'qr:digital', title: 'خدمات رقمية' },
        { id: 'qr:recommend', title: 'أنصحني بباقة' },
      ];
    case 'استفسار_خدمات':
    case 'خدمة_رقمية':
      return [
        { id: 'qr:website', title: 'موقع إلكتروني' },
        { id: 'qr:whatsapp', title: 'وكيل واتساب' },
        { id: 'qr:booking-sys', title: 'نظام حجوزات' },
      ];
    case 'استفسار_أسعار':
    case 'استفسار_باقات':
      return [
        { id: 'qr:starter', title: 'الأساسية 300₪' },
        { id: 'qr:pro', title: 'الاحترافية 550₪' },
        { id: 'qr:enterprise', title: 'المؤسسات 850₪' },
      ];
    case 'توصية_باقة':
      return [
        { id: 'qr:activate', title: 'جهز لي التفعيل' },
        { id: 'qr:yearly', title: 'وش توفير السنوي؟' },
        { id: 'qr:human', title: 'أريد موظف' },
      ];
    case 'اعتراض_سعري':
    case 'مقارنة_وضع_حالي':
      if (hasPlan || hasTables) {
        return [
          { id: 'qr:starter', title: 'الأساسية 300₪' },
          { id: 'qr:activate', title: 'أبدأ التفعيل' },
          { id: 'qr:human', title: 'أريد موظف' },
        ];
      }
      return [
        { id: 'qr:recommend', title: 'أنصحني بباقة' },
        { id: 'qr:prices', title: 'الأسعار والباقات' },
        { id: 'qr:activate', title: 'أبدأ التفعيل' },
      ];
    case 'طلب_تفعيل':
      if (hasPlan) {
        return [
          { id: 'qr:confirm', title: 'تأكيد الطلب' },
          { id: 'qr:edit', title: 'تعديل' },
        ];
      }
      return [
        { id: 'qr:pro', title: 'الاحترافية' },
        { id: 'qr:starter', title: 'الأساسية' },
        { id: 'qr:enterprise', title: 'المؤسسات' },
      ];
    case 'إيجابي':
      return [
        { id: 'qr:activate', title: 'أبدأ التفعيل' },
        { id: 'qr:prices', title: 'الباقات' },
      ];
    case 'تأكيد_طلب':
      return [
        { id: 'qr:confirm', title: 'تأكيد الطلب' },
        { id: 'qr:edit', title: 'تعديل' },
      ];
    case 'تجهيز_إطلاق':
    case 'بيانات_تفعيل':
      // جمع التفاصيل أسئلة مفتوحة (اسم/مدينة/عدد) — الأزرار هنا نشاز
      return [];
    default:
      return [];
  }
}

/**
 * هل تنتهي الرسالة بسؤال مفتوح يطلب كتابة حرة (اسم/مدينة/عدد/وصف)؟
 * في هذه الحالة أي أزرار ستكون نشازًا — تُحذف كلها.
 */
export function endsWithOpenQuestion(text: string): boolean {
  const tail = (text ?? '').trim().slice(-160);
  if (!tail) return false;
  // سؤال صريح بعلامة استفهام يطلب معلومة حرة
  if (/؟\s*$/.test(tail) && /(اسم|الاسم|مدينة|بأي|كم|عدد|رقم|هاتف|جوال|مشكلة|صِف|صف|اشرح|وضّح|وضح|التفاصيل|تفاصيل|عنوان|شعار|صنف|فرع)/.test(tail)) {
    return true;
  }
  // صيغ طلب مباشرة بدون علامة استفهام
  if (/(شو اسمك|واسم المطعم|اسم المطعم|بأي مدينة|كم طاولة|كم فرع|أرسل|ابعت|اكتب)\s*؟?\s*$/.test(tail)) {
    return true;
  }
  return false;
}

/** كلمات مفتاحية لمعنى الزر (لمطابته مع النص) */
function buttonKeywords(b: QuickReply): string[] {
  const id = (b.id || '').toLowerCase();
  const t = (b.title || '').toLowerCase();
  const words: string[] = [];
  if (/confirm/.test(id) || /تأكيد|أكّد/.test(t)) words.push('تأكيد', 'أكّد', 'تمام');
  if (/ثبت/.test(t)) words.push('ثبت');
  if (/edit|modify/.test(id) || /تعديل|غيّر|غير/.test(t)) words.push('تعديل', 'غيّر', 'تغيير');
  if (/prices|starter|pro|enterprise/.test(id) || /باق|سعر|أسعار|أساسية|احترافية|مؤسسات|300|550|850/.test(t)) words.push('باق', 'سعر', 'أسعار', 'أساسية', 'احترافية', 'مؤسسات');
  if (/activate/.test(id) || /تفعيل|اشتر|ابدأ|أبدأ|نبدأ/.test(t)) words.push('تفعيل', 'اشتر', 'ابدأ', 'نبدأ', 'أجهّز');
  if (/recommend/.test(id) || /أنصح|الأنسب/.test(t)) words.push('أنصح', 'أنسب', 'طاولة');
  if (/digital|website|whatsapp|booking-sys/.test(id) || /رقمي|موقع|واتساب|حجوزات/.test(t)) words.push('رقمي', 'موقع', 'واتساب', 'حجوزات', 'خدم');
  if (/yearly/.test(id) || /سنوي|توفير/.test(t)) words.push('سنوي', 'توفير');
  if (/human/.test(id) || /موظف|بشري/.test(t)) words.push('موظف', 'بشري', 'فريق');
  return words;
}

/**
 * ضمان اتساق الأزرار مع المكتوب — الأزرار امتداد للجملة الأخيرة فقط:
 * 1. تحويل لبشري ← بلا أزرار (الموظف يستلم، والأزرار تشوّش)
 * 2. سؤال مفتوح (اسم/عدد/وصف) ← بلا أزرار
 * 3. تكرار أزرار الرسالة السابقة ← بلا أزرار لمنع تكرار نفس الأزرار
 * 4. أزرار مقترحة ← تُحذف التي لا يذكر النص معناها (باستثناء زر التعديل/الموظف كبديل آمن)
 * 5. لا أزرار مقترحة ← بدائل النية إن كان النص يسمح ولم تكن مكررة
 */
export function coherentQuickReplies(
  lastText: string,
  proposed: QuickReply[] | undefined | null,
  intent?: string,
  handoff = false,
  profile?: RestaurantProfile,
  lastOutboundButtons?: string[],
): QuickReply[] {
  const text = (lastText ?? '').toLowerCase();

  if (handoff) return [];
  if (endsWithOpenQuestion(lastText)) return [];

  const filterConsecutiveDuplicate = (buttons: QuickReply[]): QuickReply[] => {
    if (!lastOutboundButtons || lastOutboundButtons.length === 0 || buttons.length === 0) return buttons;
    const currentTitles = buttons.map((b) => b.title.trim()).sort().join('|');
    const lastTitles = [...lastOutboundButtons].map((t) => t.trim()).sort().join('|');
    // إذا كانت نفس الأزرار المعروضة في الرسالة السابقة تمامًا، نحذفها منعًا للتكرار الممل
    if (currentTitles === lastTitles) return [];
    return buttons;
  };

  const safe = clampButtons(proposed);
  if (safe.length > 0) {
    const kept = safe.filter((b) => {
      const id = (b.id || '').toLowerCase();
      // زرّا التعديل والموظف بديلان آمنان دائمًا (خروج من المأزق)
      if (/qr:(edit|human)/.test(id)) return true;
      const keys = buttonKeywords(b);
      if (keys.length === 0) return true; // زر غير مصنّف — نثق بالنموذج
      return keys.some((k) => text.includes(k));
    });
    // لو النص يعرض خيارين صريحين (A ولا B) نحتفظ بالمطابق فقط
    if (/ولا| أو | أم /.test(text) && kept.length > 0) return filterConsecutiveDuplicate(kept.slice(0, 3));
    if (kept.length > 0) return filterConsecutiveDuplicate(kept);
    // كل المقترح لا يمتّ للنص بصلة ← الأفضل بلا أزرار من أزرار نشاز
    return [];
  }

  const fallbacks = fallbackQuickReplies(intent, profile);
  return filterConsecutiveDuplicate(fallbacks);
}

/**
 * رد دافئ للحالات النادرة جدًا التي يتعذّر فيها توليد أي رد.
 * القاعدة: لا لغة أعطال باردة («خلل تقني») — بل اعتراف بشري خفيف
 * + طريق مختصر + سؤال واحد يُبقي المحادثة حيّة.
 * (ملاذ أخير فقط — المسار الطبيعي يردّ دائمًا من Gemini أو الاحتياطي المحلي.)
 */
export function pickWarmFallbackReply(seed = Date.now()): { text: string; buttons: QuickReply[] } {
  const variants: { text: string; buttons: QuickReply[] }[] = [
    {
      text: 'وصلتني رسالتك 👍 عشان أخدمك بأسرع وقت: تبي *باقات تشغيل المطعم*، ولا *خدمة رقمية* (موقع / واتساب / حجوزات)؟',
      buttons: [
        { id: 'qr:prices', title: 'الأسعار والباقات' },
        { id: 'qr:digital', title: 'خدمات رقمية' },
        { id: 'qr:recommend', title: 'أنصحني بباقة' },
      ],
    },
    {
      text: 'تمام، شفت رسالتك. خلّينا نختصر الطريق: كم طاولة تشتغل عندك؟ وأعطيك التوصية الدقيقة بالأسعار الرسمية.',
      buttons: [
        { id: 'qr:prices', title: 'الأسعار والباقات' },
        { id: 'qr:activate', title: 'أبدأ التفعيل' },
      ],
    },
    {
      text: 'معك 🙏 أرسل طلبك بكلمات أبسط وأنا أرد عليك فورًا — أو اختر من هنا ونكمّل خطوة بخطوة.',
      buttons: [
        { id: 'qr:recommend', title: 'أنصحني بباقة' },
        { id: 'qr:human', title: 'أريد موظف' },
      ],
    },
  ];
  return variants[Math.abs(seed) % variants.length];
}

/** هل النص يبدو تأكيدًا/موافقة؟ */
export function isAffirmative(text: string): boolean {
  const t = (text ?? '').trim().toLowerCase();
  return /^(تمام|تم|ايه|أيوه|أيوا|ايوه|اي|نعم|يب|يبى|يلا|هيا|أبشر|ابشر|موافق|ماشي|أوكي|اوكي|ok|okay|yes|sure|yep|👍|🔥)([!.؟\s]*)$/i.test(t)
    || /^(أبغى|ابي|أريد|اريد|خلينا نبدأ|يلا نبدأ)/i.test(t);
}
