/**
 * طبقة الشخصية والتفاعل — ما يجعل الرد يبدو من إنسان ذكي لا من نموذج.
 *
 * تُستخدم من المنسّق والمحرك والـ prompt: الاسم، الوقت، مؤشر الكتابة،
 * التفاعل الذكي، والأزرار السريعة.
 */

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
export function fallbackQuickReplies(intent?: string): QuickReply[] {
  switch (intent) {
    case 'تحية':
    case 'عام':
      return [
        { id: 'qr:prices', title: 'الأسعار والباقات' },
        { id: 'qr:recommend', title: 'أنصحني بباقة' },
        { id: 'qr:activate', title: 'أبدأ التفعيل' },
      ];
    case 'استفسار_أسعار':
    case 'استفسار_باقات':
      return [
        { id: 'qr:starter', title: 'الأساسية 149₪' },
        { id: 'qr:pro', title: 'الاحترافية 299₪' },
        { id: 'qr:enterprise', title: 'المؤسسات 799₪' },
      ];
    case 'توصية_باقة':
      return [
        { id: 'qr:activate', title: 'جهز لي التفعيل' },
        { id: 'qr:yearly', title: 'وش توفير السنوي؟' },
        { id: 'qr:human', title: 'أريد موظف' },
      ];
    case 'طلب_تفعيل':
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
    default:
      return [];
  }
}

/** هل النص يبدو تأكيدًا/موافقة؟ */
export function isAffirmative(text: string): boolean {
  const t = (text ?? '').trim().toLowerCase();
  return /^(تمام|تم|ايه|أيوه|أيوا|ايوه|اي|نعم|يب|يبى|يلا|هيا|أبشر|ابشر|موافق|ماشي|أوكي|اوكي|ok|okay|yes|sure|yep|👍|🔥)([!.؟\s]*)$/i.test(t)
    || /^(أبغى|ابي|أريد|اريد|خلينا نبدأ|يلا نبدأ)/i.test(t);
}
