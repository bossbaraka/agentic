import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { config } from '../config.js';
import { extractJson, log, retry, sanitizeForJson, sleep, splitText } from '../lib/utils.js';
import type { MediaPart } from '../types.js';
import { TOOL_DECLARATIONS, runTool, type ToolContext, type ToolResult } from './tools.js';
import { store } from '../lib/store.js';
import { getPlan, MUREEH_PLANS, perTableMonthly, recommendPlan, type PlanId } from './plans.js';
import { buildBlueprintText, managerOrderMessage, planIdFromText } from './onboarding.js';
import { availability, formatAvailabilityText, nextAvailableDays } from './bookings.js';
import { detectPainPoints } from './intelligence/painPoints.js';
import {
  clampButtons,
  coherentQuickReplies,
  dayPart,
  fallbackQuickReplies,
  firstNameOf,
  greetingWord,
  isAffirmative,
  type QuickReply,
} from './personality.js';

/**
 * محرك الذكاء: يغلّف OpenAI و Gemini ويحوّل الرد الخام إلى بنية مضبوطة.
 *
 * - يدعم OpenAI (GPT-4o / GPT-4o-mini) و Google Gemini
 * - يمرر الوسائط كـ inlineData أو image_url
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
  engine: 'gemini' | 'mock' | 'openai';
  rawText: string;
  /**
   * تصنيف صريح لحالة الذكاء التي ولّدت هذا الرد — يُسجَّل ويُقاس ولا يُخفى:
   *   ai_success      النموذج الأساسي أجاب بنجاح
   *   ai_degraded     أجاب بديل مُدقَّق (موديل احتياطي/مزوّد ثانٍ) — الجودة قد تختلف قليلًا
   *   ai_unavailable  سقط النموذج كليًا وأجاب المحرك الحتمي المحلي (من plans.ts) — للطوارئ فقط
   *   demo_mode       لا مفاتيح مضبوطة والنظام في وضع التجربة — محرك القواعد المقصود
   * الحقل القديم degraded يبقى متوافقًا (= aiStatus !== 'ai_success').
   */
  aiStatus?: 'ai_success' | 'ai_degraded' | 'ai_unavailable' | 'demo_mode';
  /** هل أجاب موديل بديل عن الأساسي داخل نفس المزوّد؟ */
  fallbackModel?: boolean;
  /**
   * true عندما تعذّر الوصول لـ Gemini فأجاب البوت من بياناته المحلية الدقيقة
   * (الأسعار والتوصيات من plans.ts) — العميل يحصل على رد مفيد دائمًا،
   * وصاحب البوت يرى تنبيهًا في السجلات ولوحة التحكم لمعالجة السبب.
   */
  degraded?: boolean;
  degradedReason?: string;
  /** مرجع طلب الإطلاق عند تأكيده (ORD-XXXXXX) — يعني: حُوّل لمدير المنصة */
  orderRef?: string;
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

/**
 * استخراج reply_parts بالتعابير النظامية كحل أخير عندما يكون JSON مكسورًا
 * (فاصلة زائدة، اقتباس ناقص...) — المهم: العميل لا يرى أقواسًا وأكوادًا أبدًا.
 */
function extractPartsByRegex(text: string): string[] {
  const out: string[] = [];
  // 1) مصفوفة reply_parts حتى لو كان باقي الكائن مكسورًا
  const arrMatch = text.match(/"reply_parts"\s*:\s*\[([\s\S]*?)\]/);
  const haystack = arrMatch ? arrMatch[1] : text;
  const strRe = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = strRe.exec(haystack)) && guard++ < 20) {
    const s = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
    // تجاهل مفاتيح JSON نفسها لو التُقطت
    if (!s || /^(reply_parts|quick_replies|handoff|handoff_reason|intent|sentiment|id|title)$/.test(s)) continue;
    out.push(s);
  }
  return out;
}

/** هل يبدو النص كـ JSON (وليس كلامًا بشريًا)؟ */
function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith('{') ||
    t.startsWith('```') ||
    /"reply_parts"\s*:/.test(t) ||
    /"quick_replies"\s*:/.test(t)
  );
}

export function parseAgentJson(text: string): ParsedReply {
  // محاولة 1: استخراج مباشر
  let json = extractJson(text);

  // محاولة 2: إصلاح شائع — فاصلة زائدة قبل } أو ]
  if (!json) {
    const repaired = text.replace(/,(\s*[}\]])/g, '$1');
    if (repaired !== text) json = extractJson(repaired);
  }

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, any>;

    let rawParts = o.reply_parts ?? o.replyParts ?? o.reply ?? o.response ?? o.parts;
    if (typeof rawParts === 'string') rawParts = [rawParts];
    if (!Array.isArray(rawParts)) rawParts = [];

    const parts = rawParts
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .map((p: string) => sanitizeReplyPart(sanitizeForJson(p)))
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
    const parts = json
      .map((x: any) => (typeof x === 'string' ? x : String(x)))
      .map((p: string) => sanitizeReplyPart(p))
      .filter(Boolean);
    return { ok: true, parts, handoff: false, quickReplies: [] };
  }

  // لا يوجد JSON صالح:
  // - لو النص يشبه JSON مكسورًا → استخرج جمله بالتعابير النظامية
  // - لو كلام عادي → عقّمه وأرسله كما هو
  if (looksLikeJson(text)) {
    const parts = extractPartsByRegex(text)
      .map((p) => sanitizeReplyPart(p))
      .filter((p) => p.length > 0);
    if (parts.length > 0) {
      log.warn('خرج النموذج بـ JSON مكسور — تم إنقاذ النص بالتعابير النظامية');
      return { ok: true, parts, handoff: false, quickReplies: [] };
    }
    // JSON مكسور تمامًا ولا يمكن إنقاذه → لا نرسل الأقواس للعميل إطلاقًا
    log.warn('خرج النموذج بـ JSON غير قابل للإنقاذ — سيُستخدم الرد الاحتياطي');
    return { ok: false, parts: [], handoff: false, quickReplies: [] };
  }

  const fallback = sanitizeReplyPart(sanitizeForJson(text));
  if (!fallback) return { ok: false, parts: [], handoff: false, quickReplies: [] };
  return { ok: false, parts: [fallback], handoff: false, quickReplies: [] };
}

/**
 * تعقيم أي نص خارج إلى العميل — خط الدفاع الأخير ضد «ظهور» أشياء غريبة:
 * ملاحظات النظام الداخلية، بقايا JSON، أسوار الكود، ترويسات Markdown،
 * جداول، ومعرّفات الأزرار الداخلية (qr:...).
 */
export function sanitizeReplyPart(raw: string): string {
  let t = (raw ?? '').replace(/\r\n/g, '\n');

  // 1) أسوار الكود: نحتفظ بالنص الداخلي فقط لو كان كلامًا، ونحذف JSON
  t = t.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, (_f, inner: string) => {
    const s = String(inner ?? '').trim();
    if (!s) return '';
    if (looksLikeJson(s)) {
      const rescued = extractPartsByRegex(s);
      return rescued.length ? rescued.join('\n') : '';
    }
    return s;
  });

  // 2) سطور JSON المتناثرة (مفاتيح/أقواس وحيدة)
  t = t
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/^[{}\[\]",]+$/.test(s)) return false;
      if (/^"(reply_parts|replyParts|reply|response|parts|quick_replies|quickReplies|buttons|handoff|handoff_reason|needs_human|escalate|intent|sentiment|id|title)"\s*:/.test(s)) return false;
      return true;
    })
    .join('\n');

  // 3) ملاحظات النظام الداخلية لو تسرّبت ([ملاحظة نظام: ...])
  t = t.replace(/\[[^\]\n]{0,120}?(ملاحظة نظام|system note)[^\]\n]*\]/gi, '');

  // 4) ترويسات Markdown وجداولها
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*\|.*\|\s*$/gm, (row) =>
    row.replace(/\|/g, ' ').replace(/\s{2,}/g, ' ').trim(),
  );
  t = t.replace(/\*\*/g, '*');

  // 5) معرّفات الأزرار الداخلية لو ظهرت كنص
  t = t.replace(/\(qr:[^)]*\)/gi, '');
  t = t.replace(/\bqr:[a-z0-9_-]+\b/gi, '');

  // 6) ترتيب نهائي
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // سطر واحد متبقٍّ يبدو كـ JSON؟ لا نرسله.
  if (t && looksLikeJson(t) && !/[ء-غف-يa-zA-Z]{8,}/.test(t.replace(/["{},\[\]:]/g, ' '))) return '';
  return t;
}

function finishOutput(partial: Omit<AgentOutput, 'quickReplies'> & { quickReplies?: QuickReply[] }): AgentOutput {
  // تعقيم أخير لكل الأجزاء + تقسيم الطويل منها حسب حد القناة
  const clean: string[] = [];
  for (const p of partial.parts ?? []) {
    const s = sanitizeReplyPart(p);
    if (!s) continue;
    if (s.length > config.bot.MAX_SEGMENT_CHARS) {
      clean.push(...splitText(s, config.bot.MAX_SEGMENT_CHARS));
    } else {
      clean.push(s);
    }
  }
  const capped =
    clean.length > config.bot.MAX_REPLY_PARTS
      ? [
          ...clean.slice(0, config.bot.MAX_REPLY_PARTS - 1),
          clean.slice(config.bot.MAX_REPLY_PARTS - 1).join('\n'),
        ]
      : clean;
  // الأزرار تُبنى من الجملة الأخيرة حصرًا — لا أزرار نشاز عن النص أبدًا
  const lastText = capped[capped.length - 1] ?? '';
  const qr = coherentQuickReplies(lastText, partial.quickReplies, partial.intent, partial.handoff);
  return { ...partial, parts: capped, quickReplies: qr };
}

// ─────────────────────────── المحرك ───────────────────────────

let currentKeyIndex = 0;

function getClient(keyIndex?: number): GoogleGenAI {
  const keys = config.gemini.API_KEYS.length ? config.gemini.API_KEYS : [config.gemini.API_KEY];
  const index = Math.abs((keyIndex ?? currentKeyIndex) % keys.length);
  const apiKey = keys[index] || config.gemini.API_KEY;

  return new GoogleGenAI({
    apiKey,
    ...(config.gemini.BASE_URL ? { httpOptions: { baseUrl: config.gemini.BASE_URL } } : {}),
  } as any);
}

let openAiClientInstance: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!openAiClientInstance) {
    openAiClientInstance = new OpenAI({
      apiKey: config.openai.API_KEY,
      ...(config.openai.BASE_URL ? { baseURL: config.openai.BASE_URL } : {}),
      timeout: config.openai.TIMEOUT_MS,
    });
  }
  return openAiClientInstance;
}

function toOpenAiSchema(val: any): any {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(toOpenAiSchema);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = v.toLowerCase();
    } else {
      out[k] = toOpenAiSchema(v);
    }
  }
  return out;
}

function getOpenAiTools(): OpenAI.Chat.ChatCompletionTool[] {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const group of TOOL_DECLARATIONS) {
    for (const fn of (group as any).functionDeclarations ?? []) {
      tools.push({
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description,
          parameters: toOpenAiSchema(fn.parameters) ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return tools;
}

// ─────────────────────────── تشخيص أخطاء Gemini ───────────────────────────

export type GeminiErrorKind =
  | 'quota'           // 429 — حصة منتهية
  | 'model_not_found' // 404 — الموديل غير موجود/متوقف
  | 'invalid_key'     // مفتاح خاطئ أو صلاحيات
  | 'timeout'         // انتهت المهلة
  | 'network'         // شبكة / ضغط على خوادم Google (5xx)
  | 'bad_request'     // طلب مرفوض (400)
  | 'safety'          // حجب أمان
  | 'unknown';

export interface ClassifiedError {
  kind: GeminiErrorKind;
  /** رسالة عربية عملية لصاحب البوت (سجلات/لوحة — لا تظهر للعميل) */
  hint: string;
  /** هل تُجدي إعادة المحاولة؟ */
  retryable: boolean;
}

export function classifyGeminiError(err: unknown): ClassifiedError {
  const msg = String((err as any)?.message ?? err ?? '');
  if (/429|RESOURCE_EXHAUSTED|quota|Quota exceeded|rate.?limit/i.test(msg)) {
    return {
      kind: 'quota',
      hint: 'انتهت حصة Gemini (429) — أضف مفتاحًا آخر في GEMINI_API_KEY (افصل بفواصل) أو راجع الحصة في AI Studio',
      retryable: true,
    };
  }
  if (/404|NOT_FOUND|not found|is not found|unsupported model|Model .* does not|Publisher Model .* not found/i.test(msg)) {
    return {
      kind: 'model_not_found',
      hint: `الموديل غير متوفر لدى Google — حدّث GEMINI_MODEL (الحالي: ${config.gemini.MODEL}). مقترح: gemini-2.5-flash أو gemini-3.5-flash-lite`,
      retryable: false,
    };
  }
  if (/API key not valid|API_KEY_INVALID|invalid api key|API key expired/i.test(msg)) {
    return {
      kind: 'invalid_key',
      hint: 'مفتاح GEMINI_API_KEY غير صالح — أنشئ مفتاحًا جديدًا من aistudio.google.com/apikey',
      retryable: false,
    };
  }
  if (/PERMISSION_DENIED|403/i.test(msg)) {
    return {
      kind: 'invalid_key',
      hint: 'رفض صلاحية من Google (403) — تحقق من المفتاح وتفعيل Generative Language API للمشروع',
      retryable: false,
    };
  }
  if (/aborted|abort|timeout|timed out|TIMEOUT|DEADLINE_EXCEEDED|ETIMEDOUT/i.test(msg)) {
    return { kind: 'timeout', hint: 'انتهت مهلة الاتصال بـ Gemini — تُعاد المحاولة تلقائيًا', retryable: true };
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket hang up|UNAVAILABLE|50[023]|OVERLOADED|overloaded|Service Unavailable/i.test(msg)) {
    return { kind: 'network', hint: 'عطل شبكة أو ضغط على خوادم Google — تُعاد المحاولة تلقائيًا', retryable: true };
  }
  if (/SAFETY|blocked|BLOCKED|finishReason/i.test(msg)) {
    return { kind: 'safety', hint: 'حجب أمان من النموذج — لا يحتاج إجراءً منك', retryable: false };
  }
  if (/INVALID_ARGUMENT|\b400\b/i.test(msg)) {
    return { kind: 'bad_request', hint: 'رفض Google الطلب (400) — راجع السجلات لتفاصيل الرسالة المسببة', retryable: false };
  }
  return { kind: 'unknown', hint: msg.slice(0, 220), retryable: true };
}

/**
 * سلسلة الموديلات بالترتيب: الرئيسي ← السريع ← البدائل من الإعدادات.
 * تُجرَّب تلقائيًا عند 404 أو نفاد الحصة — العميل لا يشعر بشيء.
 */
export function buildModelChain(): string[] {
  const chain = [config.gemini.MODEL, config.gemini.FAST_MODEL, ...config.gemini.MODEL_FALLBACKS];
  return [...new Set(chain.map((m) => (m ?? '').trim()).filter(Boolean))];
}

interface GeminiCallResult {
  response: any;
  /** الموديل الذي نجح فعلًا (قد يكون بديلًا) */
  model: string;
}

/** استدعاء واحد بموديل ومفتاح محددين — مع مهلة إلغاء حقيقية */
async function singleCall(
  contents: GeminiContent[],
  systemInstruction: string,
  toolsEnabled: boolean,
  model: string,
  keyIndex: number,
): Promise<any> {
  const ai = getClient(keyIndex);
  const params: Record<string, any> = {
    model,
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
    // رسالة أوضح عند الإلغاء بالمهلة بدل "aborted" المبهمة
    if (controller.signal.aborted) {
      throw new Error(`Gemini timeout after ${config.gemini.TIMEOUT_MS}ms (model=${model})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * الاستدعاء الذكي: يجوب الموديلات والمفاتيح تلقائيًا.
 * - 404 على موديل → الموديل التالي في السلسلة
 * - 429 على مفتاح → المفتاح التالي، ولو نفدت كلها → الموديل التالي (حصة مستقلة)
 * - مفتاح خاطئ → تجربة باقي المفاتيح قبل الاستسلام
 */
async function callGemini(
  contents: GeminiContent[],
  systemInstruction: string,
  toolsEnabled: boolean,
): Promise<GeminiCallResult> {
  const keysCount = config.gemini.API_KEYS.length || 1;
  const models = buildModelChain();
  let lastErr: unknown = new Error('لا توجد موديلات مضبوطة');

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const isLastModel = mi === models.length - 1;

    for (let k = 0; k < keysCount; k++) {
      const keyIndex = (currentKeyIndex + k) % keysCount;
      try {
        const response = await singleCall(contents, systemInstruction, toolsEnabled, model, keyIndex);
        currentKeyIndex = keyIndex;
        if (mi > 0) log.warn(`✅ نجح الموديل الاحتياطي: ${model} (الأساسي ${models[0]} متعذّر حاليًا)`);
        return { response, model };
      } catch (err) {
        lastErr = err;
        const c = classifyGeminiError(err);
        const isLastKey = k === keysCount - 1;

        if (c.kind === 'model_not_found') {
          log.warn(`⚠️ الموديل ${model} غير متوفر (404) — ${isLastModel ? 'لا بدائل متبقية' : `تجربة ${models[mi + 1]}`}...`);
          break; // لا فائدة من تجربة مفاتيح أخرى لنفس الموديل الميت
        }
        if (c.kind === 'quota' || c.kind === 'invalid_key') {
          if (!isLastKey) {
            log.warn(`⚠️ المفتاح ${keyIndex + 1}/${keysCount} (${c.kind}) — التبديل للمفتاح التالي...`);
            continue;
          }
          if (c.kind === 'quota' && !isLastModel) {
            log.warn(`⚠️ الحصة منتهية على كل المفاتيح لـ ${model} — تجربة ${models[mi + 1]} (حصة مستقلة)...`);
            break;
          }
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

/**
 * توليد الرد عبر OpenAI (GPT-4o / GPT-4o-mini).
 * ينفّذ حلقة استدعاء الدوال حتى يعود النموذج برد نصي نهائي أو JSON.
 */
async function generateReplyOpenAI(input: AgentInput, started: number): Promise<AgentOutput> {
  void started;
  const openai = getOpenAiClient();
  const toolsCalled: AgentOutput['toolsCalled'] = [];
  const sideEffects: { kind: string; payload: Record<string, unknown>; tool: string }[] = [];
  const toolFallbacks: string[] = [];
  let promptTokens = 0;
  let candidatesTokens = 0;
  const modelUsed = config.openai.MODEL;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: input.systemPrompt },
  ];

  const turns = normalizeTurns(input.turns);
  if (input.extraContext && turns.length) {
    const last = turns[turns.length - 1];
    if (last.role === 'user') last.text = `${input.extraContext}\n\n${last.text}`;
  }

  for (const turn of turns) {
    if (turn.role === 'user') {
      const hasImage = turn.media?.some((m) => m.data && m.mimeType.startsWith('image/'));
      if (hasImage) {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
        if (turn.text) content.push({ type: 'text', text: turn.text });
        for (const m of turn.media ?? []) {
          if (m.data && m.mimeType.startsWith('image/')) {
            content.push({
              type: 'image_url',
              image_url: { url: `data:${m.mimeType};base64,${m.data}` },
            });
          } else if (m.note) {
            content.push({ type: 'text', text: m.note });
          }
        }
        messages.push({ role: 'user', content });
      } else {
        const textParts = [turn.text];
        for (const m of turn.media ?? []) {
          if (m.note) textParts.push(m.note);
        }
        messages.push({ role: 'user', content: textParts.filter(Boolean).join('\n') || '(رسالة فارغة)' });
      }
    } else {
      messages.push({ role: 'assistant', content: turn.text || '' });
    }
  }

  if (messages.length === 1) {
    const lastUserText =
      [...input.turns].reverse().find((t) => t.role === 'user')?.text?.trim() ||
      '(رسالة فارغة)';
    messages.push({ role: 'user', content: lastUserText });
  }

  const openAiTools = input.toolsEnabled ? getOpenAiTools() : undefined;
  const MAX_TOOL_LOOPS = 4;
  let finalText = '';

  for (let loop = 0; loop <= MAX_TOOL_LOOPS; loop++) {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: modelUsed,
      messages,
      temperature: config.openai.TEMPERATURE,
      max_tokens: config.openai.MAX_TOKENS,
      ...(openAiTools && openAiTools.length > 0 ? { tools: openAiTools } : {}),
      ...(!openAiTools || openAiTools.length === 0 ? { response_format: { type: 'json_object' } } : {}),
    };

    const completion = await retry<OpenAI.Chat.ChatCompletion>(
      () => openai.chat.completions.create(params),
      {
        retries: config.openai.RETRIES,
        label: `استدعاء OpenAI (${modelUsed})`,
      },
    );

    promptTokens += completion.usage?.prompt_tokens ?? 0;
    candidatesTokens += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices?.[0];
    const message = choice?.message;

    if (!message) break;

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);

      for (const tc of message.tool_calls) {
        if (tc.type !== 'function') continue;
        const name = tc.function.name;
        let args: Record<string, any> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }

        const result: ToolResult = await runTool(name, args, input.toolContext);
        toolsCalled.push({ name, args, result: result.data });

        if (result.sideEffect) {
          sideEffects.push({ kind: result.sideEffect.kind, payload: result.sideEffect.payload, tool: name });
          log.tool(`إجراء جانبي من ${name}: ${result.sideEffect.kind}`);
        }

        if (result.userMessage?.trim()) toolFallbacks.push(result.userMessage.trim());

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: result.ok,
            result: result.data,
            ...(result.userMessage ? { suggested_copy: result.userMessage } : {}),
          }),
        });
      }

      await sleep(50);
      continue;
    }

    finalText = message.content ?? '';
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
    else if (!parsed.handoff) {
      outParts = [
        'وصلتني رسالتك 👍 خلّيني أختصر عليك الطريق: أقدر أشرح لك *الباقات والأسعار*، أو *أحسب لك الأنسب* حسب عدد الطاولات، أو *أجهّز لك التفعيل* مباشرة.',
        'من وين تحب نبدأ؟',
      ];
      if (!parsed.intent) parsed.intent = 'عام';
    }
  }

  const supportTicket = toolsCalled.some((t) => t.name === 'create_support_ticket');
  const confirmedOrder = toolsCalled.find(
    (t) => t.name === 'confirm_launch_order' || t.name === 'capture_subscription_lead',
  );
  const orderRef =
    confirmedOrder && ((confirmedOrder.result as any)?.order_ref || (confirmedOrder.result as any)?.ref)
      ? String((confirmedOrder.result as any).order_ref ?? (confirmedOrder.result as any).ref)
      : undefined;

  return finishOutput({
    parts: outParts,
    handoff: parsed.handoff || supportTicket || Boolean(orderRef),
    reason:
      parsed.reason ??
      (orderRef ? `طلب إطلاق مؤكد ${orderRef} — حُوّل لمدير المنصة` : undefined) ??
      (supportTicket ? 'تذكرة دعم فُتحت — متابعة بشرية' : undefined),
    orderRef,
    intent: parsed.intent,
    sentiment: parsed.sentiment,
    quickReplies: parsed.quickReplies,
    toolsCalled,
    sideEffects,
    usage: { promptTokens, candidatesTokens },
    model: modelUsed,
    engine: 'openai',
    fallbackModel: false,
    rawText: finalText,
  });
}

/**
 * توليد الرد — بوابة آمنة لا ترمي خطأ للعميل أبدًا:
 * يوجّه الطلب إلى OpenAI أو Gemini حسب الضبط مع دعم التراجع الذكي.
 * كل مسار يوسم الرد بـ aiStatus صريح — لا «نجاح» زائف أبدًا.
 */
export async function generateReply(input: AgentInput): Promise<AgentOutput> {
  const started = Date.now();

  if (config.llm.PROVIDER === 'openai') {
    if (!config.openai.API_KEY) {
      return mockReply(input, started, config.env.DEMO_MODE ? 'demo_mode' : 'ai_unavailable');
    }
    try {
      const out = await generateReplyOpenAI(input, started);
      return { ...out, aiStatus: 'ai_success', degraded: false };
    } catch (err) {
      log.error(`فشل OpenAI: ${(err as Error).message}`);
      if (config.gemini.API_KEY) {
        try {
          log.warn('↩️ التبديل التلقائي إلى Gemini كبديل لـ OpenAI...');
          const out = await generateReplyInner(input, started);
          return {
            ...out,
            aiStatus: out.aiStatus === 'ai_degraded' ? 'ai_degraded' : 'ai_degraded',
            degraded: out.aiStatus === 'ai_unavailable',
            degradedReason: out.degradedReason ?? `OpenAI error: ${(err as Error).message} → answered by Gemini`,
          };
        } catch (geminiErr) {
          log.error(`فشل Gemini الاحتياطي أيضًا: ${(geminiErr as Error).message}`);
        }
      }
      const fb = mockReply(input, started, 'ai_unavailable');
      return { ...fb, degraded: true, degradedReason: `OpenAI error: ${(err as Error).message}` };
    }
  }

  if (!config.gemini.API_KEY) {
    return mockReply(input, started, config.env.DEMO_MODE ? 'demo_mode' : 'ai_unavailable');
  }

  try {
    const out = await generateReplyInner(input, started);
    if (out.aiStatus === 'ai_unavailable') return out; // حلقة الأدوات فشلت كليًا داخل المزود نفسه
    return {
      ...out,
      aiStatus: out.fallbackModel ? 'ai_degraded' : 'ai_success',
      degraded: false,
    };
  } catch (err) {
    const c = classifyGeminiError(err);
    log.error(`فشل Gemini نهائيًا (${c.kind}): ${(err as Error).message}`);
    log.warn(`↩️ الرد الاحتياطي المحلي مفعّل — ${c.hint}`);
    const fb = mockReply(input, started, 'ai_unavailable');
    return { ...fb, degraded: true, degradedReason: `${c.kind}: ${c.hint}` };
  }
}

/**
 * الرد الاحتياطي المحلي — متاح للمنسّق أيضًا كملاذ أخير.
 * يستخدم نفس بيانات الباقات الرسمية (plans.ts) فلا تخمين ولا أسعار خاطئة.
 */
export function offlineFallbackReply(input: AgentInput, reason: string): AgentOutput {
  const fb = mockReply(input, Date.now(), 'ai_unavailable');
  return { ...fb, degraded: true, degradedReason: reason };
}

/**
 * توليد الرد عبر Gemini.
 * ينفّذ حلقة استدعاء الدوال حتى يعود النموذج برد نصي نهائي.
 */
async function generateReplyInner(input: AgentInput, started: number): Promise<AgentOutput> {
  void started;
  const turns = normalizeTurns(input.turns);

  if (input.extraContext && turns.length) {
    const last = turns[turns.length - 1];
    if (last.role === 'user') last.text = `${input.extraContext}\n\n${last.text}`;
  }

  const contents: GeminiContent[] = turns.map(turnToContent);

  // حماية: لا نرسل سجلًا فارغًا أبدًا (Google ترفضه بـ 400)
  if (contents.length === 0) {
    const lastUserText =
      [...input.turns].reverse().find((t) => t.role === 'user')?.text?.trim() ||
      '(رسالة فارغة)';
    contents.push({ role: 'user', parts: [{ text: lastUserText }] });
  }

  const toolsCalled: AgentOutput['toolsCalled'] = [];
  const sideEffects: { kind: string; payload: Record<string, unknown>; tool: string }[] = [];
  let promptTokens = 0;
  let candidatesTokens = 0;
  let finalText = '';
  let modelUsed = config.gemini.MODEL;
  const toolFallbacks: string[] = [];

  const MAX_TOOL_LOOPS = 4;

  for (let loop = 0; loop <= MAX_TOOL_LOOPS; loop++) {
    const call = await retry<GeminiCallResult>(
      () => callGemini(contents, input.systemPrompt, input.toolsEnabled),
      {
        retries: config.gemini.RETRIES,
        label: 'استدعاء Gemini',
        shouldRetry: (err) => classifyGeminiError(err).retryable,
      },
    );
    const response: any = call.response;
    modelUsed = call.model;

    promptTokens += response?.usageMetadata?.promptTokenCount ?? 0;
    candidatesTokens += response?.usageMetadata?.candidatesTokenCount ?? 0;

    const finish = response?.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      const blockReason = response?.promptFeedback?.blockReason;
      log.warn(`النموذج أنهى الرد بسبب: ${finish}${blockReason ? ` / ${blockReason}` : ''}`);
      if (finish === 'SAFETY' || blockReason) {
        return finishOutput({
          parts: ['وصلتني — بس ما قدرت أعالج هذي الصيغة بالذات. وضّح لي طلبك بكلمات ثانية وأنا معك خطوة بخطوة 👍'],
          handoff: false,
          intent: 'عام',
          toolsCalled,
          sideEffects,
          usage: { promptTokens, candidatesTokens },
          model: modelUsed,
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
    else if (!parsed.handoff) {
      // النموذج لم يخرج نصًا — رد بشري مفيد بدل الصمت أو رسالة خطأ باردة
      outParts = [
        'وصلتني رسالتك 👍 خلّيني أختصر عليك الطريق: أقدر أشرح لك *الباقات والأسعار*، أو *أحسب لك الأنسب* حسب عدد الطاولات، أو *أجهّز لك التفعيل* مباشرة.',
        'من وين تحب نبدأ؟',
      ];
      if (!parsed.intent) parsed.intent = 'عام';
    }
  }

  const supportTicket = toolsCalled.some((t) => t.name === 'create_support_ticket');
  const confirmedOrder = toolsCalled.find(
    (t) => t.name === 'confirm_launch_order' || t.name === 'capture_subscription_lead',
  );
  const orderRef =
    confirmedOrder && ((confirmedOrder.result as any)?.order_ref || (confirmedOrder.result as any)?.ref)
      ? String((confirmedOrder.result as any).order_ref ?? (confirmedOrder.result as any).ref)
      : undefined;

  return finishOutput({
    parts: outParts,
    handoff: parsed.handoff || supportTicket || Boolean(orderRef),
    reason:
      parsed.reason ??
      (orderRef ? `طلب إطلاق مؤكد ${orderRef} — حُوّل لمدير المنصة` : undefined) ??
      (supportTicket ? 'تذكرة دعم فُتحت — متابعة بشرية' : undefined),
    orderRef,
    intent: parsed.intent,
    sentiment: parsed.sentiment,
    quickReplies: parsed.quickReplies,
    toolsCalled,
    sideEffects,
    usage: { promptTokens, candidatesTokens },
    model: modelUsed,
    engine: 'gemini',
    fallbackModel: modelUsed !== (buildModelChain()[0] ?? config.gemini.MODEL),
    rawText: finalText,
  });
}

function stripThought(part: any): any {
  if (part?.thought) return { text: '' };
  if (typeof part?.text === 'string') return { text: part.text };
  if (part?.functionCall) return { functionCall: part.functionCall };
  return part;
}

/**
 * ملخص محلي حقيقي لو كان المشروع في وضع التجربة أو انقطعت مفاتيح النموذج.
 * لا نضع عبارة عامة مثل «لا يوجد ملخص» لأن ذلك يمحو ذاكرة العميل عند طول الحوار.
 */
function localConversationSummary(history: string, existingSummary: string): string {
  const lines = history
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^نظام\s*:/.test(line));
  const recent = lines.slice(-10);
  const merged = [existingSummary.trim(), ...recent]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  return merged.slice(-1800) || 'بدأت المحادثة حديثًا ولم تُسجّل تفاصيل كافية بعد.';
}

export async function summarizeConversation(history: string, existingSummary: string, promptBuilder: (s: string) => string): Promise<string> {
  if (config.llm.PROVIDER === 'openai') {
    if (!config.openai.API_KEY) return localConversationSummary(history, existingSummary);
    try {
      const openai = getOpenAiClient();
      const completion = await openai.chat.completions.create({
        model: config.openai.FAST_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: promptBuilder(existingSummary) },
          { role: 'user', content: history },
        ],
        temperature: 0.3,
        max_tokens: 400,
      });
      return completion.choices?.[0]?.message?.content?.trim() || localConversationSummary(history, existingSummary);
    } catch (err) {
      log.warn(`تعذّر التلخيص عبر OpenAI: ${(err as Error).message}`);
      return localConversationSummary(history, existingSummary);
    }
  }

  if (!config.gemini.API_KEY) return localConversationSummary(history, existingSummary);

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

    return text || localConversationSummary(history, existingSummary);
  } catch (err) {
    log.warn(`تعذّر التلخيص: ${(err as Error).message}`);
    return localConversationSummary(history, existingSummary);
  }
}

// ─────────────────────────── محرك التجربة (بدون مفتاح) ───────────────────────────

function nameFromPrompt(systemPrompt: string): string {
  const m = systemPrompt.match(/اسم العميل في واتساب:\s*([^\n]+)/);
  return firstNameOf(m?.[1]?.trim() ?? '');
}

/**
 * استرجاع تفاصيل التجهيز من سجل المحادثة (نسخة التجربة):
 * يمرّ على أزواج (سؤال البوت ← جواب العميل) ويملأ الخانات.
 */
function parseActivationSlots(turns: Turn[]): {
  name?: string;
  restaurant?: string;
  city?: string;
  tables?: number;
  plan?: PlanId;
} {
  const slots: { name?: string; restaurant?: string; city?: string; tables?: number; plan?: PlanId } = {};
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'model') {
      const u = t.text;
      const mTables = u.match(/(?:^|\s|[^\d])(\d{1,3})\s*(?:طاولة|طاولات|طاوله|طاو|table|tables)\b/i)
        || (u.trim().match(/^\d{1,3}$/) ? u.trim().match(/^(\d{1,3})$/) : null);
      if (mTables && !slots.tables) slots.tables = Number(mTables[1]);
      if (/أساسية|اساسية|starter/i.test(u) && !slots.plan) slots.plan = 'starter';
      else if (/احترافية|احتراف|pro\b/i.test(u) && !slots.plan) slots.plan = 'pro';
      else if (/مؤسسات|سلاسل|enterprise/i.test(u) && !slots.plan) slots.plan = 'enterprise';
      continue;
    }
    const next = turns[i + 1];
    const u = next && next.role === 'user' ? next.text.trim().split('\n')[0]!.trim() : '';
    if (/شو اسمك/.test(t.text)) {
      if (u && u.split(/\s+/).length <= 4) slots.name = u.slice(0, 40);
    } else if (/واسم المطعم|اسم المطعم/.test(t.text)) {
      if (u) slots.restaurant = u.slice(0, 60);
    } else if (/بأي مدينة/.test(t.text)) {
      if (u) slots.city = u.slice(0, 40);
    } else if (/كم طاولة تشتغل عندك\؟|كم طاولة عندك/.test(t.text)) {
      const m = u.match(/(\d{1,3})/);
      if (m) slots.tables = Number(m[1]);
    } else if (/نثبت على/.test(t.text)) {
      const p = planIdFromText(t.text);
      if (p) slots.plan = p;
      const chosen = u ? planIdFromText(u) : null;
      if (chosen) slots.plan = chosen;
    }
  }
  return slots;
}

/** خانات التجهيز المحفوظة في ملف الجلسة — التعديلات المؤكدة تتقدم على قراءة السجل */
function savedSlots(sessionKey: string): { name?: string; restaurant?: string; city?: string; tables?: number; plan?: PlanId } {
  const p = store.get(sessionKey).profile;
  if (!p) return {};
  const out: { name?: string; restaurant?: string; city?: string; tables?: number; plan?: PlanId } = {};
  if (p.full_name) out.name = p.full_name;
  if (p.restaurant_name) out.restaurant = p.restaurant_name;
  if (p.city) out.city = p.city;
  if (p.tables && p.tables > 0) out.tables = p.tables;
  const plan = planIdFromText(String(p.preferred_plan ?? ''));
  if (plan) out.plan = plan;
  return out;
}

/** سجل المحادثة + ملف الجلسة معًا — المحفوظ يتقدم */
function collectSlots(turns: Turn[], sessionKey: string): { name?: string; restaurant?: string; city?: string; tables?: number; plan?: PlanId } {
  return { ...parseActivationSlots(turns), ...savedSlots(sessionKey) };
}

/**
 * يعمل بدون GEMINI_API_KEY حتى تقدر تجرب المسار الكامل.
 * الردود قواعد بسيطة — لكن بنفس نبرة الإنسان المتحمّس، لا سكربت جاف.
 */
function mockReply(input: AgentInput, _started: number, aiStatus: 'ai_unavailable' | 'demo_mode' = 'ai_unavailable'): AgentOutput {
  const custState = store.get(input.toolContext.sessionKey).customer;
  const hasKnownPain = Boolean(custState?.painPoints?.length);
  const lastUser = [...input.turns].reverse().find((t) => t.role === 'user');
  const raw = lastUser?.text ?? '';
  const text = raw.toLowerCase();
  const hasMedia = Boolean(lastUser?.media?.length);
  const lastModelText = [...input.turns].reverse().find((t) => t.role === 'model')?.text ?? '';
  const slots = collectSlots(input.turns, input.toolContext.sessionKey);
  /** اعتراض صريح في نص العميل — يسبق أي مسار جمع بيانات (لا «وصلت التفاصيل» على «غالي») */
  const objectionEarly = /(?:غالي|غاليه|مرتفع|مكلف|بفكر|افكر|بعدين|لاحقا|مش متاكد|متردد|ميزانيه|اكتر من ميزانيتي|ما في فايده|مو مقتنع|معقد|معقده|صعب عليا|ما بثق|مو واثق|خليني افكر)/i.test(text);
  const name = slots.name || nameFromPrompt(input.systemPrompt);
  const vocative = name ? `${name}، ` : '';
  const askedActivation = /أجهّز لك التفعيل|أجهز لك التفعيل|أجهز التفعيل|تبيني أجه|خلّينا نجه|شو اسمك|أرسل لي: اسمك/.test(lastModelText);
  const askedName = /شو اسمك|ما اسمك|اسمك\؟/.test(lastModelText);
  // خطوات التجهيز للإطلاق (نسخة التجربة): مطعم ← مدينة ← طاولات ← باقة ← تصور ← تأكيد
  const askedRestaurant = /واسم المطعم/.test(lastModelText);
  const askedCity = /بأي مدينة/.test(lastModelText);
  const askedTables = /كم طاولة تشتغل عندك\؟/.test(lastModelText);
  const askedPlanConfirm = /نثبت على/.test(lastModelText);
  const askedConfirm = /(أكّد|تأكيد) الطلب/.test(lastModelText);
  const askedEdit = /وش تبي تعدّل/.test(lastModelText);
  // النية الحقيقية تتغلب على التحية: «هلا، بكم الباقات؟» = سؤال أسعار لا تحية
  const hasRealIntent = /سعر|أسعار|اسعار|بكم|تكلف|باقة|باقات|طاول|اشترك|تفعيل|أبدأ|ابدأ|نبدأ|يلا|مشكلة|تقني|غالي|بفكر|افكر|أفكر|فروع|سلسلة|مطبخ|kds|pos|موظف|بشري|شكرا|شكرًا|تأكيد|أكّد|طلب|qr:/.test(text);
  let mockButtons: QuickReply[] | undefined;
  let mockOrderRef: string | undefined;
  let mockSideEffects: AgentOutput['sideEffects'] = [];

  const parts: string[] = [];
  let handoff = false;
  let intent = 'غير_مصنف';

  const planList = () =>
    MUREEH_PLANS.map((p) => {
      const short =
        p.id === 'starter' ? 'منيو رقمي فاخر QR + كاشير + استدعاء نادل' :
        p.id === 'pro' ? 'شاشة مطبخ KDS، POS، تحليلات، هوية بصرية' :
        'فروع متعددة، سعة مفتوحة، نطاق خاص، مدير حساب';
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
  } else if (/حجز|احجز|أحجز|موعد|مواعيد|المواعيد/.test(text)) {
    intent = 'حجز';
    const a = availability();
    const next = nextAvailableDays(2);
    if (next.length > 0) {
      parts.push(`بتحجز موعد تفعيل مع الفريق؟ 👌 ساعات الحجز: ${formatAvailabilityText()}`);
      parts.push(next.map((d) => `• ${d.date} (${d.dayName}): ${d.slots.join('، ')}`).join('\n'));
      parts.push('أي تاريخ ووقت يناسبك؟ أتحقق لك وأثبّت الحجز.');
    } else {
      parts.push('ما في مواعيد متاحة حاليًا — بوصلك بالفريق يرتبون لك مباشرة.');
    }
  } else if (!hasRealIntent && /كيفك|كيف حالك|شخبارك|عامل ايه|whats up/.test(text)) {
    intent = 'تحية';
    if (slots.restaurant || slots.tables) {
      parts.push(`${vocative}تمام والحمد لله، وأنت؟ 🙌 كيف أقدر أساعد ${slots.restaurant ? `مطعم ${slots.restaurant}` : 'مطعمك'} اليوم؟`);
    } else {
      parts.push(`${vocative}تمام والحمد لله، وأنت؟ 🙌 خلينا نفيد مطعمك: كم طاولة تشتغل عندك؟`);
    }
  } else if (!hasRealIntent && ((/سلام|مرحبا|هلا|اهلا|أهلًا|hi\b|hello|hey|صباح|مساء/.test(text) && text.length < 80) || click && /هلا|hi/.test(text))) {
    intent = 'تحية';
    const g = greetingWord(dayPart());
    if (slots.restaurant || slots.tables) {
      parts.push(`${g}${name ? ` ${name}` : ''} 👋 أنا ${config.bot.BOT_NAME} — معك في ${slots.restaurant ? `مطعم ${slots.restaurant}` : 'مطعمك'}.`);
      if (slots.tables && slots.plan) {
        const p = getPlan(slots.plan);
        parts.push(`مسجل عندي *${slots.tables} طاولة* على *${p.name}*. تفضل، كيف أقدر أخدمك اليوم؟`);
      } else if (slots.tables) {
        const rec = recommendPlan({ tables: slots.tables });
        parts.push(`مسجل عندي *${slots.tables} طاولة* — أنسب باقة لك هي *${rec.plan.name}*. تبيني أجهز لك التفعيل؟`);
      } else {
        parts.push('كيف أقدر أساعدك اليوم بخصوص تفاصيل وتطوير مطعمك؟');
      }
    } else {
      parts.push(`${g}${name ? ` ${name}` : ''} 👋 أنا ${config.bot.BOT_NAME} — منيو QR، شاشة مطبخ حية، وكاشير من الرمز على الطاولة.`);
      parts.push('كم طاولة تشتغل عندك؟ أحسب لك الباقة اللي تفرق معك فعلًا.');
    }
  } else if (objectionEarly && !askedConfirm) {
    // معالجة اعتراض استشارية — أولوية على مسارات الجمع: لا «وصلت التفاصيل» على «غالي» أبدًا
    intent = 'اعتراض_سعري';
    const rec = recommendPlan({ tables: slots.tables });
    const p = rec.plan;
    const perTable = slots.tables ? perTableMonthly(p, slots.tables) : undefined;
    parts.push(`${vocative}مفهوم تمامًا، والسعر يُحسب 👍 خلّيني أوضح الصورة بالأرقام الرسمية: *${p.name}* *${p.priceMonthly} ₪/شهر*${perTable ? ` — يعني ~*${perTable} ₪* بس للطاولة` : ''}.`);
    parts.push(`وبدون بطاقة للبدء، وترقية أو إلغاء بأي وقت. ولو احتياجك حاليًا المنيو الرقمي والطلبات فقط، *الباقة الأساسية* *300 ₪/شهر* تكفي وتزيد لاحقًا بضغطة.`);
  } else if (askedName && raw.trim().split(/\s+/).length <= 4 && !/سعر|باقة/.test(text)) {
    intent = 'طلب_تفعيل';
    parts.push(`تسلم${name ? ' ' + name : ''}. واسم المطعم؟`);
  } else if (askedActivation && (isAffirmative(raw) || /اسمي|المطعم|مقهى|كافيه|مطعمي/.test(text) || /\d/.test(text))) {
    intent = 'بيانات_تفعيل';
    if (isAffirmative(raw) && !/\d/.test(text) && !/مطعم|مقهى/.test(text)) {
      parts.push(name
        ? `يا سلام يا ${name}، خلّينا نجهّزها 🔥 واسم المطعم؟`
        : 'يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
      intent = 'طلب_تفعيل';
    } else {
      parts.push(`✅ وصلت التفاصيل${name ? ' يا ' + name : ''}. فريق مُريح يتواصل معك الآن لاستكمال التجهيز — خلال دقائق عادة وبدون بطاقة ائتمانية للبدء 🚀`);
    }
  } else {
    const m = text.match(/(\d{1,3})\s*(?:طاولة|طاولات|طاو|table)/);
    // لو سألنا عن الطاولات ضمن التجهيز، الجواب يُكمل المسار ولا يبدأ توصية جديدة
    if (m && !askedTables) {
      intent = 'توصية_باقة';
      const tables = Number(m[1]);
      const rec = recommendPlan({ tables });
      const p = rec.plan;
      const perTable = perTableMonthly(p, tables);
      parts.push(`لـ*${tables} طاولة* أنصحك بـ*${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' (الأكثر طلبًا)' : ''}، يعني ~*${perTable} ₪* بس للطاولة الواحدة.`);
      // اكتشاف الألم قبل الدفع للبيع: بلا ألم معروف، السؤال التالي هو التشخيص لا الإغلاق
      if (hasKnownPain) {
        parts.push(`${rec.reason}، والدفع السنوي يوفّر عليك *${p.yearlySavings} ₪*. تبيني أجهّز لك التفعيل؟`);
      } else {
        parts.push(`${rec.reason}، والدفع السنوي يوفّر عليك *${p.yearlySavings} ₪*. وأكثر شيء يسبب لك مشكلة حاليًا: تأخير النادل، ضياع أو اختلاط الطلبات، ولا الحسابات اليدوية آخر اليوم؟`);
      }
    }
  }

  if (parts.length === 0 && (/أبدأ التفعيل|جهز لي التفعيل|qr:activate/.test(text) || /اشترك|أشترك|اشتراك|تفعيل|أبدأ|ابدأ|نبدأ|يلا|subscribe/.test(text))) {
    intent = 'طلب_تفعيل';
    const isQuestion = /كيف|وش|هل|متى|متي|لماذا|why|how/.test(text);
    const words = text.trim().split(/\s+/).length;
    const hasDetails = words >= 6 || (/\d/.test(text) && /مطعم|مقهى|كافيه/.test(text));
    if (isQuestion) {
      parts.push('التفعيل خلال دقائق عادةً، وبدون بطاقة ائتمانية للبدء 🚀');
      parts.push(name
        ? `أربع خطوات بسيطة والفريق معك فيها. تبيني نبدأ؟ واسم المطعم؟`
        : 'أربع خطوات بسيطة والفريق معك فيها. تبيني نبدأ؟ شو اسمك؟');
    } else if (hasDetails) {
      parts.push('✅ وصلتني طلبك. الفريق يتواصل معك الآن لاستكمال التجهيز — خلال دقائق وبدون بطاقة للبدء 🚀');
    } else {
      parts.push(name
        ? `يا سلام يا ${name}، خلّينا نجهّزها 🔥 واسم المطعم؟`
        : 'يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
    }
  }

  if (parts.length === 0 && !askedPlanConfirm && (/فروع|سلسلة|سلاسل|enterprise|chain|المؤسسات 850|qr:enterprise/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('enterprise');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* (≈ ${p.priceYearlyPerMonth} ₪ عند السنوي):`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('كم فرعًا عندك حاليًا؟');
  }

  if (parts.length === 0 && !askedPlanConfirm && (/احتراف|pro|kds|مطبخ|pos|الاحترافية 550|qr:pro/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('pro');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر* ← الأكثر طلبًا.`);
    parts.push(p.features.map((f) => `• ${f}`).join('\n'));
    parts.push('تبيني أجهّز لك التفعيل؟');
  }

  if (parts.length === 0 && !askedPlanConfirm && (/أساسية|starter|الأساسية 300|qr:starter/.test(text))) {
    intent = 'استفسار_باقات';
    const p = getPlan('starter');
    parts.push(`*${p.name}* — *${p.priceMonthly} ₪/شهر*. بداية نظيفة لمنيو QR وكاشير واستدعاء نادل.`);
    if (slots.tables) {
      parts.push(`لمطعمك (${slots.tables} طاولة) السعر بيكون ~*${perTableMonthly(p, slots.tables)} ₪* بس للطاولة. تبيني أجهّز لك التفعيل؟`);
    } else {
      parts.push('تقدر ترقّي في أي وقت من اللوحة. كم طاولة عندك؟');
    }
  }

  if (parts.length === 0 && (/سعر|أسعار|اسعار|بكم|تكلف|باقة|باقات|price|plan|package|الأسعار والباقات|qr:prices|أنصحني/.test(text))) {
    intent = 'استفسار_أسعار';
    parts.push(`ثلاث باقات، بدون عقود وبدون رسوم مخفية:\n${planList()}\n\nالدفع السنوي يوفّر شهرين كاملين.`);
    if (slots.tables) {
      const rec = recommendPlan({ tables: slots.tables });
      parts.push(`بما أن مسجل عندي *${slots.tables} طاولة*، فالأنسب لك هي *${rec.plan.name}* (~*${perTableMonthly(rec.plan, slots.tables)} ₪* للطاولة). تبيني أجهّز لك التفعيل؟`);
    } else {
      parts.push('كم طاولة تشتغل عندك؟ أحسب لك الأنسب.');
    }
  }

  if (parts.length === 0 && askedActivation && isAffirmative(raw)) {
    intent = 'طلب_تفعيل';
    parts.push(name
      ? `يا سلام يا ${name}، خلّينا نجهّزها 🔥 واسم المطعم؟`
      : 'يا سلام، خلّينا نجهّزها 🔥 شو اسمك؟');
  }

  // ── التجهيز للإطلاق: مطعم ← مدينة ← طاولات ← باقة ← تصور ← تأكيد ← مدير المنصة
  if (parts.length === 0 && askedRestaurant && raw.trim()) {
    intent = 'تجهيز_إطلاق';
    parts.push(`تمام، *${raw.trim().split('\n')[0]!.slice(0, 40)}* — اسم حلو 👍 بأي مدينة المطعم؟`);
  }

  if (parts.length === 0 && askedCity && raw.trim()) {
    intent = 'تجهيز_إطلاق';
    if (slots.tables) {
      const rec = recommendPlan({ tables: slots.tables });
      const p = rec.plan;
      parts.push(`ممتاز. مسجل عندي *${slots.tables} طاولة* — أنسب شيء *${p.name}* — *${p.priceMonthly} ₪/شهر* (~*${perTableMonthly(p, slots.tables)} ₪* للطاولة).`);
      parts.push(`نثبت على *${p.name}*؟`);
      mockButtons = [
        { id: 'qr:plan-yes', title: 'نعم ثبتها' },
        { id: 'qr:edit', title: 'غيّر الباقة' },
      ];
    } else {
      parts.push('ممتاز. كم طاولة تشتغل عندك؟');
    }
  }

  if (parts.length === 0 && askedTables) {
    const tm = text.match(/(\d{1,3})/);
    if (tm) {
      intent = 'تجهيز_إطلاق';
      const tCount = Number(tm[1]);
      const rec = recommendPlan({ tables: tCount });
      const p = rec.plan;
      parts.push(`لـ*${tCount} طاولة* أنسب شيء *${p.name}* — *${p.priceMonthly} ₪/شهر* (~*${perTableMonthly(p, tCount)} ₪* للطاولة).`);
      // بلا ألم معروف: التشخيص قبل التثبيت — لا إغلاق مبكر على من لم يتألم بعد
      if (hasKnownPain) {
        parts.push(`نثبت على *${p.name}*؟`);
        mockButtons = [
          { id: 'qr:plan-yes', title: 'نعم ثبتها' },
          { id: 'qr:edit', title: 'غيّر الباقة' },
        ];
      } else {
        parts.push('وأكثر شيء يسبب لك مشكلة حاليًا: تأخير النادل، ضياع أو اختلاط الطلبات، ولا الحسابات اليدوية آخر اليوم؟');
      }
    } else {
      intent = 'تجهيز_إطلاق';
      parts.push('اكتب لي عدد الطاولات رقمًا — مثلًا: 25');
    }
  }

  if (parts.length === 0 && askedPlanConfirm) {
    const chosen = planIdFromText(raw);
    if (chosen || isAffirmative(raw) || /نثبت|ثبت|تمام|أكيد/.test(text)) {
      intent = 'تأكيد_طلب';
      const slots = collectSlots(input.turns, input.toolContext.sessionKey);
      const plan: PlanId = chosen ?? slots.plan ?? planIdFromText(lastModelText) ?? 'pro';
      const profile = {
        full_name: slots.name || name || undefined,
        restaurant_name: slots.restaurant,
        city: slots.city,
        branches: 1,
        tables: slots.tables,
        preferred_plan: plan,
      };
      // حفظ الملف والتصور في الجلسة (يظهران في لوحة التحكم)
      store.patchProfile(input.toolContext.sessionKey, profile);
      store.patchLaunch(input.toolContext.sessionKey, {
        status: 'awaiting_confirmation',
        blueprint: buildBlueprintText(profile),
      });
      parts.push(buildBlueprintText(profile));
      parts.push('هذا تصور نسختك كاملًا 👆 لو كل شيء تمام اضغط *تأكيد الطلب* — وأي تعديل اكتبه لي.');
      mockButtons = [
        { id: 'qr:confirm', title: 'تأكيد الطلب' },
        { id: 'qr:edit', title: 'تعديل' },
      ];
    } else {
      // لم يؤكد — إن كان رده وصف ألم/مشكلة فنعالجه بدل إعادة سرد القائمة
      const pains = detectPainPoints(raw);
      if (pains.length > 0) {
        intent = 'مقارنة_وضع_حالي';
        const chosenPlan = getPlan((slots.plan ?? planIdFromText(lastModelText) ?? 'pro') as PlanId);
        parts.push('واضح، وهذي بالضبط شغل النظام 👌 طلبك يوصل المطبخ لحظة إدخاله والطلبات ما تضيع ولا تنخلط.');
        parts.push(`نعيد السؤال: نثبت على *${chosenPlan.name}* ونجهز نسختك؟ (أو اكتبلي تعديلك)`);
        mockButtons = [
          { id: 'qr:plan-yes', title: 'نعم ثبتها' },
          { id: 'qr:edit', title: 'تعديل' },
        ];
      } else {
        intent = 'استفسار_أسعار';
        parts.push(`ولا يهمك 👍 ثلاث باقات:\n${planList()}\n\nأي وحدة نثبت عليها؟ اكتب اسمها.`);
      }
    }
  }

  if (parts.length === 0 && askedConfirm) {
    const wantsEdit =
      /تعديل|عدّل|عدل|تبديل|غيّر|غير|لا |لا$|لسه|اصبر|شوي/.test(text) &&
      !/أكّد|تأكيد|نعم|تمام|موافق|أكيد/.test(text);
    if (wantsEdit) {
      intent = 'تجهيز_إطلاق';
      const num = text.match(/(\d{1,3})/);
      const tablesEdit = num && /طاول/.test(text) ? Number(num[1]) : undefined;
      if (tablesEdit) {
        // التعديل وصل كاملًا في نفس الرسالة — نطبّقه ونعيد التأكيد فورًا
        const slots = collectSlots(input.turns, input.toolContext.sessionKey);
        const plan: PlanId = slots.plan ?? planIdFromText(lastModelText) ?? 'pro';
        const profile = {
          full_name: slots.name || name || undefined,
          restaurant_name: slots.restaurant,
          city: slots.city,
          branches: 1,
          tables: tablesEdit,
          preferred_plan: plan,
        };
        store.patchProfile(input.toolContext.sessionKey, profile);
        store.patchLaunch(input.toolContext.sessionKey, {
          status: 'awaiting_confirmation',
          blueprint: buildBlueprintText(profile),
        });
        const p = getPlan(plan);
        parts.push(`ظبطتها ✅ صارت *${tablesEdit} طاولة* — يعني ~*${perTableMonthly(p, tablesEdit)} ₪* للطاولة على *${p.name}*. أكّد الطلب؟`);
        mockButtons = [
          { id: 'qr:confirm', title: 'تأكيد الطلب' },
          { id: 'qr:edit', title: 'تعديل' },
        ];
      } else {
        parts.push('تمام، وش تبي تعدّل؟ اكتبه لي بجملة وحدة وأنا أظبطه.');
      }
    } else {
      intent = 'تأكيد_طلب';
      handoff = true;
      mockOrderRef = `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const slots = collectSlots(input.turns, input.toolContext.sessionKey);
      const plan: PlanId = slots.plan ?? planIdFromText(lastModelText) ?? 'pro';
      const profile = {
        full_name: slots.name || name || undefined,
        restaurant_name: slots.restaurant,
        city: slots.city,
        branches: 1,
        tables: slots.tables,
        preferred_plan: plan,
        whatsapp_number: input.toolContext.sessionKey.startsWith('tg:') ? undefined : input.toolContext.sessionKey,
      };
      mockSideEffects = [{
        kind: 'notify_manager',
        payload: {
          note: managerOrderMessage(profile, mockOrderRef, input.toolContext.sessionKey),
          orderRef: mockOrderRef,
        },
        tool: 'mock_confirm',
      }];
      // حفظ الطلب المؤكد في الجلسة (يظهر في لوحة التحكم)
      store.patchProfile(input.toolContext.sessionKey, profile);
      store.patchLaunch(input.toolContext.sessionKey, {
        status: 'confirmed',
        blueprint: buildBlueprintText(profile),
        orderRef: mockOrderRef,
        confirmedAt: Date.now(),
      });
      parts.push(`تم تأكيد طلبك ✅ رقم الطلب: *${mockOrderRef}*`);
      parts.push('ملفك الكامل وصل *مدير المنصة* — يتواصل معك ويجهز نسختك، خلال دقائق عادة وبدون بطاقة للبدء 🚀');
    }
  }

  if (parts.length === 0 && askedEdit && raw.trim()) {
    intent = 'تأكيد_طلب';
    const num = text.match(/(\d{1,3})/);
    const tablesEdit = num && /طاول/.test(text) ? Number(num[1]) : undefined;
    if (tablesEdit) {
      const slots = collectSlots(input.turns, input.toolContext.sessionKey);
      const plan: PlanId = slots.plan ?? planIdFromText(lastModelText) ?? 'pro';
      const profile = {
        full_name: slots.name || name || undefined,
        restaurant_name: slots.restaurant,
        city: slots.city,
        branches: 1,
        tables: tablesEdit,
        preferred_plan: plan,
      };
      store.patchProfile(input.toolContext.sessionKey, profile);
      store.patchLaunch(input.toolContext.sessionKey, {
        status: 'awaiting_confirmation',
        blueprint: buildBlueprintText(profile),
      });
      const p = getPlan(plan);
      parts.push(`ظبطتها ✅ صارت *${tablesEdit} طاولة* — يعني ~*${perTableMonthly(p, tablesEdit)} ₪* للطاولة على *${p.name}*. أكّد الطلب؟`);
    } else {
      parts.push(`وصل التعديل ✅ (${raw.trim().split('\n')[0]!.slice(0, 80)}) — سجّلته مع طلبك.`);
      parts.push('أكّد الطلب؟');
    }
    mockButtons = [
      { id: 'qr:confirm', title: 'تأكيد الطلب' },
      { id: 'qr:edit', title: 'تعديل' },
    ];
  }

  // «تمام» أثناء التأكيد = موافقة لا شكر — لا نكسر المسار برد الشكر
  if (parts.length === 0 && !askedConfirm && !askedPlanConfirm && /شكرا|شكرًا|تمام|ممتاز|رائع|thanks|great|awesome/.test(text)) {
    intent = 'إيجابي';
    parts.push(`العفو${name ? ' ' + name : ''} 🙌 أي سؤال ثاني عن الباقات أو التفعيل، أنا هنا.`);
  }

  // اعتراض سعري / تردد — معالجة استشارية لا ضغط بيعي
  if (parts.length === 0 && /غالي|غالية|سعر مرتفع|بفكر|افكر|أفكر|أفكّر|بعدين|مش متأكد|متردد|فكر فيها|ميزانية/.test(text)) {
    intent = 'اعتراض_سعري';
    parts.push(`${vocative}طبيعي تفكر بالسعر — وهذا سؤال الذكي 👍 خلّيني أوضح الصورة: *الباقة الاحترافية* *550 ₪/شهر*، ولو عندك 25 طاولة يعني ~*22 ₪* بس للطاولة — أقل من وجبة وحدة أو فنجان قهوة.`);
    if (slots.tables) {
      const p = getPlan(slots.plan ?? 'starter');
      parts.push(`وبدون بطاقة للبدء، وتقدر تلغي أو تغيّر الباقة بأي وقت. مع *${slots.tables} طاولة* على *${p.name}* تطلع ~*${perTableMonthly(p, slots.tables)} ₪* بس للطاولة باليوم فكّة.`);
    } else {
      parts.push('وبدون بطاقة للبدء، وتقدر تلغي أو تغيّر الباقة بأي وقت. كم طاولة عندك؟ أحسب لك الرقم الدقيق.');
    }
  }

  // يقارن بنظامه الحالي — سؤال تشخيصي واحد بدل سرد المزايا
  if (parts.length === 0 && /عندي نظام|نظام ثاني|شغال ورقي|ورق|دفتر|اكسل|excel|ماشي الحال|مستورة/.test(text)) {
    intent = 'مقارنة_وضع_حالي';
    parts.push('ممتاز إن عندك نظام شغال — معناها مطعمك منظم أصلًا 👌 بس سؤال سريع: وش أكثر شيء يزعجك فيه؟ ضياع طلبات، بطء وقت الذروة، ولا الحسابات آخر اليوم؟');
  }

  if (parts.length === 0 && hasMedia) {
    intent = 'وسائط';
    parts.push('وصلتني، وشفت المرفق ✅');
    parts.push('خبّرني: هذي منيو، شاشة مطبخ، ولا شيء ثاني؟ وأنا أربطها لك بالحل المناسب.');
  }

  // ── رسالة ألم صريحة بلا فرع أعلىها: اعتراف + ربط الألم بالحل، بلا إغلاق مبكر ──
  if (parts.length === 0) {
    const painsNow = detectPainPoints(raw);
    if (painsNow.length > 0) {
      intent = 'مقارنة_وضع_حالي';
      const solutionNames: Record<string, string> = {
        slow_waiter: 'زر استدعاء النادل يوصل الطلب للطاولة مباشرة',
        lost_orders: 'الطلب يسير من المنيو للمطبخ لحظة إدخاله وما يضيع ولا ينخلط',
        kitchen_delays: 'شاشة مطبخ حية ترتّب الطلبات بتنبيهات فورية',
        paper_menu: 'منيو رقمي يتعدل بدقائق بلا طباعة',
        manual_accounting: 'تقارير وتسويات تلقائية آخر اليوم',
        order_errors: 'الطلب ينتقل كما هو — بلا إعادة كتابة ولا أخطاء',
      };
      const sol = solutionNames[painsNow[0]!.pain] ?? 'المنيو الرقمي والطلب المباشر من الطاولة';
      parts.push(`واضح، وهذا بالضبط اللي بنحله: ${sol}.`);
      parts.push('وش أكثر شيء ثاني يضايقك اليوميًا — والتوقيت: المشكلة وقت الذروة بس ولا على طول؟');
    }
  }

  if (parts.length === 0) {
    intent = 'عام';
    parts.push(`${vocative}وصلتني 👌 أقدر أشرح الباقات، أحسب لك الأنسب حسب الطاولات، وأجهّز التفعيل، وأتابع أي عطل فني.`);
    parts.push('من وين نبدأ؟');
  }

  const reason =
    intent === 'تأكيد_طلب' && mockOrderRef ? `طلب إطلاق مؤكد ${mockOrderRef} — حُوّل لمدير المنصة` :
    intent === 'دعم_تقني' ? 'مشكلة تقنية لمشترك — تذكرة دعم' :
    intent === 'شكوى' ? 'شكوى/طلب استرداد' :
    intent === 'طلب_تحويل' ? 'طلب العميل محادثة بشرية' : undefined;

  return finishOutput({
    parts,
    handoff,
    reason,
    intent,
    orderRef: mockOrderRef,
    quickReplies: mockButtons,
    sentiment: intent === 'تأكيد_طلب' ? 'positive' : handoff ? 'negative' : /تحية|إيجابي|توصية|تفعيل/.test(intent) ? 'positive' : 'neutral',
    toolsCalled: [],
    sideEffects: mockSideEffects,
    usage: { promptTokens: 0, candidatesTokens: 0 },
    model: 'mock-engine',
    engine: 'mock',
    aiStatus,
    degraded: aiStatus === 'ai_unavailable',
    rawText: JSON.stringify({ reply_parts: parts, handoff, intent }),
  });
}
