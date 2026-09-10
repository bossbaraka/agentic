import fs from 'node:fs';
import { config } from '../config.js';
import { store } from '../lib/store.js';
import { knowledge } from '../lib/knowledge.js';
import { queue, rateLimiter } from '../lib/ratelimit.js';
import { humanMs, log, sleep, truncate, uid } from '../lib/utils.js';
import { generateReply, summarizeConversation, type Turn } from './llm.js';
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
  dayPart,
  firstNameOf,
  pickInboundReaction,
  pickWarmFallbackReply,
  typingDelayMs,
} from './personality.js';
import type {
  AgentResult,
  ConversationState,
  DashboardEvent,
  MediaPart,
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

    // تحديث اسم العميل من ملفه الشخصي
    store.setName(key, msg.contactName);
    const session = store.get(key);

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

        // جلسة قديمة → لخصّ المحادثة السابقة قبل المتابعة
        if (store.rotateIfStale(session)) {
          log.info(`${key}: انتهت مهلة الجلسة — بدء سياق جديد مع الاحتفاظ بالملخص`);
        }
        await this.maybeSummarize(session.key);

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

        const systemPrompt = buildSystemPrompt({
          mode: config.bot.MODE,
          customerName: session.name,
          customerNumber: key,
          sessionLanguage: session.language,
          summary: session.summary,
          toolsEnabled: config.bot.TOOLS_ENABLED,
        });

        const extraBits: string[] = [];
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
        const sales = salesHint(batch.map((b) => b.body).join('\n'), session.summary);
        if (sales) extraBits.push(sales);
        const inboundCount = session.messages.filter((m) => m.dir === 'in').length;
        if (inboundCount <= batch.length) {
          extraBits.push('[أول تواصل في هذه الجلسة — قدّم نفسك بجملة واحدة حيّة ثم اسأل سؤالًا واحدًا.]');
        } else if (inboundCount > 1) {
          extraBits.push('[عميل عائد في نفس الجلسة — لا تُعِد التعريف الكامل ولا التحية الرسمية.]');
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

        const latency = Date.now() - started;
        store.recordUsage(key, {
          promptTokens: result.usage.promptTokens,
          candidatesTokens: result.usage.candidatesTokens,
          latencyMs: latency,
          error: result.degraded === true,
        });

        // وضع احتياطي؟ العميل حصل على رد مفيد — لكن صاحبه يجب أن يعرف السبب ويصلحه
        if (result.degraded) {
          log.warn(`⚠️ [${key}] رد احتياطي محلي — ${result.degradedReason ?? 'السبب غير معروف'}`);
          this.emit({ t: 'error', sessionKey: key, message: `وضع احتياطي: ${result.degradedReason ?? ''}` });
        }

        log.ai(
          `${result.engine === 'mock' && !result.degraded ? '🧪' : result.degraded ? '⚠️' : '✨'} [${key}] ${humanMs(latency)} · ` +
          `${result.usage.promptTokens}↑/${result.usage.candidatesTokens}↓ · ` +
          `نية: ${result.intent ?? '؟'} · ${result.parts.length} جزء` +
          (result.handoff ? ' · 🚨 تحويل بشري' : '') +
          (result.degraded ? ' · ⚠️ احتياطي محلي' : ''),
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
            meta: { intent: result.intent, engine: result.engine, latencyMs: latency },
          };
          store.addOutbound(key, rec);
          this.emit({ t: 'outbound', sessionKey: key, name: session.name, message: rec, state: session.state });

        }

        // الإجراءات الجانبية
        for (const se of result.sideEffects) {
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

        // التحويل لبشري
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
        if (lang) store.setLanguage(key, lang);
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
        this.emit({ t: 'status', sessionKey: key, state: 'paused' });
        await this.replyAndRecord(key, 'تمام، سكتّ الحين ⏸️ اكتب */بوت* لو تبي أرجع، أو */استلام* لمتابعة بشرية.', {
          phoneNumberId: msg.phoneNumberId,
        });
        break;
      }

      case 'resume': {
        store.setState(key, 'human', '🙋 متابعة بشرية');
        this.emit({ t: 'status', sessionKey: key, state: 'human' });
        await this.replyAndRecord(key, 'أنا معك الآن 👋 اكتب */بوت* لو تبي أرجع للرد الآلي.', {
          phoneNumberId: msg.phoneNumberId,
        });
        break;
      }

      case 'reset': {
        store.delete(key);
        store.addSystem(key, '🔄 تم تصفير المحادثة بطلب العميل');
        this.emit({ t: 'status', sessionKey: key, state: 'bot', note: 'تصفير' });
        await this.replyAndRecord(key, 'صفحة جديدة، خلّينا نبدأ من الصفر ✨ كم طاولة تشتغل عندك؟', { phoneNumberId: msg.phoneNumberId });
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
      if (takeOver) {
        store.setState(key, 'human', '🙋 موظف بشري يكتب في المحادثة');
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

  /** حالة البوت للنشر في /health */
  status() {
    return {
      demoMode: config.env.DEMO_MODE,
      mode: config.bot.MODE,
      model: config.gemini.API_KEY ? config.gemini.MODEL : 'mock-engine',
      engine: config.gemini.API_KEY ? 'gemini' : 'mock',
      knowledgeFiles: knowledge.files(),
      pendingSessions: this.pending.size,
      busySessions: this.busy.size,
      toolsEnabled: config.bot.TOOLS_ENABLED,
      graphVersion: config.whatsapp.GRAPH_VERSION,
    };
  }
}

type CommandName = 'bot' | 'human' | 'pause' | 'resume' | 'reset' | 'help';

/**
 * تلميح بيعي ذكي يُحقن في سياق النموذج حسب كلام العميل.
 * يوجّه «الخبير البشري» لمعالجة الاعتراض الصحيح بدل الرد العام —
 * سطر واحد خفيف، لا يُذكر اسمه للعميل أبدًا.
 */
function salesHint(userText: string, summary: string): string | null {
  const t = `${userText}\n${summary}`.toLowerCase();

  if (/غالي|غالية|سعر مرتفع|ميزانية|بفكر|افكر|أفكر|بعدين|مش متأكد|متردد|شور|استشير|فكر فيها/.test(t)) {
    return '[دليل بيعي: العميل متردد/يعترض على السعر — عالج بجملة قيمة واحدة: قسّط السعر على الطاولة/اليوم، اذكر التوفير السنوي، وذكّر (بدون بطاقة للبدء + إلغاء/ترقية مرنة). ثم سؤال واحد صغير يقود للتفعيل. ممنوع الخصم أو الوعد به.]';
  }
  if (/عندي نظام|نظام ثاني|شغال ورقي|ورق|دفتر|اكسل|excel|ماشي الحال/.test(t)) {
    return '[دليل بيعي: يقارن بوضعه الحالي — لا تسرد المزايا. اسأل عن أكبر ألم فيه (ضياع طلبات؟ بطء الذروة؟ حسابات آخر اليوم؟) ثم اربطه بميزة واحدة تحلّه بالضبط.]';
  }
  if (/معقد|صعب|كبير علي|ما افهم تقنية|موظفين كبار|خايف|صعب علينا/.test(t)) {
    return '[دليل بيعي: خوف من التعقيد — طمئنه: يعمل على أجهزته الحالية بدون معدات، التفعيل خلال دقائق، والفريق يجهّز كل شيء معه خطوة بخطوة. ثم سؤال واحد.]';
  }
  if (/مطعم صغير|كشك|فود ترك|كافيه صغير|طاولات قليلة|عدد قليل|\b([1-9]|1[0-4])\s*(طاولة|طاولات|طاو)\b/.test(t)) {
    return '[دليل بيعي: يظن النظام أكبر منه — وضّح أن الأساسية تبدأ من 149₪ وتعمل من أول طاولة، والترقية لاحقًا بضغطة من اللوحة. ثم سؤال واحد.]';
  }
  if (/فروع|سلسلة|سلاسل|فرع ثاني|فرع جديد/.test(t)) {
    return '[دليل بيعي: عميل سلاسل/فروع (قيمة عالية) — ركّز على باقة المؤسسات: إدارة الفروع، السعة المفتوحة، النطاق الخاص، ومدير الحساب. اسأل عن عدد الفروع الحالي.]';
  }
  return null;
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

/** إنشاء ملف سجلات الأحداث (اختياري) */
export function writeInsightLog(entry: Record<string, unknown>): void {
  try {
    const file = `${config.paths.DATA_DIR}/insights.jsonl`;
    fs.mkdirSync(config.paths.DATA_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch { /* غير حرج */ }
}

export const orchestrator = new AgentOrchestrator();
