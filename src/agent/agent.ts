import fs from 'node:fs';
import { config } from '../config.js';
import { store } from '../lib/store.js';
import { knowledge } from '../lib/knowledge.js';
import { queue, rateLimiter } from '../lib/ratelimit.js';
import { humanMs, log, sleep, truncate, uid } from '../lib/utils.js';
import { buildModelChain, generateReply, summarizeConversation, type Turn } from './llm.js';
import { buildSummaryPrompt, buildSystemPrompt } from './systemPrompt.js';
import {
  fetchChannelMedia,
  markInbound,
  notifyHuman,
  notifyManager,
  reactToInbound,
  sendOutbound,
  sendTyping,
} from '../channels/send.js';
import {
  coherentQuickReplies,
  dayPart,
  firstNameOf,
  pickInboundReaction,
  pickWarmFallbackReply,
  typingDelayMs,
  type QuickReply,
} from './personality.js';
import { bridge } from '../services/conversationBridge.js';
import { handoffService } from '../services/handoffService.js';
import { recordMetric } from '../db/repos/system.js';
import {
  analyzeMessages,
  applyAnalysis,
  stagePolicy,
  objectionPolicy,
  renderStateContext,
  newCustomerState,
  type CustomerState,
  type ObjectionKind,
  type SalesStage,
} from './intelligence/index.js';
import { applyResponsePolicy } from './responsePolicy.js';
import { aiMetrics } from './qualityMetrics.js';
import type {
  AgentResult,
  ConversationState,
  DashboardEvent,
  MediaPart,
  RestaurantProfile,
  Session,
  StoredMessage,
  WaMessageType,
} from '../types.js';
import type { NormalizedInbound } from '../whatsapp/types.js';

/**
 * منسّق البوت — المخ الرئيسي.
 *
 * المسار الكامل لأي رسالة واردة:
 *   1. منع التكرار (wamid)
 *   2. تعليم كمقروءة + مؤشر "يكتب..."
 *   3. أوامر التحكم (/بوت، /بشري، ...)
 *   4. التحقق من حالة المحادثة (بوت / بشري / موقوف)
 *   5. كبح المعدل
 *   6. تجميع الرسائل المتتابعة (debounce) ← يردّ مرة واحدة على كل ما وصل
 *   7. تنزيل الوسائط وتحويلها لما يفهمه النموذج
 *   8. بناء السجل + الـ system prompt
 *   9. توليد الرد (مع تنفيذ الأدوات)
 *  10. الإرسال + التحويل لبشري لو لزم
 */

export class AgentOrchestrator {
  private seen = new Map<string, number>();          // wamid → وقت
  private pending = new Map<string, NormalizedInbound[]>(); // رقم العميل → رسائل بانتظار الرد
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();

  /** بث الأحداث للوحة التحكم */
  onEvent: (e: DashboardEvent) => void = () => {};

  /** ملاحظات على الرسائل المستلمة (للسجلات/التحليل) */
  onInsight?: (i: { sessionKey: string; intent?: string; sentiment?: string; handoff: boolean }) => void;

  constructor() {
    // تنظيف ذاكرة منع التكرار كل ساعة
    const t = setInterval(() => this.sweepSeen(), 3_600_000);
    t.unref?.();
    const t2 = setInterval(() => rateLimiter.sweep(), 120_000);
    t2.unref?.();
  }

  // ─────────────────────────── نقطة الدخول ───────────────────────────

  async handleInbound(msg: NormalizedInbound): Promise<void> {
    // (1) منع التكرار — Meta تعيد إرسال نفس الرسالة عند التأخر في الرد 200
    if (this.seen.has(msg.waId)) {
      log.warn(`تجاهل رسالة مكررة: ${msg.waId.slice(-12)}`);
      return;
    }
    this.seen.set(msg.waId, Date.now());

    const key = msg.from;
    log.wa(`← ${msg.contactName} (${key}): [${msg.type}] ${truncate(msg.body, 70)}`);

    // تحديث اسم العميل من ملفه الشخصي. اسم العرض القادم من القناة ذاكرة مفيدة؛
    // نثبته كاسم أولي حتى لا نسأل «شو اسمك؟» إذا كان معروفًا أصلًا.
    store.setName(key, msg.contactName);
    if (msg.telegramUsername) {
      store.patchProfile(key, { telegram_username: msg.telegramUsername });
    }
    // مزامنة المستخدم/المحادثة/الرسالة مع قاعدة البيانات العلائقية (دفاعية، لا تكسر المسار)
    bridge.inbound(msg);
    const session = store.get(key);
    if (!session.profile?.full_name && usableContactName(msg.contactName, key)) {
      store.patchProfile(key, { full_name: msg.contactName.trim() });
    }

    // (2) تعليم كمقروءة + مؤشر الكتابة (قبل أي معالجة ثقيلة)
    void markInbound(key, msg.waId);
    const auto = (config.whatsapp.AUTO_REACTION || '').trim();
    if (auto.toLowerCase() !== 'off' && auto.toLowerCase() !== 'none') {
      const emoji = auto || pickInboundReaction(msg.body);
      if (emoji) void reactToInbound(key, msg.waId, emoji);
    }

    // (3) أوامر التحكم — تعمل حتى لو المحادثة بيد موظف بشري
    const cmd = this.detectCommand(msg.body);
    if (cmd) {
      await this.runCommand(cmd, key, msg, session.state);
      return;
    }

    // تسجيل الرسالة في السجل دائمًا (حتى في وضع البشري، للمتابعة)
    const stored = await this.persistInbound(key, msg);
    this.emit({ t: 'inbound', sessionKey: key, name: session.name, message: stored, state: session.state });

    // (4) حالة المحادثة
    if (session.state === 'human') {
      log.info(`المحادثة ${key} بيد موظف بشري — البوت صامت (الرسالة سُجّلت في اللوحة).`);
      return;
    }
    if (session.state === 'paused') {
      log.info(`المحادثة ${key} موقوفة مؤقتًا — لا رد.`);
      return;
    }

    // تجاهل الرسائل المحوّلة اختياريًا
    if (msg.forwarded && config.bot.IGNORE_FORWARDED) {
      log.info(`تجاهل رسالة محوّلة من ${key}`);
      return;
    }

    // تفاعل إيموجي لا يحتاج ردًا
    if (msg.type === 'reaction') return;

    // (5) كبح المعدل
    if (!rateLimiter.allow(key)) {
      log.warn(`تجاوز حد الرسائل من ${key} — كبح`);
      await sendOutbound(
        key,
        'وصلتني كلها 😅 أعطني لحظة ألملمها وأرد عليك مرة واحدة مرتبة.',
      );
      return;
    }

    // (6) التجميع: ننتظر قليلًا لعلّ العميل يكمل كلامه
    this.enqueueForReply(key, msg);
  }

  // ─────────────────────────── التجميع (debounce) ───────────────────────────

  private enqueueForReply(key: string, msg: NormalizedInbound): void {
    const list = this.pending.get(key) ?? [];
    list.push(msg);
    this.pending.set(key, list);

    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    // أول رسالة تنتظر أطول قليلًا، وما بعدها فترة أقصر
    const waitMs = list.length === 1 ? 1400 : 900;

    const timer = setTimeout(() => {
      this.timers.delete(key);
      const batch = this.pending.get(key) ?? [];
      this.pending.delete(key);
      if (batch.length === 0) return;
      void this.respondToBatch(key, batch, msg.phoneNumberId);
    }, waitMs);

    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** رد فوري بدون انتظار — يُستخدم في لوحة التحكم وللاختبارات */
  async respondNow(key: string, phoneNumberId?: string): Promise<void> {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    const batch = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (batch.length === 0) return;
    await this.respondToBatch(key, batch, phoneNumberId ?? config.whatsapp.PHONE_NUMBER_ID);
  }

  // ─────────────────────────── توليد الرد ───────────────────────────

  private async respondToBatch(key: string, batch: NormalizedInbound[], phoneNumberId: string): Promise<void> {
    if (this.busy.has(key)) {
      // محادثة أخرى قيد المعالجة → نعيد الجدولة بانتظار أطول بدل الإسقاط ورسائل اللوغ المتكررة
      await sleep(3000);
      for (const m of batch) this.enqueueForReply(key, m);
      return;
    }

    this.busy.add(key);
    this.emit({ t: 'typing', sessionKey: key, on: true });

    try {
      await queue.run(key, async () => {
        const session = store.get(key);

        // إعادة تحقق: قد يكون موظف بشري استلم المحادثة أثناء الانتظار
        if (session.state !== 'bot') {
          log.info(`${key}: تغيّرت الحالة إلى ${session.state} — إلغاء الرد الآلي`);
          return;
        }

        // استخراج فوري وتلقائي لأي بيانات يذكرها العميل وتثبيتها في الذاكرة الدائمة.
        // نمرر آخر سؤال للبوت حتى تُفهم الإجابات القصيرة مثل «25» أو «أحمد» في مكانها.
        const lastAssistantMessage = [...session.messages]
          .reverse()
          .find((m) => m.dir === 'out')?.body ?? '';
        const extracted = autoExtractFacts(batch.map((b) => b.body), session.profile, lastAssistantMessage);
        if (Object.keys(extracted).length > 0) {
          store.patchProfile(key, extracted);
          log.info(`🧠 [${key}] استخراج تلقائي وحفظ في الذاكرة الدائمة: ${JSON.stringify(extracted)}`);
        }

        // جلسة قديمة → لخصّ المحادثة السابقة قبل المتابعة
        if (store.rotateIfStale(session)) {
          log.info(`${key}: انتهت مهلة الجلسة — بدء سياق جديد مع الاحتفاظ بالملخص`);
        }
        await this.maybeSummarize(session.key);

        // ── طبقة التحليل الحتمي (نية/مرحلة/ألم/اعتراض) — قبل بناء السياق ──
        const gapMs = Date.now() - Math.max(session.lastInboundAt, session.updatedAt);
        const customerState = bootstrapCustomerState(session);
        customerState.returningAfterGap =
          Boolean(session.profile?.tables || session.profile?.restaurant_name || session.profile?.preferred_plan) &&
          gapMs >= config.bot.SESSION_TTL_MINUTES * 60_000;
        const hoursSinceLastContact = gapMs / 3_600_000;

        const batchText = batch.map((b) => b.body).join('\n');
        const analysis = analyzeMessages({
          combined: batchText,
          lastBotMessage: lastAssistantMessage,
          hasKnownBusiness: Boolean(session.profile?.restaurant_name || session.profile?.tables || session.profile?.preferred_plan),
        });
        const stateForTurn: CustomerState = { ...customerState, lastIntent: analysis.intent.intent };

        // (7) الوسائط
        const mediaByKey = new Map<string, MediaPart[]>();
        for (const m of batch) {
          if (!m.media) continue;
          const downloaded = await fetchChannelMedia(session.key, m.media);
          if (downloaded) {
            // حفظ المسار في السجل
            if (downloaded.localPath) {
              const rec = session.messages.find((x) => x.waId === m.waId);
              if (rec && rec.media) rec.media.path = downloaded.localPath;
            }
            const arr = mediaByKey.get(m.waId) ?? [];
            arr.push(downloaded);
            mediaByKey.set(m.waId, arr);
          }
        }

        // (8) بناء السجل للنموذج
        const history = store.history(key, config.bot.HISTORY_TURNS);
        const turns: Turn[] = history.map((h) => ({
          role: h.dir === 'out' ? 'model' : 'user',
          text: this.renderTurnText(h),
          media: h.dir === 'in' ? mediaByKey.get(h.waId ?? '') : undefined,
        }));

        if (turns.length === 0) {
          turns.push({ role: 'user', text: batch.map((b) => b.body).join('\n') });
        }

        // ── CURRENT_CONTEXT الحتمي: المرحلة + الألم + الاعتراض + العائد ──
        const profSummary = {
          restaurantName: session.profile?.restaurant_name,
          tables: session.profile?.tables,
          branches: session.profile?.branches,
          preferredPlan: session.profile?.preferred_plan,
        };
        const activeObjectionKinds: ObjectionKind[] = stateForTurn.objections.map((o) => o.kind);
        const knownPain = analysis.pains[0] ?? (stateForTurn.painPoints.length ? { qualificationQuestion: '' } : undefined);
        const intelLines: string[] = [];
        const stateCtx = renderStateContext(stateForTurn, {
          profile: profSummary,
          hoursSinceLastContact,
          painQuestion: knownPain && 'qualificationQuestion' in knownPain ? knownPain.qualificationQuestion : undefined,
          objectionKinds: activeObjectionKinds,
        });
        if (stateCtx) intelLines.push(stateCtx);
        if (analysis.intent.intent !== 'unclear' && analysis.intent.confidence !== 'low') {
          intelLines.push(`- رسالته الحالية مفهومة حتميًا كـ «${analysis.intent.intent}» (ثقة ${analysis.intent.confidence}) — إن خالف فهمك للنص فاعتمد النص.`);
        }
        if (config.bot.MODE !== 'assistant') {
          intelLines.push(`\n[سياسة المرحلة الملزمة]\n${stagePolicy(stateForTurn.stage)}`);
          for (const o of stateForTurn.objections.filter((x) => activeObjectionKinds.includes(x.kind))) {
            const pol = objectionPolicy(o.kind);
            intelLines.push(`\n[سياسة اعتراض ${o.kind}]\n- افعل: ${pol.approach}\n- تجنّب: ${pol.avoid}`);
          }
        }
        const intelligenceBlock = intelLines.join('\n');

        const systemPrompt = buildSystemPrompt({
          mode: config.bot.MODE,
          customerName: session.name,
          customerNumber: key,
          sessionLanguage: session.language,
          summary: session.summary,
          toolsEnabled: config.bot.TOOLS_ENABLED,
          profile: session.profile,
          launch: session.launch,
          lastAssistantMessage,
          intelligenceBlock,
        });

        const extraBits: string[] = [];
        if (lastAssistantMessage) {
          extraBits.push(`[حارس متابعة: آخر رد للبوت محفوظ في السياق. لا تكرر نصه ولا تعيد سؤاله؛ اعتبر رسالة العميل الحالية جوابًا له إن كانت مناسبة، وانتقل للسؤال التالي فقط إذا بقيت معلومة ناقصة.]`);
        }
        if (batch.length > 1) {
          extraBits.push(`[ملاحظة نظام: العميل أرسل ${batch.length} رسائل متتابعة قبل أن ترد. أجب عليها جميعًا في رد واحد متماسك ولا تكرر نفسك.]`);
        }
        const lastIn = batch[batch.length - 1];
        if (lastIn?.reply?.title) {
          extraBits.push(`[ملاحظة نظام: العميل ضغط زرًا تفاعليًا بعنوان «${lastIn.reply.title}» — عامله كجواب واضح ولا تُعِد السؤال.]`);
        }
        const fname = firstNameOf(session.name);
        if (fname) extraBits.push(`[اسم العميل للنداء بلطف: ${fname} — ليس في كل رسالة.]`);
        extraBits.push(`[جزء اليوم: ${dayPart()} — حيِّ به فقط في أول تواصل أو بعد انقطاع.]`);
        // (التلميحات البيعية القديمة أُزيلت: سياسة المرحلة والاعتراض الحتمية أعلاه حلّت مكانها بدون تضارب)
        const hasKnownData = Boolean(
          session.profile?.tables ||
          session.profile?.restaurant_name ||
          session.profile?.preferred_plan ||
          session.summary ||
          session.launch?.orderRef
        );
        const inboundCount = session.messages.filter((m) => m.dir === 'in').length;
        if (hasKnownData || inboundCount > 1) {
          extraBits.push('[تنبيه ذاكرة صارم: العميل معروف ولديه بيانات ومحادثة مسجلة أعلاه — ممنوع نهائيًا إعادة سؤاله عن أي معلومة مسجلة (خاصة: كم طاولة عندك، اسم المطعم، المدينة) وابدأ مباشرة بالإجابة عما طلبه دون إعادة التعريف بنفسك.]');
        } else {
          extraBits.push('[أول تواصل في هذه الجلسة — قدّم نفسك بجملة واحدة حيّة ثم اسأل سؤالًا واحدًا.]');
        }
        const extraContext = extraBits.length ? extraBits.join('\n') : undefined;

        // (9) التوليد
        const started = Date.now();
        let result;
        try {
          result = await generateReply({
            systemPrompt,
            turns,
            toolsEnabled: config.bot.TOOLS_ENABLED,
            toolContext: {
              sessionKey: key,
              customerName: session.name,
              replyTo: batch[batch.length - 1]?.waId,
              channel: batch[batch.length - 1]?.channel ?? (key.startsWith('tg:') ? 'tg' : 'wa'),
              language: session.language as 'ar' | 'en' | 'he',
            },
            extraContext,
          });
        } catch (err) {
          // ملاذ أخير نظريًا — generateReply نفسه لا يرمي خطأ (يردّ احتياطيًا).
          // لو وصلنا هنا فهو خلل برمجي غير متوقع: نسجّله، ونردّ بدفء بشري.
          const message = (err as Error).message;
          log.error(`فشل توليد الرد لـ ${key}: ${message}`);
          store.recordUsage(key, { promptTokens: 0, candidatesTokens: 0, latencyMs: Date.now() - started, error: true });
          this.emit({ t: 'error', sessionKey: key, message: `فشل غير متوقع في توليد الرد: ${message}` });
          const fb = pickWarmFallbackReply();
          const sent = await sendOutbound(key, fb.text, {
            contextMessageId: batch[batch.length - 1]?.waId,
            buttons: fb.buttons,
          });
          if (sent.ok) {
            const rec: StoredMessage = {
              id: uid('out'), waId: sent.messageId, dir: 'out', type: 'text',
              body: fb.text, createdAt: Date.now(), meta: { source: 'warm-fallback' },
            };
            store.addOutbound(key, rec);
            this.emit({ t: 'outbound', sessionKey: key, name: session.name, message: rec, state: session.state });
          } else {
            log.error(`تعذّر إرسال الرد الاحتياطي لـ ${key}: ${sent.error ?? '؟'} — تحقق من توكن القناة`);
            this.emit({ t: 'error', sessionKey: key, message: `فشل إرسال واتساب: ${sent.error ?? '؟'} — تحقق من WHATSAPP_ACCESS_TOKEN` });
          }
          return;
        }

        // ── سياسة الاستجابة (حتمية): أسعار رسمية، لا إلحاح CTA مكرر، بلا تسرب داخلي ──
        const policy = applyResponsePolicy({
          parts: result.parts,
          previousOutboundText: lastAssistantMessage,
          purchaseIntent: stateForTurn.purchaseIntent,
          supportMode: analysis.supportMode,
          intentUnclear: analysis.intent.intent === 'unclear',
          engine: result.engine,
          sessionKey: key,
        });
        if (policy.parts.length > 0) result.parts = policy.parts;
        for (const f of policy.findings) {
          if (f.kind === 'price_violation') aiMetrics.recordPriceViolation(f.repaired);
          else if (f.kind === 'cta_repeat') aiMetrics.recordCtaRepair('cta_repeat');
          else if (f.kind === 'premature_cta') aiMetrics.recordCtaRepair('premature_cta');
        }

        // حارس نهائي مستقل عن النموذج: حتى لو تجاهل التعليمات، لا نرسل سؤالًا
        // سبق أن أجاب عنه العميل وكانت إجابته مثبتة في الذاكرة.
        const guardedParts = removeRepeatedMemoryQuestions(result.parts, session.profile, session.launch);
        result.parts = guardedParts;
        if (result.parts.length === 0 && !result.handoff) {
          result.parts = ['تمام، حفظت التفاصيل عندي ✅ خلّينا نكمل من آخر نقطة وصلنا لها.'];
        }

        // استخراج أزرار الرسالة الصادرة السابقة لمنع تكرار نفس الأزرار مرتين متتاليتين
        const lastOutboundMsg = [...session.messages].reverse().find((m) => m.dir === 'out');
        const lastOutboundButtons = Array.isArray(lastOutboundMsg?.meta?.buttons)
          ? (lastOutboundMsg.meta.buttons as QuickReply[]).map((b) => b.title)
          : undefined;

        // مواءمة وتدقيق الأزرار مع آخر نص وملف العميل ومنع التكرار المتتالي
        const finalLastText = result.parts[result.parts.length - 1] ?? '';
        result.quickReplies = coherentQuickReplies(
          finalLastText,
          result.quickReplies,
          result.intent,
          result.handoff,
          session.profile,
          lastOutboundButtons,
        );

        const latency = Date.now() - started;
        store.recordUsage(key, {
          promptTokens: result.usage.promptTokens,
          candidatesTokens: result.usage.candidatesTokens,
          latencyMs: latency,
          error: result.degraded === true,
        });
        recordMetric('llm_latency_ms', { refKey: key, value: latency });

        // ── تحديث الحالة الدائمة بنتائج الدورة (شاملة أدوات هذه الدورة) ──
        const toolOk = (name: string) => result.toolsCalled.some((t) => t.name === name && (t.result as any)?.ok !== false);
        const toolFacts = {
          launchConfirmed: toolOk('confirm_launch_order') || toolOk('capture_subscription_lead'),
          bookingCreated: toolOk('create_booking'),
          supportTicket: toolOk('create_support_ticket'),
        };
        const newState = applyAnalysis({
          state: stateForTurn,
          analysis,
          profile: profSummary,
          toolFacts,
        });
        // الباقة الأخيرة المعروضة تُثبَّت من أدوات هذه الدورة إن وُجدت
        const recommended = result.toolsCalled.find((t) => t.name === 'recommend_plan' || t.name === 'save_restaurant_profile');
        const recPlan = (recommended?.result as any)?.recommended ?? (recommended?.result as any)?.profile?.preferred_plan;
        if (typeof recPlan === 'string' && ['starter', 'pro', 'enterprise'].includes(recPlan)) {
          newState.lastOffer = recPlan as CustomerState['lastOffer'];
        }
        if (session.launch?.status) newState.onboardingStatus = session.launch.status;
        store.patchCustomerState(key, newState);
        bridge.patchAgentState(key, {
          salesStage: newState.stage,
          leadScore: newState.leadScore,
          lastIntent: newState.lastIntent,
          agentStateJson: JSON.stringify(newState),
        });

        // ── مقاييس جودة الوكيل (قابلة للقياس فقط) ──
        aiMetrics.recordReply({
          engine: result.engine,
          degraded: result.degraded,
          aiStatus: result.aiStatus,
          latencyMs: latency,
          handoff: result.handoff,
          toolsCalled: result.toolsCalled.map((t) => ({ name: t.name, ok: (t.result as any)?.ok !== false })),
          detectedIntent: analysis.intent.intent,
          modelIntent: result.intent,
          intentsAgree: intentsRoughlyAgree(analysis.intent.intent, result.intent),
        });

        // وضع احتياطي؟ العميل حصل على رد مفيد — لكن صاحبه يجب أن يعرف السبب ويصلحه
        if (result.degraded || result.aiStatus === 'ai_unavailable') {
          log.warn(`⚠️ [${key}] رد احتياطي محلي (${result.aiStatus ?? 'ai_unavailable'}) — ${result.degradedReason ?? 'السبب غير معروف'}`);
          this.emit({ t: 'error', sessionKey: key, message: `وضع احتياطي (${result.aiStatus ?? 'ai_unavailable'}): ${result.degradedReason ?? ''}` });
        }

        log.ai(
          `${result.engine === 'mock' && !result.degraded ? '🧪' : result.degraded ? '⚠️' : '✨'} [${key}] ${humanMs(latency)} · ` +
          `${result.usage.promptTokens}↑/${result.usage.candidatesTokens}↓ · ` +
          `نية: ${analysis.intent.intent ?? '؟'}${result.intent && result.intent !== analysis.intent.intent ? ` (نموذج: ${result.intent})` : ''} · ` +
          `مرحلة: ${newState.stage} · نقاط: ${newState.leadScore} (${newState.leadCategory}) · ` +
          `${result.parts.length} جزء` +
          (result.handoff ? ' · 🚨 تحويل بشري' : '') +
          (result.degraded ? ' · ⚠️ احتياطي محلي' : '') +
          (result.aiStatus === 'ai_degraded' ? ' · ↘️ موديل بديل' : ''),
        );

        // بث الأدوات للوحة
        for (const t of result.toolsCalled) {
          this.emit({ t: 'tool', sessionKey: key, name: t.name, args: t.args, result: t.result });
        }

        // (10) الإرسال — إيقاع بشري + أزرار على آخر جزء
        let sendFailedNotified = false;
        for (let i = 0; i < result.parts.length; i++) {
          const part = result.parts[i];
          const last = i === result.parts.length - 1;
          await sendTyping(key);
          await sleep(typingDelayMs(part));
          const sent = await sendOutbound(key, part, {
            contextMessageId: i === 0 ? batch[batch.length - 1]?.waId : undefined,
            buttons: last ? result.quickReplies : undefined,
          });

          // فشل الإرسال (توكن منتهٍ/رقم محظور...) — ننبّه صاحبه في اللوحة بدل الصمت
          if (!sent.ok && !sendFailedNotified) {
            sendFailedNotified = true;
            log.error(`فشل إرسال الرد لـ ${key}: ${sent.error ?? '؟'} — تحقق من توكن القناة ورقم العميل`);
            this.emit({ t: 'error', sessionKey: key, message: `فشل إرسال الرد: ${sent.error ?? '؟'} — تحقق من WHATSAPP_ACCESS_TOKEN` });
          }

          const rec: StoredMessage = {
            id: uid('out'),
            waId: sent.messageId,
            dir: 'out',
            type: 'text',
            body: part,
            createdAt: Date.now(),
            meta: {
              intent: result.intent,
              engine: result.engine,
              latencyMs: latency,
              buttons: last ? result.quickReplies : undefined,
            },
          };
          store.addOutbound(key, rec);
          bridge.outbound(key, part, { externalId: sent.messageId, meta: { intent: result.intent, engine: result.engine } });
          this.emit({ t: 'outbound', sessionKey: key, name: session.name, message: rec, state: session.state });

        }

        // الإجراءات الجانبية
        for (const se of result.sideEffects) {
          if (se.kind === 'handoff') {
            const reason = typeof se.payload?.reason === 'string' ? (se.payload.reason as string) : 'طلب النظام التحويل لبشري';
            store.setState(key, 'human', `🙋 ${reason}`);
            store.recordHandoff(key);
            this.emit({ t: 'status', sessionKey: key, state: 'human', note: reason });
            // التنبيه وضبط حالة قاعدة البيانات نفّذتهما الأداة (handoff_to_human/التذكرة) أصلًا
            log.warn(`🙋 ${key} → تحويل لبشري عبر أداة (${reason})`);
            continue;
          }
          if (se.kind === 'notify_manager') {
            const note = typeof se.payload?.note === 'string' ? (se.payload.note as string) : '';
            const ref = typeof se.payload?.orderRef === 'string' ? (se.payload.orderRef as string) : undefined;
            if (note) {
              const ok = await notifyManager(note, ref);
              if (!ok) {
                this.emit({ t: 'error', sessionKey: key, message: `تعذّر إرسال طلب الإطلاق ${ref ?? ''} لمدير المنصة — راجع WHATSAPP_MANAGER_NUMBER` });
              }
            }
            continue;
          }
          if (se.kind === 'notify_human') {
            const note = typeof se.payload?.note === 'string' ? (se.payload.note as string) : '';
            const lastBody = batch[batch.length - 1]?.body ?? '';
            await notifyHuman(
              key,
              session.name,
              note ? `${note}\nآخر رسالة: ${lastBody.slice(0, 300)}` : lastBody,
              `أداة ${se.tool}`,
            );
          }
        }

        // التحويل لبشري — مع بيانات تسليم كاملة (مرحلة/نقاط/باقة/اعتراض)
        const handoffMeta = {
          stage: newState.stage as string,
          leadScore: newState.leadScore,
          restaurant: session.profile?.restaurant_name,
          tables: session.profile?.tables,
          plan: session.profile?.preferred_plan,
          objection: newState.objections[0]?.kind as string | undefined,
        };
        if (result.handoff) {
          if (result.orderRef) {
            // طلب إطلاق مؤكد — الملف الكامل أُرسل لمدير المنصة عبر الإجراء الجانبي،
            // فلا تنبيه عام إضافي (حتى لا يتشتت المدير برسالتين)
            store.setState(key, 'human', `🚀 طلب إطلاق مؤكد ${result.orderRef} — حُوّل لمدير المنصة`);
            store.recordHandoff(key);
            this.emit({ t: 'status', sessionKey: key, state: 'human', note: result.reason });
            log.ok(`🚀 ${key} → طلب إطلاق مؤكد ${result.orderRef} — المحادثة الآن مع مدير المنصة`);
          } else {
            store.setState(key, 'human', `🚨 تحويل تلقائي لبشري: ${result.reason ?? 'طلب النموذج'}`);
            store.recordHandoff(key);
            handoffService.request({
              contactKey: key,
              name: session.name,
              reason: result.reason ?? 'تحويل تلقائي (النموذج)',
              lastMessage: batch.map((b) => b.body).join('\n'),
              summary: session.summary,
              meta: handoffMeta,
            });
            bridge.setState(key, 'human', result.reason);
            this.emit({ t: 'status', sessionKey: key, state: 'human', note: result.reason });
            await notifyHuman(key, session.name, batch.map((b) => b.body).join('\n'), result.reason);
            log.warn(`🚨 ${key} → تحويل لموظف بشري (${result.reason ?? 'بدون سبب'})`);
          }
        }

        this.onInsight?.({
          sessionKey: key,
          intent: result.intent,
          sentiment: result.sentiment,
          handoff: result.handoff,
        });

        // تحديث اللغة المكتشفة (تقريبًا من نص الرسالة)
        const lang = detectLanguage(batch.map((b) => b.body).join(' '));
        if (lang) {
          store.setLanguage(key, lang);
          bridge.setLanguage(key, lang as 'ar' | 'en' | 'he');
        }
      });
    } finally {
      this.busy.delete(key);
      this.emit({ t: 'typing', sessionKey: key, on: false });
    }
  }

  /** نص الدور الممرّر للنموذج (يشرح الوسائط لو كانت خارج قدرة النموذج) */
  private renderTurnText(m: StoredMessage): string {
    if (m.type === 'text') return m.body;

    const label: Record<string, string> = {
      image: '🖼️ صورة',
      audio: '🎙️ رسالة صوتية',
      video: '🎬 فيديو',
      document: '📄 مستند',
      sticker: '⭐ ملصق',
      location: '📍 موقع',
      contacts: '👤 بطاقة جهة اتصال',
      reaction: '💬 تفاعل',
      unsupported: '❓ رسالة غير مدعومة',
    };

    const head = label[m.type] ?? `❓ ${m.type}`;
    const caption = m.caption ? ` — النص المرفق: "${m.caption}"` : '';
    const extra = m.body && m.body !== head ? '\n' + m.body : '';
    return `${head}${caption}${extra}`.trim();
  }

  // ─────────────────────────── التخزين ───────────────────────────

  private async persistInbound(key: string, msg: NormalizedInbound): Promise<StoredMessage> {
    const rec: StoredMessage = {
      id: uid('in'),
      waId: msg.waId,
      dir: 'in',
      type: (msg.type as WaMessageType) ?? 'unknown',
      body: msg.body,
      caption: msg.caption,
      createdAt: msg.timestamp || Date.now(),
      meta: { forwarded: msg.forwarded, reply: msg.reply, reaction: msg.reaction },
    };

    if (msg.media) {
      rec.media = { kind: msg.media.kind, mimeType: msg.media.mimeType, bytes: 0 };
    }

    store.addInbound(key, rec);
    return rec;
  }

  /** تلخيص تلقائي لو كبر السجل — يحافظ على السياق ويقلل التوكنز */
  private async maybeSummarize(key: string): Promise<void> {
    const session = store.get(key);
    const threshold = Math.max(12, Math.floor(config.bot.HISTORY_TURNS * 0.75));
    if (session.messages.length < threshold) return;

    const older = session.messages.slice(0, Math.floor(session.messages.length / 2));
    if (older.length < 6) return;

    const transcript = older
      .filter((m) => m.dir !== 'system')
      .map((m) => `${m.dir === 'in' ? 'العميل' : m.dir === 'out' ? 'البوت' : 'نظام'}: ${m.body}`)
      .join('\n');

    log.info(`📝 تلخيص ${older.length} رسالة قديمة لـ ${key}`);
    const summary = await summarizeConversation(transcript, session.summary, buildSummaryPrompt);
    if (summary) store.setSummary(key, summary);
  }

  private sweepSeen(): void {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
  }

  // ─────────────────────────── أوامر التحكم ───────────────────────────

  private detectCommand(body: string): CommandName | null {
    const t = (body ?? '').trim().toLowerCase();
    if (!t) return null;

    if (/^(\/?(بوت|bot|آلي|الي))$/.test(t)) return 'bot';
    if (/^(\/?(بشري|انسان|إنسان|موظف|human|agent|stop|ايقاف|إيقاف))$/.test(t)) return 'human';
    if (/^(\/?(استلام|resume|متابعة))$/.test(t)) return 'resume';
    if (/^(\/?(ايقاف مؤقت|pause|توقف))$/.test(t)) return 'pause';
    if (/^(\/?(مسح|تصفير|reset|new|جديد|محادثة جديدة))$/.test(t)) return 'reset';
    if (/^(\/?(مساعدة|help|الأوامر|اوامر))$/.test(t)) return 'help';
    return null;
  }

  /** إرسال نص + تسجيله في سجل المحادثة (حتى يظهر في لوحة التحكم) */
  private async replyAndRecord(
    key: string,
    text: string,
    opts: { phoneNumberId?: string; contextMessageId?: string } = {},
  ): Promise<boolean> {
    const res = await sendOutbound(key, text, opts);
    if (res.ok) {
      const rec: StoredMessage = {
        id: uid('out'),
        waId: res.messageId,
        dir: 'out',
        type: 'text',
        body: text,
        createdAt: Date.now(),
        meta: { source: 'command' },
      };
      store.addOutbound(key, rec);
      bridge.outbound(key, text, { externalId: res.messageId, meta: { source: 'command' } });
      this.emit({ t: 'outbound', sessionKey: key, name: store.get(key).name, message: rec, state: store.get(key).state });
    }
    return res.ok;
  }

  private async runCommand(
    cmd: CommandName,
    key: string,
    msg: NormalizedInbound,
    state: ConversationState,
  ): Promise<void> {
    const session = store.get(key);

    // نسجّل أمر العميل في السجل أولًا حتى تظهر المحادثة كاملة في اللوحة
    await this.persistInbound(key, msg);
    this.emit({ t: 'inbound', sessionKey: key, name: session.name, message: session.messages[session.messages.length - 1], state: session.state });

    switch (cmd) {
      case 'bot': {
        store.setState(key, 'bot', '🤖 تم إرجاع المحادثة للرد الآلي');
        bridge.setState(key, 'bot', 'إرجاع للرد الآلي');
        this.emit({ t: 'status', sessionKey: key, state: 'bot' });
        await this.replyAndRecord(key, `رجعت معك ✅ أنا ${config.bot.BOT_NAME}. تفضل، وش تحتاج الحين؟`, {
          phoneNumberId: msg.phoneNumberId,
          contextMessageId: msg.waId,
        });
        break;
      }

      case 'human': {
        store.setState(key, 'human', '🙋 طلب العميل التحدث مع موظف بشري');
        store.recordHandoff(key);
        handoffService.request({ contactKey: key, name: session.name, reason: 'أمر /بشري من العميل', lastMessage: msg.body });
        bridge.setState(key, 'human', 'أمر /بشري من العميل');
        this.emit({ t: 'status', sessionKey: key, state: 'human' });
        await this.replyAndRecord(
          key,
          'حاضر، بوصلك بأحد الزملاء الحين 🙋 يكملون معك بأقرب وقت.\n(لو تبي ترجع لي اكتب */بوت*)',
          { phoneNumberId: msg.phoneNumberId, contextMessageId: msg.waId },
        );
        await notifyHuman(key, session.name, msg.body, 'أمر /بشري من العميل');
        break;
      }

      case 'pause': {
        store.setState(key, 'paused', '⏸️ إيقاف مؤقت للرد الآلي');
        bridge.setState(key, 'paused', 'إيقاف مؤقت');
        this.emit({ t: 'status', sessionKey: key, state: 'paused' });
        await this.replyAndRecord(key, 'تمام، سكتّ الحين ⏸️ اكتب */بوت* لو تبي أرجع، أو */استلام* لمتابعة بشرية.', {
          phoneNumberId: msg.phoneNumberId,
        });
        break;
      }

      case 'resume': {
        store.setState(key, 'human', '🙋 متابعة بشرية');
        bridge.setState(key, 'human', 'متابعة بشرية');
        this.emit({ t: 'status', sessionKey: key, state: 'human' });
        await this.replyAndRecord(key, 'أنا معك الآن 👋 اكتب */بوت* لو تبي أرجع للرد الآلي.', {
          phoneNumberId: msg.phoneNumberId,
        });
        break;
      }

      case 'reset': {
        store.delete(key);
        bridge.setState(key, 'bot', 'تصفير المحادثة');
        store.addSystem(key, '🔄 تم تصفير المحادثة بطلب العميل');
        this.emit({ t: 'status', sessionKey: key, state: 'bot', note: 'تصفير' });
        await this.replyAndRecord(key, 'صفحة جديدة، خلّينا نبدأ من الصفر ✨ كيف أقدر أساعد مطعمك؟', { phoneNumberId: msg.phoneNumberId });
        break;
      }

      case 'help': {
        const text = [
          'تحت أمرك — هذي الأوامر السريعة:',
          '',
          '• */بوت* — أرجع أرد عليك',
          '• */بشري* — أوصلك بموظف',
          '• */مسح* — نبدأ محادثة جديدة',
          '• */ايقاف مؤقت* — أسكت شوي',
          '• */مساعدة* — هذي القائمة',
        ].join('\n');
        await this.replyAndRecord(key, text, { phoneNumberId: msg.phoneNumberId });
        break;
      }
    }

    // نسجّل الأمر في السجل للتوثيق
    store.addSystem(key, `⌨️ أمر من العميل: ${cmd} (الحالة السابقة: ${state})`);
  }

  // ─────────────────────────── أدوات عامة ───────────────────────────

  private emit(e: DashboardEvent): void {
    try { this.onEvent(e); } catch { /* لا نكسر المسار بسبب اللوحة */ }
  }

  /** إرسال رسالة يدوية من لوحة التحكم (بصيغة الموظف البشري) */
  async sendAsHuman(key: string, text: string, takeOver = true): Promise<boolean> {
    if (!text.trim()) return false;
    const ok = await sendOutbound(key, text);
    if (ok.ok) {
      store.addOutbound(key, {
        id: uid('out'), waId: ok.messageId, dir: 'out', type: 'text',
        body: text, createdAt: Date.now(), meta: { manual: true },
      });
      bridge.outbound(key, text, { externalId: ok.messageId, meta: { source: 'staff_manual' } });
      if (takeOver) {
        store.setState(key, 'human', '🙋 موظف بشري يكتب في المحادثة');
        bridge.setState(key, 'human', 'رد يدوي من الموظف');
        this.emit({ t: 'status', sessionKey: key, state: 'human' });
      }
      this.emit({
        t: 'outbound',
        sessionKey: key,
        name: store.get(key).name,
        message: store.get(key).messages[store.get(key).messages.length - 1],
        state: store.get(key).state,
      });
    }
    return ok.ok;
  }

  /** حالة البوت للنشر في /health — تعرض المزوّد الفعلي وسلسلة الموديلات ومقاييس الجودة */
  status() {
    const hasOpenAi = config.llm.PROVIDER === 'openai' && Boolean(config.openai.API_KEY);
    const hasGemini = config.llm.PROVIDER === 'gemini' && Boolean(config.gemini.API_KEY);
    const provider = config.llm.PROVIDER === 'openai'
      ? (config.openai.API_KEY ? 'openai' : 'mock')
      : (config.gemini.API_KEY ? 'gemini' : 'mock');
    return {
      demoMode: config.env.DEMO_MODE,
      mode: config.bot.MODE,
      provider: config.llm.PROVIDER,
      model: hasOpenAi ? config.openai.MODEL : hasGemini ? config.gemini.MODEL : 'mock-engine',
      engine: provider,
      modelChain: hasGemini && !hasOpenAi ? buildModelChain() : undefined,
      aiQuality: aiMetrics.snapshot(),
      knowledgeFiles: knowledge.files(),
      pendingSessions: this.pending.size,
      busySessions: this.busy.size,
      toolsEnabled: config.bot.TOOLS_ENABLED,
      graphVersion: config.whatsapp.GRAPH_VERSION,
    };
  }
}

type CommandName = 'bot' | 'human' | 'pause' | 'resume' | 'reset' | 'help';

/** أسماء القنوات العامة لا تصلح كاسم عميل في ملف التفعيل. */
function usableContactName(name: string, key: string): boolean {
  const value = (name ?? '').trim();
  if (value.length < 2 || value.length > 80 || value === key) return false;
  return !/^(?:عميل|زبون|مجرّب|مستخدم|user|customer|test|unknown|غير معروف)(?:\s|$)/iu.test(value);
}

/**
 * يمنع آخر طبقة حراسة تكرار الأسئلة المعروفة من التسرب للعميل.
 * النموذج يحصل على تعليمات الذاكرة، لكن هذا الفحص الحتمي يحمي التجربة أيضًا
 * عند تجاهل النموذج للسياق أو بعد استئناف جلسة قديمة.
 */
export function removeRepeatedMemoryQuestions(
  parts: string[],
  profile?: RestaurantProfile,
  launch?: { status?: string },
): string[] {
  const blockedPatterns: RegExp[] = [];

  // إذا تم تأكيد طلب التفعيل، يُمنع طرح أي أسئلة تسجيل أو تفعيل جديدة
  if (launch?.status === 'confirmed') {
    blockedPatterns.push(/(?:تفعيل|تجهيز|اشترك|الاشتراك|باقة|طاولة|طاولات|اسم المطعم|مدينة).*?[؟?]/iu);
  }

  // منع سؤال الطاولات بكافة تصريفاته وصيغه إذا كان عدد الطاولات محفوظًا
  if (profile?.tables && profile.tables > 0) {
    blockedPatterns.push(/(?:كم|ما هو عدد|ما عدد|عدد|قديش|أديش|كام|شو عدد)\s+(?:عدد\s+)?(?:ال)?طاول(?:ة|ات|ه|ا)?/iu);
    blockedPatterns.push(/(?:طاولة|طاولات)\s+(?:عندك|لديك|بالمطعم|تشتغل|شغالة).*?[؟?]/iu);
    blockedPatterns.push(/(?:كم|قديش|أديش)\s+(?:طاولة|طاولات)/iu);
  }

  // منع سؤال اسم المطعم
  if (profile?.restaurant_name) {
    blockedPatterns.push(/(?:شو|ما|ما هو|إيش|ايش|اسمك|واسم)\s+(?:اسم\s+)?(?:ال)?مطعم(?:ك|كم)?/iu);
    blockedPatterns.push(/(?:شو|ما|إيش|ايش)\s+(?:اسم|الاسم)\s+(?:المطعم|الكافيه|المقهى)/iu);
  }

  // منع سؤال المدينة
  if (profile?.city) {
    blockedPatterns.push(/(?:بأي|في أي|ما هي|وين|أين)\s+(?:مدينة|بلد|منطقة)/iu);
    blockedPatterns.push(/مدينة\s+(?:ال)?مطعم(?:ك|كم)?/iu);
  }

  // منع سؤال الباقة إذا كانت محددة
  if (profile?.preferred_plan) {
    blockedPatterns.push(/(?:أي|ما هي|إيش|ايش|شو)\s+(?:ال)?باق(?:ة|ه)\s+(?:تريد|تفضّل|تفضل|تختار|نثبت|حاب)/iu);
  }

  // منع سؤال اسم العميل إذا كان مسجلاً
  if (profile?.full_name) {
    blockedPatterns.push(/(?:شو|ما|ما هو|إيش|ايش)\s+(?:اسمك|الاسم الكري?م)/iu);
  }

  if (blockedPatterns.length === 0) return parts;

  return parts
    .map((part) =>
      part
        .split('\n')
        .filter((line) => {
          const isQuestion = /[؟?]/.test(line) || /(?:كم|شو|ما هو|بأي|أي باقة)/iu.test(line);
          return !(isQuestion && blockedPatterns.some((pattern) => pattern.test(line)));
        })
        .join('\n')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * استخراج ذكي وتلقائي لبيانات المطعم من رسائل العميل وحفظها في الذاكرة الدائمة.
 *
 * مهم: لا نعتمد على النموذج وحده في الذاكرة. كثير من العملاء يجيبون عن سؤال
 * البوت برسالة قصيرة جدًا مثل «أحمد» أو «25»، لذلك نقرأ آخر سؤال أيضًا ونربط
 * الجواب بمكانه الصحيح قبل إرسال السياق للنموذج.
 */
export function autoExtractFacts(
  texts: string[],
  existingProfile?: RestaurantProfile,
  lastAssistantMessage = '',
): Partial<RestaurantProfile> {
  const combined = texts.join('\n').trim();
  const last = lastAssistantMessage.toLowerCase();
  const patch: Partial<RestaurantProfile> = {};
  const isShortAnswer = combined.length > 0 && combined.length <= 80 && !/[،,؛;\n]/.test(combined);

  const numberAfter = (pattern: RegExp): number | undefined => {
    const match = combined.match(pattern);
    const value = match?.[1] ? Number(match[1]) : NaN;
    return Number.isInteger(value) && value > 0 && value <= 2000 ? value : undefined;
  };

  // 1. عدد الطاولات — يشمل الإجابة القصيرة «25» إذا كان آخر سؤال عن الطاولات.
  const tableCount =
    numberAfter(/(?:^|\s|[^\d])(\d{1,3})\s*(?:طاولة|طاولات|طاوله|طاو|table|tables)(?![\p{L}])/iu) ??
    (/(?:كم|عدد|how many).*?(?:طاول|table)|(?:طاول|table).*?[؟?]/iu.test(last)
      ? numberAfter(/^(?:\s*)(\d{1,3})(?:\s*)$/)
      : undefined);
  if (tableCount) patch.tables = tableCount;

  // 2. اسم المطعم — أوقف الالتقاط عند الفاصلة أو السؤال حتى لا نأخذ بقية الجملة.
  const restaurantMatch = combined.match(
    /(?:اسم المطعم|المطعم اسمه|مطعمي اسمه|مطعمنا اسمه|اسم الكافيه|الكافيه اسمه)\s*[:=]?\s*([^،,\n.!؟?]+?)(?=\s+(?:في|بمدينة|عندي|وعندي)(?:\s|$)|[،,\n.!؟?]|$)/iu,
  );
  if (restaurantMatch) {
    const value = restaurantMatch[1].trim();
    if (value && !/^(ايش|إيش|شو|كم|بكم|في|على|هو|جديد|صغير|كبير)\b/i.test(value)) {
      patch.restaurant_name = value;
    }
  } else if (isShortAnswer && /اسم المطعم|اسم الكافيه|واسم المطعم/.test(last)) {
    patch.restaurant_name = combined.replace(/[.!؟?]+$/, '').trim();
  }

  // 3. المدينة — نقرأ صيغة صريحة أو جوابًا قصيرًا بعد سؤال المدينة.
  const cityMatch = combined.match(/(?:بمدينة|في مدينة|مدينة|في|بـ)\s+([^،,\n.!؟?]{2,40})/iu);
  if (cityMatch) {
    const value = cityMatch[1].trim();
    if (!/^(مطعم|المطعم|كافيه|مقهى|عندي)\b/i.test(value)) patch.city = value;
  } else if (isShortAnswer && /بأي مدينة|أي مدينة|مدينة المطعم/.test(last)) {
    patch.city = combined.replace(/[.!؟?]+$/, '').trim();
  }

  // 4. عدد الفروع — حفظه يمنع العودة للسؤال نفسه عند الحديث عن المؤسسات.
  const branches = numberAfter(/(?:عندي|لدينا|عندنا)?\s*(\d{1,3})\s*(?:فرع|فروع|branch|branches)(?![\p{L}])/iu);
  if (branches) patch.branches = branches;

  // 5. الباقة المختارة. لا نبدّل اختيارًا محفوظًا لمجرد ذكر باقة أثناء المقارنة،
  // إلا إذا كان العميل يجيب عن سؤال التثبيت أو اختارها بصيغة واضحة.
  const explicitPlan = /(?:أختار|اختار|نثبت|ثبت|باقة|على)\s*(?:الـ)?(أساسية|اساسية|starter|احترافية|احتراف|pro|مؤسسات|سلاسل|enterprise)/iu.exec(combined)?.[1]?.toLowerCase();
  const askedForPlan = /نثبت|أي باقة|الباقة|الاحترافية|الأساسية|المؤسسات/.test(last);
  const planText = explicitPlan || (askedForPlan ? combined : '');
  if (!existingProfile?.preferred_plan || explicitPlan || askedForPlan) {
    if (/أساسية|اساسية|starter/i.test(planText)) patch.preferred_plan = 'starter';
    else if (/احترافية|احتراف|pro\b/i.test(planText)) patch.preferred_plan = 'pro';
    else if (/مؤسسات|سلاسل|enterprise/i.test(planText)) patch.preferred_plan = 'enterprise';
  }

  // 6. اسم العميل — لا نلتقط «أنا عندي...» كاسم بالخطأ.
  const nameMatch = combined.match(/(?:اسمي|أنا اسمي|انا اسمي|معك)\s+([^،,\n.!؟?]{2,40})/iu);
  if (nameMatch) {
    const value = nameMatch[1].trim();
    if (!/^(عندي|لدينا|أريد|ابغى|بدي|من|في)\b/i.test(value)) patch.full_name = value;
  } else if (isShortAnswer && /شو اسمك|ما اسمك|اسمك|الاسم/.test(last)) {
    patch.full_name = combined.replace(/[.!؟?]+$/, '').trim();
  }

  return patch;
}

/** كشف لغة مبسّط (يُستخدم فقط لضبط لغة الجلسة) */
export function detectLanguage(text: string): string | null {
  if (!text) return null;
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const hebrew = (text.match(/[\u0590-\u05FF]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = arabic + hebrew + latin;
  if (total < 2) return null;

  if (arabic / total > 0.4) return 'ar';
  if (hebrew / total > 0.4) return 'he';
  if (latin / total > 0.6) return 'en';
  return null;
}

/**
 * تهيئة الحالة الدائمة من جلسة قائمة (أو جلسة قديمة سبقت طبقة الحالة).
 * نستنتج المرحلة من الأدلة المحفوظة فقط — لا نعطي العميل مرحلة أعمق مما يثبته ملفه.
 */
export function bootstrapCustomerState(session: Session): CustomerState {
  const base = session.customer ?? newCustomerState();
  // جلسة قديمة بلا حالة: استنتاج أولي محافظ من الملف والإطلاق
  if (!session.customer) {
    const p = session.profile ?? {};
    if (session.launch?.status === 'confirmed') base.stage = 'ONBOARDING';
    else if (session.launch?.status === 'awaiting_confirmation') base.stage = 'PURCHASE_INTENT';
    else if (p.preferred_plan) base.stage = 'RECOMMENDATION';
    else if (p.tables || p.restaurant_name) base.stage = 'QUALIFICATION';
    if (p.preferred_plan) base.lastOffer = p.preferred_plan;
    if (session.launch?.orderRef) {
      base.purchaseIntent = true;
      base.onboardingStatus = 'confirmed';
      base.leadScore = Math.max(base.leadScore, 90);
    }
    base.leadCategory = base.leadScore >= 81 ? 'hot' : base.leadScore >= 61 ? 'qualified' : base.leadScore >= 31 ? 'warm' : 'cold';
  }
  return base;
}

/**
 * مقارنة تقريبية بين النية الحتمية ونية النموذج — لمقياس الاتساق فقط
 * (ليست حكمًا صحيح/خطأ). نية نموذج غير معروفة → false بلا عقاب إضافي.
 */
export function intentsRoughlyAgree(detected: string | undefined, modelIntent: string | undefined): boolean {
  if (!detected || !modelIntent) return false;
  const MODEL_TO_CANONICAL: Record<string, string[]> = {
    'تحية': ['greeting'],
    'عام': ['unclear', 'product_information', 'greeting', 'unrelated'],
    'استفسار_أسعار': ['pricing', 'plan_comparison'],
    'استفسار_باقات': ['pricing', 'product_information', 'plan_comparison', 'service_information'],
    'توصية_باقة': ['recommendation', 'pricing'],
    'اعتراض_سعري': ['objection_price'],
    'مقارنة_وضع_حالي': ['competitor_comparison', 'objection_value'],
    'طلب_تفعيل': ['purchase_intent', 'onboarding'],
    'بيانات_تفعيل': ['onboarding', 'restaurant_qualification', 'purchase_intent'],
    'تجهيز_إطلاق': ['onboarding', 'purchase_intent', 'restaurant_qualification'],
    'تأكيد_طلب': ['purchase_intent', 'onboarding'],
    'طلب_تحويل': ['human_request'],
    'شكوى': ['complaint'],
    'دعم_تقني': ['support', 'complaint', 'technical_question'],
    'حجز': ['booking', 'booking_modification', 'booking_cancellation', 'onboarding'],
    'إيجابي': ['greeting', 'unclear', 'purchase_intent'],
  };
  const allowed = MODEL_TO_CANONICAL[modelIntent];
  return allowed ? allowed.includes(detected) : false;
}

/** إنشاء ملف سجلات الأحداث (اختياري) */
export function writeInsightLog(entry: Record<string, unknown>): void {
  try {
    const file = `${config.paths.DATA_DIR}/insights.jsonl`;
    fs.mkdirSync(config.paths.DATA_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch { /* غير حرج */ }
}

export const orchestrator = new AgentOrchestrator();
