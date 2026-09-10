import { config } from '../config.js';
import { log, splitText, sleep } from '../lib/utils.js';

/**
 * إرسال الرسائل عبر WhatsApp Cloud API.
 *
 * في وضع التجربة (DEMO_MODE) لا نتصل بـ Meta إطلاقًا —
 * نطبع الرد في الطرفية فقط، حتى تقدر تجرب المنطق كله بدون أي مفاتيح.
 */

const GRAPH = () => `https://graph.facebook.com/${config.whatsapp.GRAPH_VERSION}`;

async function graph(pathname: string, body: unknown, method = 'POST'): Promise<{ ok: boolean; status: number; json: any }> {
  if (config.env.DEMO_MODE) {
    return { ok: true, status: 200, json: { demo: true } };
  }

  const url = `${GRAPH()}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gemini.TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.whatsapp.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    if (!res.ok) {
      const err = json?.error;
      throw new Error(
        `Meta API ${res.status}${err ? ` — [${err.code ?? '?'}] ${err.message ?? err.title ?? ''}` : ` — ${text.slice(0, 200)}`}`,
      );
    }
    return { ok: true, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function phoneId(override?: string): string {
  return override || config.whatsapp.PHONE_NUMBER_ID;
}

/** تعليم الرسالة كمقروءة + مؤشر "يكتب الآن..." */
export async function markReadAndTyping(messageId: string, phoneNumberId?: string): Promise<void> {
  if (config.env.DEMO_MODE) return;
  if (!messageId) return;

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };
  if (config.whatsapp.TYPING_INDICATOR) {
    body.typing_indicator = { type: 'text' };
  }

  try {
    await graph(`/${phoneId(phoneNumberId)}/messages`, body);
  } catch (err) {
    // ليس خطأً قاتلًا — بعض الحسابات لا تدعم typing_indicator
    log.warn(`تعذّر تعليم الرسالة كمقروءة: ${(err as Error).message}`);
  }
}

/** إيقاف مؤشر الكتابة */
export async function stopTyping(messageId: string, phoneNumberId?: string): Promise<void> {
  if (config.env.DEMO_MODE) return;
  if (!messageId || !config.whatsapp.TYPING_INDICATOR) return;
  try {
    await graph(`/${phoneId(phoneNumberId)}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text', /* إيقاف يتم ضمنيًا عند الإرسال */ },
    });
  } catch { /* نتجاهل */ }
}

/** إرسال نص عادي */
export async function sendText(
  to: string,
  body: string,
  opts: { phoneNumberId?: string; previewUrl?: boolean; contextMessageId?: string } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: opts.previewUrl ?? false, body },
  };
  // الرد داخل نفس المحادثة (reply) — يربط رسالتنا برسالة العميل
  if (opts.contextMessageId) payload.context = { message_id: opts.contextMessageId };

  return sendRaw(`/${phoneId(opts.phoneNumberId)}/messages`, payload, 'نص', to, body);
}

/** إرسال نص طويل مقسّمًا تلقائيًا إلى عدة رسائل */
export async function sendLongText(
  to: string,
  text: string,
  opts: { phoneNumberId?: string; contextMessageId?: string; pauseMs?: number } = {},
): Promise<{ ok: boolean; messageIds: string[]; parts: number }> {
  const parts = splitText(text, config.bot.MAX_SEGMENT_CHARS);
  const ids: string[] = [];
  let ok = true;

  for (let i = 0; i < parts.length; i++) {
    const r = await sendText(to, parts[i], {
      phoneNumberId: opts.phoneNumberId,
      // نربط أول جزء فقط برسالة العميل حتى لا تتكدس الردود
      contextMessageId: i === 0 ? opts.contextMessageId : undefined,
    });
    if (!r.ok) ok = false;
    if (r.messageId) ids.push(r.messageId);
    // فاصل بسيط بين الرسائل يبدو طبيعيًا أكثر ويقلل خطر التصفية
    if (i < parts.length - 1) await sleep(opts.pauseMs ?? 350);
  }

  return { ok, messageIds: ids, parts: parts.length };
}

/** إرسال قائمة أزرار تفاعلية (حتى 3 أزرار) */
export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
  opts: { phoneNumberId?: string; header?: string; footer?: string } = {},
): Promise<{ ok: boolean; messageId?: string }> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual' as const,
    to,
    type: 'interactive' as const,
    interactive: {
      type: 'button' as const,
      ...(opts.header ? { header: { type: 'text' as const, text: opts.header } } : {}),
      body: { text: bodyText },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply' as const,
          reply: { id: b.id, title: b.title.slice(0, 20) }, // حد عنوان الزر 20 حرفًا
        })),
      },
    },
  };
  const r = await sendRaw(`/${phoneId(opts.phoneNumberId)}/messages`, payload, 'أزرار', to, bodyText);
  return { ok: r.ok, messageId: r.messageId };
}

/** إرسال قائمة منسدلة (حتى 10 عناصر) */
export async function sendList(
  to: string,
  bodyText: string,
  sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
  opts: { phoneNumberId?: string; buttonText?: string } = {},
): Promise<{ ok: boolean; messageId?: string }> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual' as const,
    to,
    type: 'interactive' as const,
    interactive: {
      type: 'list' as const,
      body: { text: bodyText },
      action: {
        button: (opts.buttonText ?? 'اختر من القائمة').slice(0, 20),
        sections: sections.slice(0, 10).map((s) => ({
          title: s.title.slice(0, 24),
          rows: s.rows.slice(0, 10).map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  };
  const r = await sendRaw(`/${phoneId(opts.phoneNumberId)}/messages`, payload, 'قائمة', to, bodyText);
  return { ok: r.ok, messageId: r.messageId };
}

/** إضافة تفاعل إيموجي على رسالة العميل */
export async function sendReaction(
  to: string,
  messageId: string,
  emoji: string,
  phoneNumberId?: string,
): Promise<void> {
  if (!emoji || !messageId) return;
  await sendRaw(
    `/${phoneId(phoneNumberId)}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    },
    'تفاعل',
    to,
    emoji,
    { quiet: true },
  );
}

/** إرسال موقع */
export async function sendLocation(
  to: string,
  loc: { latitude: number; longitude: number; name?: string; address?: string },
  phoneNumberId?: string,
): Promise<{ ok: boolean }> {
  const r = await sendRaw(
    `/${phoneId(phoneNumberId)}/messages`,
    { messaging_product: 'whatsapp', to, type: 'location', location: loc },
    'موقع',
    to,
    loc.name ?? '',
  );
  return { ok: r.ok };
}

/** إرسال صورة/ملف من رابط أو من media id سبق رفعه */
export async function sendMedia(
  to: string,
  kind: 'image' | 'document' | 'audio' | 'video',
  ref: { link?: string; id?: string; caption?: string; filename?: string },
  phoneNumberId?: string,
): Promise<{ ok: boolean }> {
  const media: Record<string, unknown> = {};
  if (ref.link) media.link = ref.link;
  else if (ref.id) media.id = ref.id;
  else return { ok: false };
  if (ref.caption) media.caption = ref.caption;
  if (ref.filename) media.filename = ref.filename;

  const r = await sendRaw(
    `/${phoneId(phoneNumberId)}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: media },
    'وسائط',
    to,
    kind,
  );
  return { ok: r.ok };
}

/** إرسال قالب (Template) — الطريقة الوحيدة لبدء محادثة بعد 24 ساعة */
export async function sendTemplate(
  to: string,
  template: { name: string; language: string; components?: unknown[] },
  phoneNumberId?: string,
): Promise<{ ok: boolean }> {
  const r = await sendRaw(
    `/${phoneId(phoneNumberId)}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: template.name, language: { code: template.language }, components: template.components },
    },
    'قالب',
    to,
    template.name,
  );
  return { ok: r.ok };
}

/** إرسال تنبيه للموظف البشري عند التحويل */
export async function notifyHumanAgent(sessionKey: string, customerName: string, lastMessage: string, reason?: string): Promise<void> {
  const agent = config.whatsapp.HUMAN_AGENT_ID;
  if (!agent) return;

  const text =
    `🔔 *تحويل محادثة لموظف بشري*\n` +
    `العميل: ${customerName} (${sessionKey})\n` +
    (reason ? `السبب: ${reason}\n` : '') +
    `آخر رسالة: ${lastMessage.slice(0, 500)}\n\n` +
    `للرد مباشرة أرسل رسالتك من لوحة التحكم، أو اكتب *استلام* لإسناد المحادثة لك.`;

  await sendText(agent, text);
}

// ─────────────────────────── داخلي ───────────────────────────

async function sendRaw(
  pathname: string,
  payload: unknown,
  label: string,
  to: string,
  preview: string,
  opts: { quiet?: boolean } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (config.env.DEMO_MODE) {
    if (!opts.quiet) {
      log.wa(`[تجربة] → ${to} | ${label}: ${String(preview).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return { ok: true, messageId: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` };
  }

  try {
    const res = await graph(pathname, payload);
    const id = res.json?.messages?.[0]?.id;
    if (!opts.quiet) {
      log.wa(`→ ${to} | ${label} ✅ ${id ? `(${id.slice(-10)})` : ''}`);
    }
    return { ok: true, messageId: id };
  } catch (err) {
    const message = (err as Error).message;
    log.error(`فشل إرسال ${label} إلى ${to}: ${message}`);
    return { ok: false, error: message };
  }
}
