import { config } from '../config.js';
import { knowledge } from '../lib/knowledge.js';
import { nowHuman } from '../lib/utils.js';
import type { BotMode } from '../config.js';
import type { RestaurantProfile, LaunchState } from '../types.js';
import { missingRequired, nextQuestion } from './onboarding.js';
import { formatAvailabilityText } from './bookings.js';
import { TOOL_DECLARATIONS } from './tools.js';
import { CORE_AGENT_POLICY } from './prompts/corePolicy.js';
import { CONVERSATION_POLICY } from './prompts/conversationPolicy.js';
import { SALES_POLICY } from './prompts/salesPolicy.js';
import { SAFETY_POLICY, toolPolicyIntro } from './prompts/safetyPolicy.js';

/**
 * بناء الـ System Prompt — تركيب طبقي بمعامل إشارة/ضوضاء عالٍ.
 *
 * الطبقات:
 *   CORE_AGENT_POLICY   الهوية والدقة والتحويل (دائمًا)
 *   CONVERSATION_POLICY الأسلوب والذاكرة والأزرار (دائمًا)
 *   SALES_POLICY        منهج البيع الاستشاري (في وضع النشاط)
 *   SAFETY_POLICY       الحمايات (دائمًا)
 *   TOOL_POLICY         قواعد الأدوات (عند تفعيلها) — قائمة الأدوات تُولَّد
 *                       من TOOL_DECLARATIONS نفسها (مصدر واحد للحقيقة)
 *   BRAND/KNOWLEDGE     قاعدة المعرفة (ملفات قابلة للتحرير بدون كود)
 *   CURRENT_CONTEXT     جلسة العميل + ذاكرته + تحليله الحتمي + سياسة مرحلته
 *   OUTPUT_CONTRACT     عقد JSON (ثابت — المحرك يعتمد عليه)
 *
 * قواعد الوضع (business/hybrid/assistant) تُحقن ككتلة «دورك» مختصرة —
 * النسخة القديمة كانت تكرر قواعد الذاكرة والـ CTA في 4 مواضع متضاربة.
 */

const OUTPUT_CONTRACT = `
# صيغة الإخراج (إلزامية)
أجب دائمًا بكائن JSON صحيح فقط، بدون أي نص قبله أو بعده، وبدون أسوار كود (backticks) ولا تضمين داخل نص برمجي.
{
  "reply_parts": ["نص الرسالة الأولى", "نص الرسالة الثانية (اختياري)"],
  "quick_replies": [{"id": "qr:prices", "title": "الأسعار"}, {"id": "qr:activate", "title": "أبدأ التفعيل"}],
  "handoff": false,
  "handoff_reason": "سبب التحويل لبشري إن وجد، وإلا سلسلة فارغة",
  "intent": "تصنيف قصير لنية العميل (مثال: استفسار_أسعار، حجز، شكوى، تحية، دعم_فني)",
  "sentiment": "positive" | "neutral" | "negative"
}

قواعد reply_parts:
- استخدم 1–2 عناصر للسؤال البسيط، و2–4 عناصر للشرح الواسع أو التفعيل أو الاعتراض. حد أقصى {{MAX_PARTS}} عناصر.
- كل عنصر رسالة دردشة مستقلة ومفهومة وحدها، وطولها أقل من {{MAX_CHARS}} حرفًا.
- قسّم الرد لعدة عناصر عند وجود شرح ثم خطوة تالية/سؤال؛ لا تقسّم جملة واحدة.
- لا ترسل عناصر فارغة. إن لم يكن هناك ما يقال أرجع reply_parts: [].

قواعد quick_replies:
- مصفوفة من 0 إلى 3 عناصر. إن لم تناسب أزرار، أرجع [] أو احذف الحقل.
- id قصير لاتيني/رقمي (مثال: qr:pro). title عربي مختصر ≤ 20 حرفًا.
`.trim();

const ROLE_BUSINESS = `
# دورك في وضع النشاط
وجه فريق {{BUSINESS_NAME}} على الدردشة: تُجيب بدقة عن منظومة المطاعم (باقات 300/550/850، مزايا، تجهيز، أمان) وعن الخدمات الرقمية (موقع، واتساب، وكيل ذكاء، حجوزات، سوشال — سعرها حسب الطلب). توصي بالباقة الأنسب من بيانات حقيقية، تقود المستعد للتفعيل بجمع بياناته سؤالًا واحدًا في كل رد (ملف ← تصور ← تأكيد ← يصل مدير المنصة)، وتدعم المشتركين وتحوّل ما يتجاوز صلاحياتك بثقة.
`.trim();

const ROLE_ASSISTANT = `
# دورك في وضع المساعد
مساعد ذكي يدير المحادثة نيابة عن صاحب الرقم. الفائدة أولًا بلا حشو، والالتزامات والمواعيد والمواضيع المالية الحساسة تُحوّل لصاحب الرقم (handoff=true).
`.trim();

const ROLE_HYBRID = `
# دورك في الوضع المزدوج
حديث عن منتجات/أسعار/حجوزات/دعم {{BUSINESS_NAME}}؟ تصرّف كمستشار النشاط والتزم بمعلوماته حرفيًا.
حديث عام (سؤال ثقافي، صياغة نص، دردشة)؟ أجب بذكاء وإيجاز وروح ثم اربط بلطف إن ناسب.
اختلط الأمران؟ ابدأ بالأهم لعميل النشاط ثم أكمل الباقي. في الطبي/القانوني/المالي الحساس: إرشاد عام فقط + تحويل لمختص.
`.trim();

/** توليد قائمة الأدوات من TOOL_DECLARATIONS — مصدر واحد للحقيقة */
export function toolListText(): string {
  const lines: string[] = [];
  for (const group of TOOL_DECLARATIONS) {
    for (const fn of (group as any).functionDeclarations ?? []) {
      const desc = String(fn.description ?? '').split(/[.\n]/)[0]!.trim();
      const req: string[] = fn.parameters?.required ?? [];
      const props = Object.keys(fn.parameters?.properties ?? {});
      const args = props.length
        ? ` (${props.map((p) => (req.includes(p) ? `${p} مطلوب` : `${p} اختياري`)).join('، ')})`
        : ' (بدون معطيات)';
      lines.push(`- ${fn.name}: ${desc}${args}`);
    }
  }
  return lines.join('\n');
}

export interface SystemPromptContext {
  mode: BotMode;
  customerName: string;
  customerNumber: string;
  sessionLanguage: string;
  summary: string;
  toolsEnabled: boolean;
  profile?: RestaurantProfile;
  launch?: LaunchState;
  /** آخر رسالة للبوت؛ تساعد النموذج على متابعة السؤال بدل فتح الحوار من جديد */
  lastAssistantMessage?: string;
  /**
   * CURRENT_CONTEXT الحتمي من طبقة الذكاء: نية مرصودة، مرحلة البيع،
   * ألم معروف، اعتراض قائم، نقاط جودة، حالة عائد — أسطر جاهزة تُحقن كما هي.
   */
  intelligenceBlock?: string;
}

/** بناء الـ system prompt النهائي لجلسة معينة */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const roleBlock =
    ctx.mode === 'business' ? ROLE_BUSINESS :
    ctx.mode === 'assistant' ? ROLE_ASSISTANT : ROLE_HYBRID;

  const isBusinessMode = ctx.mode !== 'assistant';

  const vars: Record<string, string> = {
    BOT_NAME: config.bot.BOT_NAME,
    BUSINESS_NAME: config.bot.BUSINESS_NAME,
    MAX_PARTS: String(config.bot.MAX_REPLY_PARTS),
    MAX_CHARS: String(config.bot.MAX_SEGMENT_CHARS),
  };
  const fill = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);

  // ── CURRENT_CONTEXT: الذاكرة المعروفة ──
  const profile = ctx.profile ?? {};
  const launch = ctx.launch;
  const knownFacts: string[] = [];
  if (profile.full_name || ctx.customerName) knownFacts.push(`• اسم العميل: ${profile.full_name || ctx.customerName}`);
  if (profile.restaurant_name) knownFacts.push(`• المطعم/المقهى: ${profile.restaurant_name}`);
  if (profile.city) knownFacts.push(`• المدينة: ${profile.city}`);
  if (profile.tables) knownFacts.push(`• الطاولات: ${profile.tables} (مؤكدة — لا يُسأل عنها أبدًا)`);
  if (profile.branches) knownFacts.push(`• الفروع: ${profile.branches}`);
  if (profile.preferred_plan) knownFacts.push(`• الباقة المختارة/المعروضة: ${profile.preferred_plan}`);
  if (profile.menu_items) knownFacts.push(`• الأصناف التقريبية: ${profile.menu_items}`);
  if (profile.has_logo !== undefined) knownFacts.push(`• الشعار: ${profile.has_logo ? 'جاهز لدى العميل' : 'غير جاهز'}`);
  if (launch?.orderRef) knownFacts.push(`• الطلب: مؤكد (${launch.orderRef}) — المتابعة مع الإدارة، ممنوع أسئلة تفعيل جديدة`);
  if (profile.notes) knownFacts.push(`• ملاحظات: ${profile.notes}`);

  const missing = missingRequired(profile);
  const memoryBlock = knownFacts.length > 0
    ? `# ذاكرة العميل (سجل ملزم — لا يُعاد السؤال عن أي بند فيها)\n${knownFacts.join('\n')}\n- الناقص فقط: ${missing.length ? missing.join('، ') : 'لا شيء — انتقل للتصور أو الخطوة التالية'}\n- السؤال التالي إن كنا فعلاً في مسار التفعيل فقط: ${nextQuestion(profile) ?? 'لا تسأل — أجب عن طلب العميل مباشرة'}`
    : `# ذاكرة العميل\nلا بيانات مؤكدة بعد. خزّن كل معلومة جديدة فور ذكرها ولا تسأل عنها ثانية.\n- السؤال الأول المسموح (فقط في مسار التفعيل): ${nextQuestion(profile) ?? 'أجب عن الطلب مباشرة'}`;

  const summaryBlock = ctx.summary
    ? `# ملخص ما سبق في المحادثة\n${ctx.summary}`
    : '# ملخص المحادثة\n(بداية محادثة أو أُعيد تصفيرها — لا ملخص سابق.)';

  const intelligence = ctx.intelligenceBlock?.trim()
    ? `# تحليل الجلسة الحالي (حتمي من النظام — اتبعه)\n${ctx.intelligenceBlock.trim()}`
    : '';

  const toolBlock = ctx.toolsEnabled
    ? toolPolicyIntro(toolListText())
    : '';

  return fill(`
${roleBlock}

# سياق الجلسة
- اسم العميل: ${ctx.customerName || 'غير معروف'}
- المعرّف: ${ctx.customerNumber}
- لغة الجلسة: ${ctx.sessionLanguage}
- الآن: ${nowHuman()} — منطقة النشاط: Asia/Jerusalem (التزم بها في أي موعد)
- ساعات فريق الحجز (المصدر الوحيد للتوفر): ${formatAvailabilityText()}

${CORE_AGENT_POLICY}

${CONVERSATION_POLICY}

${isBusinessMode ? SALES_POLICY : ''}

${SAFETY_POLICY}

${toolBlock}

${memoryBlock}

${summaryBlock}

${intelligence}

${ctx.lastAssistantMessage ? `# آخر رد صادر منك (تابع منه ولا تكرره ولا تعِد أسئلته)\n${ctx.lastAssistantMessage.slice(-1500)}` : ''}

# معلومات النشاط (المصدر الموثوق الوحيد — ما ليس هنا غير متوفر لديك)

${knowledge.render()}

${OUTPUT_CONTRACT}
`.replace(/\n{3,}/g, '\n\n').trim());
}

/** prompt مختصر لمهام التلخيص (يستخدم النموذج السريع) */
export function buildSummaryPrompt(existingSummary: string): string {
  return `
أنت ملخّص محادثات. لخص المحادثة التالية في نص عربي مكثّف (أقصى 120 كلمة) يحفظ فقط:
- اسم العميل وأي بيانات تعريفية ذكرها
- ما الذي يريده تحديدًا
- ما الذي تم الاتفاق عليه أو تنفيذه فعلًا
- أي التزامات أو مواعيد معلّقة
- حالة العميل الانفعالية إن كانت لافتة
- الباقة/عدد الطاولات/المدينة إن ذُكرت
- أي اعتراض أو تردد ذكره

لا تضف معلومات غير موجودة. لا تستخدم تعدادًا نقطيًا طويلًا — اكتب فقرة أو نقطتين.

${existingSummary ? `الملخص السابق (ادمجه ولا تكرره):\n${existingSummary}\n` : ''}
`.trim();
}
