import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { extractJson, log, retry, sanitizeForJson, sleep } from '../lib/utils.js';
import type { MediaPart } from '../types.js';
import { TOOL_DECLARATIONS, runTool, type ToolContext, type ToolResult } from './tools.js';
import { getPlan, MUREEH_PLANS, recommendPlan } from './plans.js';

/**
 * محرك الذكاء: يغلّف Gemini ويحوّل الرد الخام إلى بنية مضبوطة.
 *
 * - يبني سجل المحادثة بصيغة Gemini Contents
 * - يمرر الوسائط كـ inlineData (صور/صوت/فيديو/PDF)
 * - ينفّذ استدعاءات الدوال (Function Calling) في حلقة حتى يستقر الرد
 * - يفكّ JSON الخارج من النموذج بشكل متسامح (لو خرج نص عادي، نتعامل معه)
 */

/** رسالة في السجل كما تُمرَّر للنموذج */
export interface Turn {
  role: 'user' | 'model';
  text: string;
  media?: MediaPart[];
}

export interface AgentInput {
  systemPrompt: string;
  turns: Turn[];
  toolsEnabled: boolean;
  toolContext: ToolContext;
  /** يُضاف كسطر سياق إضافي قبل رسالة المستخدم (مثل حالة المحادثة) */
  extraContext?: string;
}

export interface AgentOutput {
  parts: string[];
  handoff: boolean;
  reason?: string;
  intent?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  toolsCalled: { name: string; args: Record<string, unknown>; result: unknown }[];
  /** إجراءات جانبية تطلبها الأدوات (تنبيه بشري، إرسال ملف...) */
  sideEffects: { kind: string; payload: Record<string, unknown>; tool: string }[];
  usage: { promptTokens: number; candidatesTokens: number };
  model: string;
  engine: 'gemini' | 'mock';
  rawText: string;
}

// ─────────────────────────── بناء Contents ───────────────────────────

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function turnToContent(turn: Turn): GeminiContent {
  const parts: GeminiPart[] = [];

  for (const m of turn.media ?? []) {
    if (m.data) {
      parts.push({ inlineData: { mimeType: m.mimeType, data: m.data } });
    } else if (m.note) {
      parts.push({ text: m.note });
    }
  }

  if (turn.text) parts.push({ text: turn.text });
  if (parts.length === 0) parts.push({ text: '(رسالة فارغة)' });

  return { role: turn.role, parts };
}

/**
 * دمج رسائل المستخدم المتتالية في رسالة واحدة.
 * Gemini يرفض أحيانًا تتابع دورين بنفس الـ role، وعملاء واتساب
 * يرسلون 3 رسائل متتالية بشكل طبيعي جدًا.
 */
function normalizeTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];

  for (const t of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) {
      prev.text = prev.text ? `${prev.text}\n${t.text}` : t.text;
      prev.media = [...(prev.media ?? []), ...(t.media ?? [])];
    } else {
      out.push({ ...t, media: t.media ? [...t.media] : undefined });
    }
  }

  // يجب أن يبدأ السجل بدور user
  while (out.length && out[0].role === 'model') out.shift();

  return out;
}

// ─────────────────────────── فكّ استجابة النموذج ───────────────────────────

interface ParsedReply {
  ok: boolean;
  parts: string[];
  handoff: boolean;
  reason?: string;
  intent?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
}

function parseAgentJson(text: string): ParsedReply {
  const json = extractJson(text);

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, any>;

    // الحالة النظامية
    let rawParts = o.reply_parts ?? o.replyParts ?? o.reply ?? o.response ?? o.parts;
    if (typeof rawParts === 'string') rawParts = [rawParts];
    if (!Array.isArray(rawParts)) rawParts = [];

    const parts = rawParts
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .map((p: string) => sanitizeForJson(p).trim())
      .filter((p: string) => p.length > 0);

    return {
      ok: true,
      parts,
      handoff: Boolean(o.handoff ?? o.needs_human ?? o.escalate),
      reason: typeof o.handoff_reason === 'string' ? o.handoff_reason : undefined,
      intent: typeof o.intent === 'string' ? o.intent : undefined,
      sentiment: ['positive', 'neutral', 'negative'].includes(o.sentiment) ? o.sentiment : undefined,
    };
  }

  if (Array.isArray(json)) {
    const parts = json.map((x: any) => (typeof x === 'string' ? x : String(x))).filter(Boolean);
    return { ok: true, parts, handoff: false };
  }

  // النموذج تجاهل صيغة JSON — نتعامل مع النص كما هو (أفضل من الفشل)
  const fallback = sanitizeForJson(text).trim();
  if (!fallback) return { ok: false, parts: [], handoff: false };
  return { ok: false, parts: [fallback], handoff: false };
}

// ─────────────────────────── المحرك ───────────────────────────

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: config.gemini.API_KEY,
      // BASE_URL يسمح بالاختبار ضد خادم محاكٍ أو تمرير الطلبات عبر وسيط
      ...(config.gemini.BASE_URL ? { httpOptions: { baseUrl: config.gemini.BASE_URL } } : {}),
    } as any);
  }
  return client;
}

/** استدعاء واحد مع مهلة زمنية */
async function callGemini(
  contents: GeminiContent[],
  systemInstruction: string,
  toolsEnabled: boolean,
): Promise<any> {
  const ai = getClient();

  const params: Record<string, any> = {
    model: config.gemini.MODEL,
    contents,
    config: {
      systemInstruction,
      temperature: config.gemini.TEMPERATURE,
      maxOutputTokens: config.gemini.MAX_OUTPUT_TOKENS,
      candidateCount: 1,
      ...(config.gemini.THINKING_BUDGET !== 0 ? { thinkingConfig: { thinkingBudget: config.gemini.THINKING_BUDGET } } : {}),
    },
  };

  if (toolsEnabled) {
    params.config.tools = TOOL_DECLARATIONS as any;
  } else if (config.gemini.JSON_MODE) {
    // بدون أدوات → نفرض JSON لتقليل أخطاء التحليل
    params.config.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gemini.TIMEOUT_MS);
  try {
    return await (ai.models.generateContent as any)({ ...params, abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * توليد الرد.
 * ينفّذ حلقة استدعاء الدوال حتى يعود النموذج برد نصي نهائي.
 */
export async function generateReply(input: AgentInput): Promise<AgentOutput> {
  const started = Date.now();

  if (!config.gemini.API_KEY) {
    return mockReply(input, started);
  }

  const turns = normalizeTurns(input.turns);

  // حقن سياق إضافي في آخر رسالة مستخدم
  if (input.extraContext && turns.length) {
    const last = turns[turns.length - 1];
    if (last.role === 'user') last.text = `${input.extraContext}\n\n${last.text}`;
  }

  const contents: GeminiContent[] = turns.map(turnToContent);

  const toolsCalled: AgentOutput['toolsCalled'] = [];
  const sideEffects: { kind: string; payload: Record<string, unknown>; tool: string }[] = [];
  let promptTokens = 0;
  let candidatesTokens = 0;
  let finalText = '';
  /** رسالة جاهزة من أداة تُرسل للعميل مباشرة دون انتظار صياغة النموذج */
  let directToolMessages: string[] = [];

  const MAX_TOOL_LOOPS = 4;

  for (let loop = 0; loop <= MAX_TOOL_LOOPS; loop++) {
    const response: any = await retry<any>(
      () => callGemini(contents, input.systemPrompt, input.toolsEnabled),
      {
        retries: config.gemini.RETRIES,
        label: 'استدعاء Gemini',
        shouldRetry: (err) => {
          const msg = (err as Error).message ?? '';
          // لا تُعِد المحاولة على أخطاء الصلاحية/المحتوى
          if (/API key not valid|PERMISSION_DENIED|INVALID_ARGUMENT/i.test(msg)) return false;
          return true;
        },
      },
    );

    promptTokens += response?.usageMetadata?.promptTokenCount ?? 0;
    candidatesTokens += response?.usageMetadata?.candidatesTokenCount ?? 0;

    // ── حظر أمان / لا يوجد رد ──
    const finish = response?.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      const blockReason = response?.promptFeedback?.blockReason;
      log.warn(`النموذج أنهى الرد بسبب: ${finish}${blockReason ? ` / ${blockReason}` : ''}`);
      if (finish === 'SAFETY' || blockReason) {
        return {
          parts: ['عذرًا، ما قدرت أعالج هذي الرسالة. ممكن توضح طلبك بطريقة أخرى؟'],
          handoff: false,
          toolsCalled,
          sideEffects,
          usage: { promptTokens, candidatesTokens },
          model: config.gemini.MODEL,
          engine: 'gemini',
          rawText: `[finishReason=${finish}]`,
        };
      }
    }

    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts.filter((p: any) => p?.functionCall?.name);

    // ── هناك استدعاء دوال → نفّذها وأعد الكرة ──
    if (functionCalls.length > 0) {
      // نعيد للنموذج أجزاءه كما هي (بما فيها functionCall) — مطلوب في الدورة التالية
      contents.push({
        role: 'model',
        parts: parts.map((p: any) => stripThought(p)).filter((p: any) => p.text !== ''),
      });

      const fnResponses: any[] = [];

      for (const fc of functionCalls) {
        const name = fc.functionCall.name as string;
        const args = (fc.functionCall.args ?? {}) as Record<string, any>;

        const result: ToolResult = await runTool(name, args, input.toolContext);
        toolsCalled.push({ name, args, result: result.data });

        // النتيجة تُعاد للنموذج داخل functionResponse
        fnResponses.push({
          functionResponse: { name, response: { ok: result.ok, result: result.data } },
        });

        if (result.sideEffect) {
          sideEffects.push({ kind: result.sideEffect.kind, payload: result.sideEffect.payload, tool: name });
          log.tool(`إجراء جانبي من ${name}: ${result.sideEffect.kind}`);
        }

        // لو الأداة أنتجت رسالة جاهزة للعميل، نعتبرها الرد النهائي ونخرج من الحلقة.
        // هذا يوفّر استدعاءً إضافيًا ويضمن دقة الأرقام والمراجع في الرسالة.
        if (result.userMessage && result.userMessage.trim()) {
          directToolMessages.push(result.userMessage.trim());
        }
      }

      if (directToolMessages.length) {
        finalText = '';
        break;
      }

      contents.push({ role: 'user', parts: fnResponses });
      await sleep(50);
      continue;
    }

    // ── لا استدعاءات → هذا هو الرد النهائي ──
    const texts = parts
      .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
      .map((p: any) => p.text as string);

    finalText = texts.join('\n').trim();
    break;
  }

  // لو خرجنا برسالة جاهزة من أداة → نرسلها مباشرة (مع أي رسالة إضافية من النموذج)
  if (directToolMessages.length) {
    const parts = directToolMessages.slice(0, config.bot.MAX_REPLY_PARTS + 1);
    return {
      parts,
      handoff: toolsCalled.some((t) => t.name === 'create_ticket'),
      reason: toolsCalled.find((t) => t.name === 'create_ticket') ? 'أداة create_ticket' : undefined,
      intent: toolsCalled[0]?.name,
      sentiment: 'neutral',
      toolsCalled,
      sideEffects,
      usage: { promptTokens, candidatesTokens },
      model: config.gemini.MODEL,
      engine: 'gemini',
      rawText: `[tool-direct] ${toolsCalled.map((t) => t.name).join(', ')}`,
    };
  }

  const parsed = parseAgentJson(finalText);

  let parts = parsed.parts;

  // لو النموذج أرجع أجزاء أكثر من الحد → ادمج الزائد في الأخير
  if (parts.length > config.bot.MAX_REPLY_PARTS) {
    parts = [
      ...parts.slice(0, config.bot.MAX_REPLY_PARTS - 1),
      parts.slice(config.bot.MAX_REPLY_PARTS - 1).join('\n'),
    ];
  }

  if (parts.length === 0 && !parsed.handoff) {
    parts = ['وصلتني رسالتك 👍 كيف أقدر أخدمك؟'];
  }

  return {
    parts,
    handoff: parsed.handoff,
    reason: parsed.reason,
    intent: parsed.intent,
    sentiment: parsed.sentiment,
    toolsCalled,
    sideEffects,
    usage: { promptTokens, candidatesTokens },
    model: config.gemini.MODEL,
    engine: 'gemini',
    rawText: finalText,
  };
}

/** حذف أجزاء "التفكير" من رد النموذج قبل إعادتها في السجل */
function stripThought(part: any): any {
  if (part?.thought) return { text: '' };
  if (typeof part?.text === 'string') return { text: part.text };
  if (part?.functionCall) return { functionCall: part.functionCall };
  return part;
}

/** تلخيص محادثة طويلة باستخدام النموذج السريع */
export async function summarizeConversation(history: string, existingSummary: string, promptBuilder: (s: string) => string): Promise<string> {
  if (!config.gemini.API_KEY) return existingSummary || 'لا يوجد ملخص (وضع التجربة).';

  try {
    const ai = getClient();
    const response: any = await retry<any>(
      () => (ai.models.generateContent as any)({
        model: config.gemini.FAST_MODEL,
        contents: [{ role: 'user', parts: [{ text: `${history}` }] }],
        config: {
          systemInstruction: promptBuilder(existingSummary),
          temperature: 0.3,
          maxOutputTokens: 400,
        },
      }),
      { retries: 1, label: 'تلخيص المحادثة' },
    );

    const text = (response?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
      .map((p: any) => p.text)
      .join('\n')
      .trim();

    return text || existingSummary;
  } catch (err) {
    log.warn(`تعذّر التلخيص: ${(err as Error).message}`);
    return existingSummary;
  }
}

// ─────────────────────────── محرك التجربة (بدون مفتاح) ───────────────────────────

/**
 * يعمل بدون GEMINI_API_KEY حتى تقدر تجرب المسار الكامل:
 * webhook → تحليل → جلسة → تقسيم رد → إرسال → لوحة التحكم.
 * الردود هنا قواعد بسيطة مخصصة لمنصة مُريح، ليست ذكاءً حقيقيًا.
 */
function mockReply(input: AgentInput, started: number): AgentOutput {
  const lastUser = [...input.turns].reverse().find((t) => t.role === 'user');
  const text = (lastUser?.text ?? '').toLowerCase();
  const hasMedia = Boolean(lastUser?.media?.length);
  const lastModelText = [...input.turns].reverse().find((t) => t.role === 'model')?.text ?? '';
  /** هل آخر رد للبوت طلب بيانات التفعيل؟ (عشان نميّز "رد على سؤال" عن "رسالة أولى") */
  const contextWantsDetails = /أرسل لي: اسمك|أجهز لك التفعيل|أجهز التفعيل|تبيني أجهز/.test(lastModelText);

  const parts: string[] = [];
  let handoff = false;
  let intent = 'غير_مصنف';

  const planList = () =>
    MUREEH_PLANS.map((p) => {
      const short =
        p.id === 'starter' ? 'منيو QR + كاشير + استدعاء نادل' :
        p.id === 'pro' ? '+ شاشة مطبخ KDS، POS، تحليلات، هوية بصرية' :
        'فروع متعددة، سعة مفتوحة، مدير حساب خاص';
      return `• *${p.name}* — *${p.priceMonthly} ₪/شهر* (${short})${p.mostPopular ? ' ← الأكثر طلبًا' : ''}`;
    }).join('\n');

  // 1) طلب محادثة بشرية
  if (/بشري|انسان|إنسان|موظف|وكيل|agent|human|شخص حقيقي|تحداك/.test(text)) {
    intent = 'طلب_تحويل';
    handoff = true;
    parts.push('أكيد، بربطك مع أحد زملائنا 👤');
    parts.push('فريقنا سيتابع معك في أقرب وقت. شكرًا لصبرك.');
  }
  // 2) غضب/استرداد
  else if (/سيئة|زعلان|مقرف|استرداد|ارجع فلوسي|أرجع فلوسي|تراجع|كارثة|افظع|terrible|awful|refund/.test(text)) {
    intent = 'شكوى';
    handoff = true;
    parts.push('أنا آسف فعلًا — هذا ليس الوضع الذي يجب أن تصل إليه تجربة مطعمك 🙏');
    parts.push('أرسلت موضوعك للفريق ليتابع معك شخصيًا ويحلّه، وسيصلك رد قريبًا.');
  }
  // 3) مشكلة تقنية لدى مشترك
  else if (/مشكلة|مش شغالة|ما تشتغل|ما تشتغل|error|طبي|تقني|مش عارف ادخل|لا تظهر|متوقف|تنبيهات/.test(text)) {
    intent = 'دعم_تقني';
    handoff = true;
    parts.push('واضح، وافتحت لك متابعة فورية مع الفريق الفني 🎫');
    parts.push('أرسل لي اسم المطعم (وصورة للشاشة لو تقدر — تسرّع الحل). الزميل سيتواصل معك مباشرة.');
  }
  // 4) تحية
  else if (/سلام|مرحبا|هلا|اهلا|hi|hello|صباح|مساء/.test(text) && text.length < 60) {
    intent = 'تحية';
    parts.push(`أهلًا وسهلًا 👋 أنا ${config.bot.BOT_NAME} — منصة مُريح لإدارة المطاعم: منيو QR، شاشة مطبخ حية، ونقطة بيع.`);
    parts.push('كم طاولة عندك في مطعمك؟ أحسب لك الأنسب.');
  }
  // 5) البوت طلب بيانات التفعيل والعميل ردّ بها → تأكيد
  else if (contextWantsDetails && (/اسمي|المطعم|مقهى|كافيه|مطعمي/.test(text) || /\d/.test(text))) {
    intent = 'بيانات_تفعيل';
    parts.push('✅ وصلتني طلبك للتفعيل. فريق مُريح يتواصل معك الآن لاستكمال التجهيز — يتم خلال دقائق وبدون بطاقة ائتمانية للبدء 🚀');
  }

  // 6) ذكر عدد طاولات → توصية فورية
  else {
    const m = text.match(/(\d{1,3})\s*(?:طاولة|طاولات|طاو|table)/);
    if (m) {
      intent = 'توصية_باقة';
      const tables = Number(m[1]);
      const rec = recommendPlan({ tables });
      const p = rec.plan;
      parts.push(`لمطعم *${tables} طاولة* أنصح بـ*${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' (الأكثر طلبًا)' : ''}.`);
      parts.push(`السبب: ${rec.reason}. والدفع السنوي يوفر ${p.yearlySavings} ₪. تبيني أجهز لك التفعيل؟`);
    }
  }

  // 6) طلب تفعيل اشتراك (يجب أن يسبق فروع "شكر" و"باقات" لأن "تمام" قد يخلطها)
  if (parts.length === 0 && /اشترك|أشترك|اشتراك|أشترك|تفعيل|أبدأ|ابدأ|subscribe|contract/.test(text)) {
    intent = 'طلب_تفعيل';
    const isQuestion = /كيف|وش|هل|متى|متي|لماذا|why|how/.test(text);
    const words = text.trim().split(/\s+/).length;
    const hasDetails = words >= 6 || (/\d/.test(text) && /مطعم|مقهى|كافيه|كافيه/.test(text));
    if (isQuestion) {
      parts.push('التفعيل خلال دقائق عادةً، وبدون بطاقة ائتمانية للبدء 🚀');
      parts.push('المسار 4 خطوات: معلومات المطعم ← الهوية والألوان ← الطاولات والباقة ← التدشين. والفريق يساعدك خطوة بخطوة.');
      parts.push('تبيني نبدأ؟ أرسل لي: اسمك، اسم المطعم، المدينة، وعدد الطاولات.');
    } else if (hasDetails) {
      parts.push('✅ وصلتني طلبك للتفعيل. فريق مُريح يتواصل معك الآن لاستكمال التجهيز — يتم خلال دقائق وبدون بطاقة ائتمانية للبدء 🚀');
    } else {
      parts.push('أبشر، نجهز التفعيل 🎉');
      parts.push('أرسل لي: اسمك، اسم المطعم، المدينة، وعدد الطاولات — وأسجل طلبك فورًا.');
    }
  }

  // 7) باقة المؤسسات/فروع
  if (parts.length === 0 && /فروع|سلسلة|سلاسل|enterprise|chain/.test(text)) {
    intent = 'استفسار_باقات';
    const p = getPlan('enterprise');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* (${p.priceYearlyPerMonth} ₪ عند الدفع السنوي):`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('كم فرعًا عندك حاليًا؟');
  }

  // 8) الباقة الاحترافية
  if (parts.length === 0 && /احتراف|pro|kds|مطبخ|pos/.test(text)) {
    intent = 'استفسار_باقات';
    const p = getPlan('pro');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* (${p.priceYearlyPerMonth} ₪ عند الدفع السنوي):`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('تبي أجهز لك التفعيل؟');
  }

  // 9) استفسار أسعار عام
  if (parts.length === 0 && /سعر|أسعار|اسعار|بكم|تكلف|باقة|باقات|price|plan|package/.test(text)) {
    intent = 'استفسار_أسعار';
    parts.push(`عندنا 3 باقات، كلها بدون عقود وبدون رسوم مخفية:\n${planList()}\n\nالدفع السنوي يوفر شهرين (~17%).`);
    parts.push('كم طاولة عندك في مطعمك؟ أحسب لك الأنسب.');
  }

  // 10) شكر/إيجاب
  if (parts.length === 0 && /شكرا|شكرًا|تمام|ممتاز|رائع|تقبلك|thanks|great|awesome/.test(text)) {
    intent = 'إيجابي';
    parts.push('العفو! 🙌 أي سؤال ثاني عن الباقات أو التفعيل أنا هنا.');
  }

  // 11) وسائط
  if (parts.length === 0 && hasMedia) {
    intent = 'وسائط';
    parts.push('وصلتني الوسائط التي أرسلتها ✅');
    parts.push('في وضع التجربة ما أقدر أحلل الصور/الصوت. اضبط GEMINI_API_KEY لتفعيل الفهم الكامل.');
  }

  // 12) افتراضي
  if (parts.length === 0) {
    intent = 'عام';
    parts.push('وصلني رسالتك 👌 أقدر أجاوبك عن الباقات والأسعار، وأجهز لك تفعيل الاشتراك، وأتابع أي مشكلة تقنية لديك.');
    parts.push(`⚙️ هذا *محرك تجربة* — اضبط GEMINI_API_KEY في .env لتفعيل ردود ${config.gemini.MODEL} الحقيقية.`);
  }

  const reason =
    intent === 'دعم_تقني' ? 'مشكلة تقنية لمشترك — تذكرة دعم' :
    intent === 'شكوى' ? 'شكوى/طلب استرداد' :
    intent === 'طلب_تحويل' ? 'طلب العميل محادثة بشرية' : undefined;

  return {
    parts,
    handoff,
    reason,
    intent,
    sentiment: handoff ? 'negative' : 'neutral',
    toolsCalled: [],
    sideEffects: [],
    usage: { promptTokens: 0, candidatesTokens: 0 },
    model: 'mock-engine',
    engine: 'mock',
    rawText: JSON.stringify({ reply_parts: parts, handoff, intent }),
  };
}
