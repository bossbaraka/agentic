/**
 * الاعتراضات — رصد صريح وحتمي لحالات: السعر، القيمة، الثقة، التعقيد، التأجيل.
 *
 * الاعتراض ≠ رفض. الحالة تُحفظ حتى لا يكرر الوكيل نفس الحجة، وتُوجّه
 * سياسة الرد: اعترف ← افهم السبب ← اربط بالقيمة ← بديل مناسب إن وجد
 * ← بلا ضغط.
 */
import { classifyIntent, normalize } from './intent.js';
import type { ObjectionHit, ObjectionKind } from './types.js';

export interface ObjectionPolicy {
  kind: ObjectionKind;
  /** ما يجب فعله (داخلي — يُحقن كتوجيه لا كنص للعميل) */
  approach: string;
  /** ما يجب تجنبه */
  avoid: string;
}

const POLICIES: Record<ObjectionKind, ObjectionPolicy> = {
  price: {
    kind: 'price',
    approach:
      'اعترف بالاعتراض طبيعيًا، ثم قسّط السعر على الطاولات/الأيام بالأرقام الرسمية فقط، واذكر التوفير السنوي، وإن كان الاحتياج أساسيًا فقط فهذا منطق الباقة الأساسية — اعرض الأرخص إذا ناسب الاحتياج. سؤال واحد في النهاية كحد أقصى.',
    avoid: 'لا تجادل، لا تكرر نفس الحجة، لا تطلب الاشتراك مباشرة، ولا تَعِد بخصم.',
  },
  value: {
    kind: 'value',
    approach:
      'افهم ما الذي يفتقده من القيمة: اسأل عن أكبر ألم تشغيلي واربطه بنتيجة ملموسة واحدة (طلب يوصل المطبخ فورًا / حسابات آخر اليوم تلقائية). لا تسرد الكتالوج.',
    avoid: 'لا تلح، لا تعد سرد المزايا كاملًا، لا تتجاهل سؤاله.',
  },
  trust: {
    kind: 'trust',
    approach:
      'اعترف بحقه في التحقق. اذكر الحقائق الملموسة فقط: بدون بطاقة للبدء، إلغاء/ترقية مرنة، عزل بيانات كل مطعم، وعروض تجريبية مع الفريق. اعرض حجز موعد تعارف قصير مع الفريق.',
    avoid: 'لا تبالغ بالوعود ولا تقول «مضمون 100%» ولا تضغط.',
  },
  complexity: {
    kind: 'complexity',
    approach:
      'طمئنه بالواقع: يعمل على أجهزته الحالية بدون معدات، التفعيل خلال دقائق، والفريق يجهز كل شيء معه خطوة بخطوة وحسابات الطاقم بدخول PIN بسيط لكل موظف.',
    avoid: 'لا تدفنه بالمزايا التقنية ولا تطلب قراءة مستندات.',
  },
  timing: {
    kind: 'timing',
    approach:
      'احترم تردده بدون إلحاح: اترك الباب مفتوحًا بسؤال خفيف واحد عما الذي سيحسم قراره (السعر؟ التجربة؟ رأي شريكه؟) — وإن كان الألم حاضرًا ذكّره بلطف بثمن الانتظار بأرقام تقديرية فقط.',
    avoid: 'لا تكرر CTA في نفس الرسالة، لا عدّادات كاذبة ولا «آخر فرصة».',
  },
  competitor: {
    kind: 'competitor',
    approach:
      'احترم اختياره الحالي واسأل عن أكبر ألم فيه، ثم اربطه بميزة تحلّه بالضبط. لا تشهّر بالمنافسين ولا تختلق مقارنات أسعار — مقارناتنا من مزايا مكتوبة فقط.',
    avoid: 'لا تسب المنافس، لا تخترع أسعارهم، لا تطلب الإلغاء الفوري من غيره.',
  },
};

const OBJECTION_INTENTS: Partial<Record<string, ObjectionKind>> = {
  objection_price: 'price',
  objection_value: 'value',
  objection_trust: 'trust',
  objection_complexity: 'complexity',
  objection_timing: 'timing',
  competitor_comparison: 'competitor',
};

/**
 * رصد الاعتراضات في نص العميل. يعيد قائمة (قد تكون أكثر من نوع واحد
 * في رسالة واحدة: «غالي ومعقد»).
 */
export function detectObjections(text: string): ObjectionHit[] {
  const t = normalize(text);
  if (!t) return [];
  const r = classifyIntent(t);
  const hits: ObjectionHit[] = [];
  for (const c of r.candidates) {
    const kind = OBJECTION_INTENTS[c.intent];
    if (kind && !hits.some((h) => h.kind === kind)) hits.push({ kind });
  }
  return hits.slice(0, 2);
}

export function objectionPolicy(kind: ObjectionKind): ObjectionPolicy {
  return POLICIES[kind]!;
}

export const OBJECTION_LABELS_AR: Record<ObjectionKind, string> = {
  price: 'السعر مرتفع',
  value: 'لم يرَ القيمة بعد',
  trust: 'تحفظ في الثقة',
  complexity: 'خوف من التعقيد',
  timing: 'تأجيل / أحتاج أفكر',
  competitor: 'يقارن بنظام آخر',
};
