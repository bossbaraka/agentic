import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { extractJson, log, retry, sanitizeForJson, sleep } from '../lib/utils.js';
import type { MediaPart } from '../types.js';
import { TOOL_DECLARATIONS, runTool, type ToolContext, type ToolResult } from './tools.js';
import { getPlan, MUREEH_PLANS, recommendPlan } from './plans.js';
import {
  clampButtons,
  dayPart,
  fallbackQuickReplies,
  firstNameOf,
  greetingWord,
  isAffirmative,
  type QuickReply,
} from './personality.js';

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
  /** أزرار سريعة تُرسل مع آخر جزء (واتساب/تيليجرام) */
  quickReplies: QuickReply[];
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

  // يجب أن يبدأ وينتهي السجل بدور user
  while (out.length && out[0].role === 'model') out.shift();
  while (out.length && out[out.length - 1].role === 'model') out.pop();

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
  quickReplies: QuickReply[];
}

function parseQuickReplies(raw: unknown): QuickReply[] {
  if (!Array.isArray(raw)) return [];
  return clampButtons(
    raw.map((b: any) => ({
      id: String(b?.id ?? b?.payload ?? ''),
      title: String(b?.title ?? b?.text ?? ''),
    })),
  );
}

function parseAgentJson(text: string): ParsedReply {
  const json = extractJson(text);

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, any>;

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
      quickReplies: parseQuickReplies(o.quick_replies ?? o.quickReplies ?? o.buttons),
    };
  }

  if (Array.isArray(json)) {
    const parts = json.map((x: any) => (typeof x === 'string' ? x : String(x))).filter(Boolean);
    return { ok: true, parts, handoff: false, quickReplies: [] };
  }

  const fallback = sanitizeForJson(text).trim();
  if (!fallback) return { ok: false, parts: [], handoff: false, quickReplies: [] };
  return { ok: false, parts: [fallback], handoff: false, quickReplies: [] };
}

function finishOutput(partial: Omit<AgentOutput, 'quickReplies'> & { quickReplies?: QuickReply[] }): AgentOutput {
  const qr = partial.quickReplies?.length
    ? clampButtons(partial.quickReplies)
    : fallbackQuickReplies(partial.intent);
  return { ...partial, quickReplies: qr };
}

// ─────────────────────────── المحرك ───────────────────────────

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: config.gemini.API_KEY,
      ...(config.gemini.BASE_URL ? { httpOptions: { baseUrl: config.gemini.BASE_URL } } : {}),
    } as any);
  }
  return client;
}

async function callGemini(
  contents: GeminiContent[],
  systemInstruction: string,
  toolsEnabled: boolean,
  overrideModel?: string,
): Promise<any> {
  const ai = getClient();
  const targetModel = overrideModel ?? config.gemini.MODEL;

  const params: Record<string, any> = {
    model: targetModel,
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
    params.config.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gemini.TIMEOUT_MS);
  try {
    return await (ai.models.generateContent as any)({ ...params, abortSignal: controller.signal });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/429|RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg) && targetModel !== config.gemini.FAST_MODEL) {
      log.warn(`⚠️ انتهت حصة ${targetModel} المجانية — التحول التلقائي للموديل الاحتياطي ${config.gemini.FAST_MODEL}`);
      return await callGemini(contents, systemInstruction, toolsEnabled, config.gemini.FAST_MODEL);
    }
    throw err;
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
  const toolFallbacks: string[] = [];

  const MAX_TOOL_LOOPS = 4;

  for (let loop = 0; loop <= MAX_TOOL_LOOPS; loop++) {
    const response: any = await retry<any>(
      () => callGemini(contents, input.systemPrompt, input.toolsEnabled),
      {
        retries: config.gemini.RETRIES,
        label: 'استدعاء Gemini',
        shouldRetry: (err) => {
          const msg = (err as Error).message ?? '';
          if (/API key not valid|PERMISSION_DENIED|INVALID_ARGUMENT/i.test(msg)) return false;
          return true;
        },
      },
    );

    promptTokens += response?.usageMetadata?.promptTokenCount ?? 0;
    candidatesTokens += response?.usageMetadata?.candidatesTokenCount ?? 0;

    const finish = response?.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      const blockReason = response?.promptFeedback?.blockReason;
      log.warn(`النموذج أنهى الرد بسبب: ${finish}${blockReason ? ` / ${blockReason}` : ''}`);
      if (finish === 'SAFETY' || blockReason) {
        return finishOutput({
          parts: ['عذرًا، ما قدرت أعالج هذي الرسالة. ممكن توضح طلبك بطريقة ثانية؟ أنا معك.'],
          handoff: false,
          intent: 'عام',
          toolsCalled,
          sideEffects,
          usage: { promptTokens, candidatesTokens },
          model: config.gemini.MODEL,
          engine: 'gemini',
          rawText: `[finishReason=${finish}]`,
        });
      }
    }

    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts.filter((p: any) => p?.functionCall?.name);

    if (functionCalls.length > 0) {
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

        fnResponses.push({
          functionResponse: {
            name,
            response: {
              ok: result.ok,
              result: result.data,
              ...(result.userMessage ? { suggested_copy: result.userMessage } : {}),
            },
          },
        });

        if (result.sideEffect) {
          sideEffects.push({ kind: result.sideEffect.kind, payload: result.sideEffect.payload, tool: name });
          log.tool(`إجراء جانبي من ${name}: ${result.sideEffect.kind}`);
        }

        if (result.userMessage?.trim()) toolFallbacks.push(result.userMessage.trim());
      }

      contents.push({ role: 'user', parts: fnResponses });
      await sleep(50);
      continue;
    }

    const texts = parts
      .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
      .map((p: any) => p.text as string);

    finalText = texts.join('\n').trim();
    break;
  }

  const parsed = parseAgentJson(finalText);

  let outParts = parsed.parts;

  if (outParts.length > config.bot.MAX_REPLY_PARTS) {
    outParts = [
      ...outParts.slice(0, config.bot.MAX_REPLY_PARTS - 1),
      outParts.slice(config.bot.MAX_REPLY_PARTS - 1).join('\n'),
    ];
  }

  if (outParts.length === 0) {
    if (toolFallbacks.length) outParts = toolFallbacks.slice(0, config.bot.MAX_REPLY_PARTS);
    else if (!parsed.handoff) outParts = ['وصلتني رسالتك 👍 كيف أقدر أخدمك؟'];
  }

  const supportTicket = toolsCalled.some((t) => t.name === 'create_support_ticket');

  return finishOutput({
    parts: outParts,
    handoff: parsed.handoff || supportTicket,
    reason: parsed.reason ?? (supportTicket ? 'تذكرة دعم فُتحت — متابعة بشرية' : undefined),
    intent: parsed.intent,
    sentiment: parsed.sentiment,
    quickReplies: parsed.quickReplies,
    toolsCalled,
    sideEffects,
    usage: { promptTokens, candidatesTokens },
    model: config.gemini.MODEL,
    engine: 'gemini',
    rawText: finalText,
  });
}

function stripThought(part: any): any {
  if (part?.thought) return { text: '' };
  if (typeof part?.text === 'string') return { text: part.text };
  if (part?.functionCall) return { functionCall: part.functionCall };
  return part;
}

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

function nameFromPrompt(systemPrompt: string): string {
  const m = systemPrompt.match(/اسم العميل في واتساب:\s*([^\n]+)/);
  return firstNameOf(m?.[1]?.trim() ?? '');
}

/**
 * يعمل بدون GEMINI_API_KEY حتى تقدر تجرب المسار الكامل.
 * الردود قواعد بسيطة — لكن بنفس نبرة الإنسان المتحمّس، لا سكربت جاف.
 */
function mockReply(input: AgentInput, _started: number): AgentOutput {
  const lastUser = [...input.turns].reverse().find((t) => t.role === 'user');
  const raw = lastUser?.text ?? '';
  const text = raw.toLowerCase();
  const hasMedia = Boolean(lastUser?.media?.length);
  const lastModelText = [...input.turns].reverse().find((t) => t.role === 'model')?.text ?? '';
  const name = nameFromPrompt(input.systemPrompt);
  const vocative = name ? `${name}، ` : '';
  const askedActivation = /أجهّز لك التفعيل|أجهز لك التفعيل|أجهز التفعيل|تبيني أجه|خلّينا نجه|شو اسمك|أرسل لي: اسمك/.test(lastModelText);
  const askedName = /شو اسمك|ما اسمك|اسمك\؟/.test(lastModelText);

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

  // أزرار شائعة
  const click = /الأسعار والباقات|أنصحني بباقة|أبدأ التفعيل|جهز لي التفعيل|الأساسية|الاحترافية|المؤسسات|qr:/.test(text);

  if (/بشري|انسان|إنسان|موظف|وكيل|agent|human|شخص حقيقي|أريد موظف/.test(text)) {
    intent = 'طلب_تحويل';
    handoff = true;
    parts.push(`${vocative}أكيد، بوصلك بأحد الزملاء الحين.`);
    parts.push('فريقنا يكمل معك بأقرب وقت. وأنا هنا لو احتجت شيء بعدين.');
  } else if (/سيئة|زعلان|مقرف|استرداد|ارجع فلوسي|أرجع فلوسي|كارثة|فظيع|terrible|awful|refund/.test(text)) {
    intent = 'شكوى';
    handoff = true;
    parts.push('أنا آسف فعلًا — هذا مو الوضع اللي يستحقه مطعمك.');
    parts.push('أرسلت موضوعك للفريق يتابع معك شخصيًا ويحلّه. سيصلك رد قريبًا.');
  } else if (/مشكلة|مش شغالة|ما تشتغل|error|تقني|مش عارف ادخل|لا تظهر|متوقف|تنبيهات/.test(text)) {
    intent = 'دعم_تقني';
    handoff = true;
    parts.push('واضح، وما المفروض يصير هذا عندك.');
    parts.push('فتحت متابعة فورية للفريق الفني. اسم المطعم عشان نسرّعها؟ وصورة للشاشة لو تقدر.');
  } else if (/روبوت|ذكاء اصطناعي|ai\b|انت بوت|أنت بوت/.test(text)) {
    intent = 'عام';
    parts.push('أنا مساعد الفريق هنا على الدردشة، والزملاء البشريين معي لو احتجتهم 🙂');
    parts.push('تحب نمرّ على الباقات ولا أجهّز لك تفعيل؟');
  } else if (/كيفك|كيف حالك|شخبارك|عامل ايه|whats up/.test(text)) {
    intent = 'تحية';
    parts.push(`${vocative}تمام والحمد لله، وأنت؟ 🙌 خلينا نفيد مطعمك: كم طاولة تشتغل عندك؟`);
  } else if ((/سلام|مرحبا|هلا|اهلا|أهلًا|hi\b|hello|hey|صباح|مساء/.test(text) && text.length < 80) || click && /هلا|hi/.test(text)) {
    intent = 'تحية';
    const g = greetingWord(dayPart());
    parts.push(`${g}${name ? ` ${name}` : ''} 👋 أنا ${config.bot.BOT_NAME} — منيو QR، شاشة مطبخ حية، وكاشير من الرمز على الطاولة.`);
    parts.push('كم طاولة تشتغل عندك؟ أحسب لك الباقة اللي تفرق معك فعلًا.');
  } else if (askedName && raw.trim().split(/\s+/).length <= 4 && !/سعر|باقة/.test(text)) {
    intent = 'طلب_تفعيل';
    parts.push(`تسلم${name ? ' ' + name : ''}. واسم المطعم؟`);
  } else if (askedActivation && (isAffirmative(raw) || /اسمي|المطعم|مقهى|كافيه|مطعمي/.test(text) || /\d/.test(text))) {
    intent = 'بيانات_تفعيل';
    if (isAffirmative(raw) && !/\d/.test(text) && !/مطعم|مقهى/.test(text)) {
      parts.push('يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
      intent = 'طلب_تفعيل';
    } else {
      parts.push(`✅ وصلت التفاصيل${name ? ' يا ' + name : ''}. فريق مُريح يتواصل معك الآن لاستكمال التجهيز — خلال دقائق عادة وبدون بطاقة ائتمانية للبدء 🚀`);
    }
  } else {
    const m = text.match(/(\d{1,3})\s*(?:طاولة|طاولات|طاو|table)/);
    if (m) {
      intent = 'توصية_باقة';
      const tables = Number(m[1]);
      const rec = recommendPlan({ tables });
      const p = rec.plan;
      parts.push(`لـ*${tables} طاولة* أنصح بـ*${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' (الأكثر طلبًا)' : ''}.`);
      parts.push(`${rec.reason}. والدفع السنوي يوفّر *${p.yearlySavings} ₪*. تبيني أجهّز لك التفعيل؟`);
    }
  }

  if (parts.length === 0 && (/أبدأ التفعيل|جهز لي التفعيل|qr:activate/.test(text) || /اشترك|أشترك|اشتراك|تفعيل|أبدأ|ابدأ|نبدأ|يلا|subscribe/.test(text))) {
    intent = 'طلب_تفعيل';
    const isQuestion = /كيف|وش|هل|متى|متي|لماذا|why|how/.test(text);
    const words = text.trim().split(/\s+/).length;
    const hasDetails = words >= 6 || (/\d/.test(text) && /مطعم|مقهى|كافيه/.test(text));
    if (isQuestion) {
      parts.push('التفعيل خلال دقائق عادةً، وبدون بطاقة ائتمانية للبدء 🚀');
      parts.push('أربع خطوات بسيطة والفريق معك فيها. تبيني نبدأ؟ شو اسمك؟');
    } else if (hasDetails) {
      parts.push('✅ وصلتني طلبك. الفريق يتواصل معك الآن لاستكمال التجهيز — خلال دقائق وبدون بطاقة للبدء 🚀');
    } else {
      parts.push('يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
    }
  }

  if (parts.length === 0 && (/فروع|سلسلة|سلاسل|enterprise|chain|المؤسسات 799|qr:enterprise/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('enterprise');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* (≈ ${p.priceYearlyPerMonth} ₪ عند السنوي):`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('كم فرعًا عندك حاليًا؟');
  }

  if (parts.length === 0 && (/احتراف|pro|kds|مطبخ|pos|الاحترافية 299|qr:pro/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('pro');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* ← الأكثر طلبًا.`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('تبيني أجهّز لك التفعيل؟');
  }

  if (parts.length === 0 && (/أساسية|starter|الأساسية 149|qr:starter/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('starter');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر*. بداية نظيفة لمنيو QR وكاشير واستدعاء نادل.`);
    parts.push('تقدر ترقّي في أي وقت من اللوحة. كم طاولة عندك؟');
  }

  if (parts.length === 0 && (/سعر|أسعار|اسعار|بكم|تكلف|باقة|باقات|price|plan|package|الأسعار والباقات|qr:prices|أنصحني/.test(text))) {
    intent = 'استفسار_أسعار';
    parts.push(`ثلاث باقات، بدون عقود وبدون رسوم مخفية:\n${planList()}\n\nالدفع السنوي يوفّر شهرين كاملين.`);
    parts.push('كم طاولة تشتغل عندك؟ أحسب لك الأنسب.');
  }

  if (parts.length === 0 && askedActivation && isAffirmative(raw)) {
    intent = 'طلب_تفعيل';
    parts.push('يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
  }

  if (parts.length === 0 && /شكرا|شكرًا|تمام|ممتاز|رائع|thanks|great|awesome/.test(text)) {
    intent = 'إيجابي';
    parts.push(`العفو${name ? ' ' + name : ''} 🙌 أي سؤال ثاني عن الباقات أو التفعيل، أنا هنا.`);
  }

  if (parts.length === 0 && hasMedia) {
    intent = 'وسائط';
    parts.push('وصلتني، وشفت المرفق ✅');
    parts.push('خبّرني: هذي منيو، شاشة مطبخ، ولا شيء ثاني؟ وأنا أربطها لك بالحل المناسب.');
  }

  if (parts.length === 0) {
    intent = 'عام';
    parts.push(`${vocative}وصلتني 👌 أقدر أشرح الباقات، أحسب لك الأنسب حسب الطاولات، وأجهّز التفعيل، وأتابع أي عطل فني.`);
    parts.push('من وين نبدأ؟');
  }

  const reason =
    intent === 'دعم_تقني' ? 'مشكلة تقنية لمشترك — تذكرة دعم' :
    intent === 'شكوى' ? 'شكوى/طلب استرداد' :
    intent === 'طلب_تحويل' ? 'طلب العميل محادثة بشرية' : undefined;

  return finishOutput({
    parts,
    handoff,
    reason,
    intent,
    sentiment: handoff ? 'negative' : /تحية|إيجابي|توصية|تفعيل/.test(intent) ? 'positive' : 'neutral',
    toolsCalled: [],
    sideEffects: [],
    usage: { promptTokens: 0, candidatesTokens: 0 },
    model: 'mock-engine',
    engine: 'mock',
    rawText: JSON.stringify({ reply_parts: parts, handoff, intent }),
  });
}
