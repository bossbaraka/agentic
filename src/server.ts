import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { config, validateConfig } from './config.js';
import { store } from './lib/store.js';
import { knowledge } from './lib/knowledge.js';
import { log, truncate } from './lib/utils.js';
import { orchestrator, writeInsightLog } from './agent/agent.js';
import { parseStatuses, parseWebhookPayload } from './whatsapp/incoming.js';
import type { WebhookPayload } from './whatsapp/types.js';
import {
  deleteTelegramWebhook,
  setTelegramWebhook,
  startTelegramPolling,
  stopTelegramPolling,
  telegramEnabled,
  tgSetMyCommands,
  verifyTelegramSecret,
} from './telegram/client.js';
import { dispatchTelegramUpdate } from './telegram/dispatcher.js';
import { openDb, closeDb, dbHealth } from './db/client.js';
import { seedAll } from './db/seed.js';
import { importLegacyState } from './db/legacyImport.js';
import { notifications } from './services/notificationService.js';
import { countUsers } from './db/repos/users.js';
import { bookingCounts } from './db/repos/bookings.js';
import { listOrdersAdmin, listTicketsAdmin } from './db/repos/commerce.js';
import { get as dbGet } from './db/client.js';
import { getDashboardHtml } from './dashboard/index.js';
import { startKeepAlive, stopKeepAlive } from './lib/keepalive.js';

/**
 * الخادم: يستقبل webhook من Meta، يمرره للمنسّق، ويقدّم لوحة تحكم حية.
 *
 * مبادئ مهمة مطبّقة هنا:
 *  • الرد 200 فورًا والمعالجة في الخلفية — Meta تعيد الإرسال لو تأخرت.
 *  • التحقق من X-Hub-Signature-256 على الجسم الخام (raw bytes) وليس JSON المحلّل.
 *  • GET /webhook لإتمام تحقّق Meta (hub.challenge).
 */

const app = Fastify({
  logger: false, // نستخدم مسجّلنا الخاص
  bodyLimit: 8 * 1024 * 1024,
  trustProxy: true,
  keepAliveTimeout: 65000,
});

// ─────────────────── الحفاظ على الجسم الخام للتحقق من التوقيع ───────────────────

app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (_req, body, done) => {
    try {
      const json = JSON.parse((body as Buffer).toString('utf8'));
      // نربط الجسم الخام بالطلب لاستخدامه في التحقق
      (_req as any).rawBody = body;
      done(null, json);
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  },
);

/** التحقق من توقيع Meta (HMAC SHA-256) */
function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!config.whatsapp.APP_SECRET) {
    // لا يوجد سر مضبوط → نتجاوز التحقق (مع تحذير مسبق عند الإقلاع)
    return true;
  }
  if (!rawBody || !header) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.APP_SECRET).update(rawBody).digest('hex');

  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─────────────────── WebSocket للوحة التحكم ───────────────────

const sockets = new Set<WebSocket>();

function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch { /* نتجاهل */ }
    }
  }
}

orchestrator.onEvent = (e) => {
  broadcast(e);
  if (e.t === 'inbound' || e.t === 'outbound') {
    writeInsightLog({ type: e.t, key: e.sessionKey, body: truncate(e.message.body, 300) });
  }
};

orchestrator.onInsight = (i) => writeInsightLog(i);

// ─────────────────── المسارات ───────────────────

/** الصفحة الرئيسية — توجيه تلقائي للوحة التحكم */
app.get('/', async (_req, reply) => {
  return reply.redirect(config.server.DASHBOARD_PATH);
});

/** الصحّة */
app.get('/health', async () => ({
  ok: true,
  uptime: Math.round(process.uptime()),
  channels: {
    whatsapp: config.whatsapp.ENABLED,
    telegram: config.telegram.TOKEN ? (config.telegram.WEBHOOK_URL ? 'webhook' : 'polling') : 'off',
  },
  database: dbHealth(),
  notifications: { enabled: config.notifications.ENABLED, queueDepth: notifications.pending() },
  ...orchestrator.status(),
  stats: store.snapshot(),
}));

/** فحص خفيف لـ Keep-Alive ومنع خمول Render */
app.get('/ping', async () => ({
  ok: true,
  pong: Date.now(),
  uptime: Math.round(process.uptime()),
}));

/**
 * تحقّق Meta من رابط الويب هوك.
 * Meta ترسل: hub.mode=subscribe & hub.verify_token=... & hub.challenge=...
 * ويجب أن نعيد نص hub.challenge كما هو مع 200.
 */
if (!config.whatsapp.ENABLED) {
  log.warn('⏸ واتساب موقوف (WHATSAPP_ENABLED=false) — مسارات Meta لن تُسجّل. البوت يخدم عبر تيليجرام.');
} else {
app.get(config.server.WEBHOOK_PATH, async (req, reply) => {
  const q = req.query as Record<string, string>;
  log.http(`GET ${config.server.WEBHOOK_PATH} (تحقق) من ${req.ip}`);

  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsapp.VERIFY_TOKEN) {
    log.ok('✅ تم التحقق من الويب هوك بنجاح');
    return reply.type('text/plain').send(q['hub.challenge'] ?? '');
  }

  log.warn('❌ فشل التحقق من الويب هوك (token غير مطابق)');
  return reply.code(403).send('forbidden');
});

/** استقبال الأحداث */
app.post(config.server.WEBHOOK_PATH, async (req, reply) => {
  // نتحقق من التوقيع قبل أي شيء
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  if (!verifyMetaSignature((req as any).rawBody, sig)) {
    log.error('⛔ توقيع Meta غير صالح — رفض الطلب');
    return reply.code(401).send({ error: 'invalid signature' });
  }

  // الرد فورًا — المعالجة في الخلفية
  reply.code(200).send({ ok: true });

  const payload = req.body as WebhookPayload;

  try {
    // حالات التسليم (للمراقبة)
    for (const s of parseStatuses(payload)) {
      if (s.status === 'failed' || s.status === 'error') {
        log.error(`فشل تسليم رسالة إلى ${s.to}: ${s.error ?? s.status}`);
        broadcast({ t: 'error', message: `فشل تسليم إلى ${s.to}: ${s.error ?? ''}` });
      }
    }

    // الرسائل الواردة
    const messages = parseWebhookPayload(payload);
    if (messages.length === 0) return;

    log.info(`📥 ${messages.length} رسالة واردة في هذا الحدث`);

    // نعالجها بالتوازي — المنسّق يرتّبها لكل عميل على حدة
    await Promise.allSettled(messages.map((m) => orchestrator.handleInbound(m)));
  } catch (err) {
    log.error(`خطأ في معالجة الويب هوك: ${(err as Error).stack ?? err}`);
  }
});
} // end if whatsapp.ENABLED

// ─────────────────── تيليجرام ───────────────────

/** webhook تيليجرام (يستخدم فقط مع TELEGRAM_WEBHOOK_URL) */
if (telegramEnabled()) {
  app.post('/telegram/webhook', async (req, reply) => {
    // تيليجرام يضع secret_token في ترويسة مخصصة (ندعم query أيضًا للتوافق مع الاختبار)
    const secret =
      (req.headers['x-telegram-bot-api-secret-token'] as string | undefined) ??
      (req.query as Record<string, string>)?.secret_token;
    if (!verifyTelegramSecret(secret)) {
      log.error('⛔ توقيع تيليجرام غير صالح — رفض الطلب');
      return reply.code(401).send({ error: 'invalid secret' });
    }
    // الرد فورًا — المعالجة في الخلفية (Telegram يعيد الإرسال عند 30+ ثانية)
    reply.code(200).send({ ok: true });
    setImmediate(async () => {
      try {
        await dispatchTelegramUpdate(req.body as any);
      } catch (err) {
        log.error(`خطأ في معالجة webhook تيليجرام: ${(err as Error).stack ?? err}`);
      }
    });
  });
}

/**
 * نقطة اختبار داخلية: أرسل أي JSON وسيُعامل كـ webhook من Meta.
 * مفيدة جدًا مع ngrok/cloudflared أو للاختبار المحلي.
 * ⚠️ معطّلة تلقائيًا في الإنتاج إلا إذا ضبطت INTERNAL_TEST_HOOK=true
 */
app.post('/internal/simulate', async (req, reply) => {
  const enabled = config.env.DEMO_MODE || process.env.INTERNAL_TEST_HOOK === 'true';
  if (!enabled) return reply.code(403).send({ error: 'disabled' });

  const body = req.body as any;

  // محاكاة تيليجرام: { channel: 'tg', update: {...} }
  if (body?.channel === 'tg' || body?.channel === 'telegram') {
    await dispatchTelegramUpdate(body.update ?? body);
    return { ok: true, channel: 'tg', received: 1 };
  }

  const payload = body as WebhookPayload;
  const messages = parseWebhookPayload(payload);
  await Promise.allSettled(messages.map((m) => orchestrator.handleInbound(m)));
  return { ok: true, channel: 'wa', received: messages.length };
});

// ─────────────────── لوحة التحكم ───────────────────

/** تحقق بسيط بكلمة مرور عبر استعلام أو كوكي */
function dashboardAuthed(req: { headers: Record<string, any>; url: string }): boolean {
  const pw = config.server.DASHBOARD_PASSWORD;
  if (!pw) return true;
  const url = new URL(req.url, 'http://local');
  const q = url.searchParams.get('pw');
  const cookie = String(req.headers.cookie ?? '');
  const fromCookie = cookie.match(/dashpw=([^;]+)/)?.[1];
  return q === pw || fromCookie === pw;
}

app.get(config.server.DASHBOARD_PATH, async (req, reply) => {
  if (!dashboardAuthed(req as any)) {
    return reply.type('text/html; charset=utf-8').send(loginPage());
  }
  const pw = config.server.DASHBOARD_PASSWORD;
  if (pw) reply.header('set-cookie', `dashpw=${encodeURIComponent(pw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return reply.type('text/html; charset=utf-8').send(getDashboardHtml());
});

/** مؤشرات قاعدة البيانات العلائقية للوحة التحكم (دفاعي — لا يكشف بيانات عملاء) */
function dbOverview() {
  try {
    const ticketsOpen = Number(
      dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('OPEN','IN_PROGRESS')")?.n ?? 0,
    );
    return {
      users: countUsers(),
      bookings: bookingCounts(),
      orders: listOrdersAdmin({ limit: 1 }).total,
      ticketsOpen,
      notificationsPending: notifications.pending(),
      notificationsFailed: notifications.failed(100).length,
    };
  } catch {
    return null;
  }
}

/** API للوحة التحكم */
app.get('/api/sessions', async (req, reply) => {
  if (!dashboardAuthed(req as any)) return reply.code(401).send({ error: 'unauthorized' });
  return {
    stats: store.snapshot(),
    db: dbOverview(),
    sessions: store.all().slice(0, 100).map((s) => ({
      key: s.key,
      name: s.name,
      state: s.state,
      language: s.language,
      updatedAt: s.updatedAt,
      lastInboundAt: s.lastInboundAt,
      messageCount: s.messages.length,
      summary: s.summary,
      stats: s.stats,
    })),
  };
});

app.get<{ Params: { key: string } }>('/api/sessions/:key', async (req, reply) => {
  if (!dashboardAuthed(req as any)) return reply.code(401).send({ error: 'unauthorized' });
  const s = store.get(req.params.key);
  return { session: s };
});

app.post<{ Body: { key: string; text?: string; state?: string; takeOver?: boolean } }>('/api/sessions/action', async (req, reply) => {
  if (!dashboardAuthed(req as any)) return reply.code(401).send({ error: 'unauthorized' });
  const { key, text, state, takeOver } = req.body ?? {};
  if (!key) return reply.code(400).send({ error: 'key مطلوب' });

  if (state === 'bot' || state === 'human' || state === 'paused') {
    store.setState(key, state, `🖥️ تغيير من لوحة التحكم إلى: ${state}`);
    broadcast({ t: 'status', sessionKey: key, state });
    return { ok: true, state };
  }

  if (typeof text === 'string' && text.trim()) {
    const ok = await orchestrator.sendAsHuman(key, text, takeOver !== false);
    return { ok };
  }

  return reply.code(400).send({ error: 'لا يوجد إجراء' });
});

app.post<{ Body: { key: string } }>('/api/sessions/delete', async (req, reply) => {
  if (!dashboardAuthed(req as any)) return reply.code(401).send({ error: 'unauthorized' });
  const ok = store.delete(req.body?.key ?? '');
  return { ok };
});

app.post('/api/knowledge/reload', async (req, reply) => {
  if (!dashboardAuthed(req as any)) return reply.code(401).send({ error: 'unauthorized' });
  knowledge.reload();
  return { ok: true, files: knowledge.files() };
});

/** WebSocket للأحداث الحية */
app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  log.info(`🖥️ لوحة التحكم متصلة (المجموع: ${sockets.size})`);

  socket.send(JSON.stringify({ t: 'hello', stats: store.snapshot(), status: orchestrator.status() }));
  socket.send(JSON.stringify({ t: 'sessions', sessions: store.all().slice(0, 50) }));

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
      if (msg?.type === 'refresh') {
        socket.send(JSON.stringify({ t: 'stats', snapshot: store.snapshot() }));
        socket.send(JSON.stringify({ t: 'sessions', sessions: store.all().slice(0, 50) }));
      }
    } catch { /* نتجاهل */ }
  });

  socket.on('close', () => {
    sockets.delete(socket);
    log.info(`🖥️ لوحة التحكم انقطعت (المجموع: ${sockets.size})`);
  });
});

function loginPage(): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>تسجيل الدخول</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#111a2e;padding:2rem;border-radius:16px;border:1px solid #22304d;width:min(360px,90vw)}
input{width:100%;padding:.8rem;border-radius:10px;border:1px solid #2b3b5c;background:#0b1220;color:#fff;margin:.8rem 0;box-sizing:border-box}
button{width:100%;padding:.8rem;border-radius:10px;border:0;background:#25d366;color:#04210f;font-weight:700;cursor:pointer}
h1{font-size:1.1rem;margin:0}</style></head>
<body><form method="get"><h1>🔒 لوحة التحكم — كلمة المرور مطلوبة</h1>
<input name="pw" type="password" placeholder="كلمة المرور" autofocus>
<button>دخول</button></form></body></html>`;
}

// ─────────────────── الإقلاع ───────────────────

async function main() {
  await app.register(fastifyWebsocket);
  await store.init();
  knowledge.reload();

  // ───── قاعدة البيانات العلائقية: فتح + ترحيل + بذر ─────
  openDb(config.db.PATH || undefined);
  seedAll();
  if (config.db.IMPORT_LEGACY) {
    try { importLegacyState(); } catch (err) { log.warn(`استيراد الحالة القديمة: ${(err as Error).message}`); }
  }
  if (config.notifications.ENABLED) notifications.start();

  const check = validateConfig();
  for (const w of check.warnings) log.warn(w);
  for (const e of check.errors) log.error(e);

  if (!check.ok && !config.env.DEMO_MODE) {
    log.error('الإعدادات ناقصة. اضبط المتغيرات في .env أو شغّل وضع التجربة: DEMO_MODE=true');
    log.info('لن يتم الإقلاع. (لو تريد التجربة فقط: DEMO_MODE=true npm run start)');
    process.exit(1);
  }

  try {
    await app.listen({ host: config.server.HOST, port: config.server.PORT });
  } catch (err) {
    log.error(`فشل تشغيل الخادم: ${(err as Error).message}`);
    process.exit(1);
  }

  // إقلاع قناة تيليجرام (استطلاع دوري أو webhook)
  if (config.telegram.TOKEN && !config.env.DEMO_MODE) {
    if (config.telegram.WEBHOOK_URL) {
      await setTelegramWebhook(config.telegram.WEBHOOK_URL, config.telegram.WEBHOOK_SECRET)
        .catch((e: Error) => log.warn(`تعذّر ضبط webhook تيليجرام: ${e.message}`));
    } else {
      startTelegramPolling((u) => { void dispatchTelegramUpdate(u); });
    }
    // قائمة الأوامر الرسمية للبوت (تظهر في زر القائمة بجانب حقل الإدخال)
    await tgSetMyCommands().catch((e: Error) => log.warn(`setMyCommands: ${e.message}`));
  } else if (config.telegram.TOKEN) {
    log.info('🟢 تيليجرام: توكن مضبوط لكن DEMO_MODE=true — الإرسال الحقيقي يبدأ عند DEMO_MODE=false');
  }

  const banner = [
    '',
    '  ╔══════════════════════════════════════════════════════════╗',
    '  ║   🟢  بوت واتساب الذكي — جاهز                            ║',
    '  ╚══════════════════════════════════════════════════════════╝',
    '',
    `  الخادم        http://localhost:${config.server.PORT}`,
    `  الويب هوك     http://localhost:${config.server.PORT}${config.server.WEBHOOK_PATH}`,
    `  لوحة التحكم   http://localhost:${config.server.PORT}${config.server.DASHBOARD_PATH}${config.server.DASHBOARD_PASSWORD ? '?pw=****' : ''}`,
    `  الصحّة        http://localhost:${config.server.PORT}/health`,
    '',
    `  وضع التشغيل   ${config.env.DEMO_MODE ? '🧪 تجربة' : '🚀 حقيقي'}`,
    `  المحرك        ${
      config.llm.PROVIDER === 'openai'
        ? (config.openai.API_KEY ? `✨ OpenAI (${config.openai.MODEL})` : '🧪 محرك وهمي (لا يوجد OPENAI_API_KEY)')
        : (config.gemini.API_KEY ? `✨ Gemini (${config.gemini.MODEL})` : '🧪 محرك وهمي (لا يوجد GEMINI_API_KEY)')
    }`,
    `  واتساب        ${config.whatsapp.ENABLED ? (config.whatsapp.ACCESS_TOKEN ? '🚀 مفعّل' : '🧪 بدون توكن (تجربة)') : '⏸ موقوف — حتى حل مشكلة Meta'}`,
    `  تيليجرام      ${config.telegram.TOKEN ? (config.env.DEMO_MODE ? '🧪 توكن مضبوط (شغّل DEMO_MODE=false)' : config.telegram.WEBHOOK_URL ? '🚀 webhook' : '🚀 استطلاع دوري') : '⬜ غير مضبوط (TELEGRAM_BOT_TOKEN فارغ)'}`,
    `  نوع البوت     ${config.bot.MODE}`,
    `  قاعدة المعرفة ${knowledge.size()} ملف`,
    '',
    config.env.DEMO_MODE
      ? '  💡 جرّب الآن في طرفية أخرى:  npm run demo\n'
      : '  💡 تحتاج رابطًا عامًا للويب هوك:  npm run tunnel\n',
  ].join('\n');

  log.raw(banner);

  // تشغيل خدمة Keep-Alive إذا توفر الرابط لمنع سبات Render
  startKeepAlive();
}

// إغلاق نظيف
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.warn(`إشارة ${sig} — حفظ البيانات وإغلاق...`);
    stopKeepAlive();
    stopTelegramPolling();
    notifications.stop();
    if (config.telegram.TOKEN && !config.env.DEMO_MODE) void deleteTelegramWebhook();
    store.close();
    closeDb();
    app.close().then(() => process.exit(0)).catch(() => process.exit(0));
  });
}

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err?.stack ?? err}`);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});

main();
