import { config } from '../config.js';
import { log, sleep } from '../lib/utils.js';

/**
 * محاكي واتساب — يجرّب البوت من الطرفية بدون رقم حقيقي وبدون Meta.
 *
 * الاستخدام:
 *   1) في طرفية:  DEMO_MODE=true npm run start
 *   2) في طرفية أخرى:  npm run demo
 *
 * يرسل webhooks مزيّفة إلى /internal/simulate فيظهر لك المسار الكامل:
 * تحليل → جلسة → debounce → Gemini/Mock → تقسيم → إرسال → لوحة التحكم.
 *
 * وضع الحوار التفاعلي:  npm run demo -- chat
 */

const PORT = config.server.PORT;
const BASE = `http://127.0.0.1:${PORT}`;

/** بناء حمولة webhook مطابقة تمامًا لما ترسله Meta */
function buildPayload(opts: {
  from: string;
  name?: string;
  body: string;
  type?: string;
  phoneNumberId?: string;
}): Record<string, unknown> {
  const type = opts.type ?? 'text';
  const id = `wamid.SIM${Date.now()}${Math.floor(Math.random() * 999)}`;
  const from = opts.from;

  const message: Record<string, unknown> = {
    from,
    id,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
  };

  if (type === 'text') {
    message.text = { body: opts.body };
  } else if (type === 'image') {
    message.image = { id: 'sim-media-id', mime_type: 'image/jpeg', sha256: 'x', caption: opts.body || undefined };
  } else if (type === 'audio') {
    message.audio = { id: 'sim-media-id', mime_type: 'audio/ogg; codecs=opus', sha256: 'x' };
  } else if (type === 'location') {
    message.location = { latitude: 32.0853, longitude: 34.7818, name: 'تل أبيب', address: 'ديزنغوف 100' };
  } else if (type === 'reaction') {
    message.reaction = { message_id: id, emoji: opts.body || '👍' };
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIM_WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '972500000000',
                phone_number_id: opts.phoneNumberId ?? config.whatsapp.PHONE_NUMBER_ID ?? 'SIM_PHONE_NUMBER_ID',
              },
              contacts: [{ profile: { name: opts.name ?? 'عميل تجريبي' }, wa_id: from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** بناء حمولة تيليجرام مطابقة تمامًا لما يرسله Telegram */
function buildTgPayload(opts: {
  from: string;      // chat id
  name?: string;
  body: string;
  type?: string;
}): Record<string, unknown> {
  const type = opts.type ?? 'text';
  const message: Record<string, unknown> = {
    message_id: Math.floor(Math.random() * 1_000_000),
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(opts.from), first_name: opts.name ?? 'عميل تجريبي', type: 'private' },
    from: {
      id: Number(opts.from),
      first_name: opts.name ?? 'عميل تجريبي',
      is_bot: false,
    },
  };

  if (type === 'text') message.text = opts.body;
  else if (type === 'image') {
    message.photo = [{ file_id: 'sim-photo', width: 800, height: 600 }];
    if (opts.body) message.caption = opts.body;
  } else if (type === 'audio') message.audio = { file_id: 'sim-audio', mime_type: 'audio/ogg', duration: 5 };
  else if (type === 'location') message.location = { latitude: 32.0853, longitude: 34.7818, label: 'تل أبيب' };

  return {
    update_id: Date.now(),
    message,
  };
}

async function send(payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/internal/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.error(`الخادم ردّ ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`تعذّر الاتصال بالخادم على ${BASE} — هل شغّلته؟ (${(err as Error).message})`);
    log.info('شغّل في طرفية أخرى:  DEMO_MODE=true npm run start');
    return false;
  }
}

/** سيناريو محادثات أصحاب مطاعم مع منصة مُريح — يغطي البيع + التفعيل + الدعم */
const SCENARIO: { channel: 'tg' | 'wa'; from: string; name: string; body: string; type?: string; gap?: number; note?: string }[] = [
  { channel: 'tg', from: '100001', name: 'يوسف النجار', body: 'السلام عليكم، عندي مطعم في رمات غان', note: '[تيليجرام] تحية + سياق: صاحب مطعم' },
  { channel: 'tg', from: '100001', name: 'يوسف النجار', body: 'عندنا 25 طاولة، وش باقة تنصحونني فيها؟', note: '[تيليجرام] توصية باقة (25 طاولة → الاحترافية)' },
  { channel: 'tg', from: '100001', name: 'يوسف النجار', body: 'تمام، أبغى أشترك بالباقة الاحترافية', note: '[تيليجرام] طلب تفعيل اشتراك (في وضع Gemini: أداة capture_subscription_lead)' },
  { channel: 'tg', from: '100001', name: 'يوسف النجار', body: 'اسمي يوسف النجار، المطعم اسمه نور، في رمات غان، 25 طاولة', note: '[تيليجرام] بيانات التفعيل → تأكيد + تنبيه الفريق' },
  // ثلاث رسائل متتالية خلال أقل من ثانية → البوت يجمعها ويردّ مرة واحدة (debounce)
  {
    channel: 'tg', from: '100002', name: 'Sara Cohen', body: 'Hi! We run 3 branches in Tel Aviv', gap: 300,
    note: '[تيليجرام] ٣ رسائل متتابعة خلال ٣٠ms → يجب أن يردّ البوت ردًا واحدًا مدمجًا (سلسلة فروع)',
  },
  { channel: 'tg', from: '100002', name: 'Sara Cohen', body: 'Does the enterprise plan cover all of them?', gap: 300 },
  { channel: 'tg', from: '100002', name: 'Sara Cohen', body: 'And what is the yearly price?' },
  { channel: 'tg', from: '100003', name: 'خالد (مشترك)', body: 'مشترك عندكم لكن شاشة المطبخ ما تعطي تنبيهات صوتية', note: '[تيليجرام] مشكلة تقنية لمشترك → تذكرة + تحويل لفريق الدعم' },
  { channel: 'tg', from: '100004', name: 'زبون غاضب', body: 'خدمتكم سيئة وبدي أسترداد فلوسي!', note: '[تيليجرام] شكوى/استرداد → تحويل بشري + تنبيه' },
  { channel: 'tg', from: '100005', name: 'مجرّب', body: '', type: 'image', note: '[تيليجرام] رسالة صورة (تُشرح نصيًا في وضع التجربة)' },
  { channel: 'tg', from: '100006', name: 'مجرّب أوامر', body: '/مساعدة', note: '[تيليجرام] أوامر التحكم' },
];

async function runScenario() {
  log.raw('\n╔════════════════════════════════════════════════════════════╗');
  log.raw('║  🧪 محاكي واتساب — سيناريو محادثات كامل                    ║');
  log.raw('╚════════════════════════════════════════════════════════════╝\n');
  log.info(`الخادم المستهدف: ${BASE}`);
  log.info('راقب الردود في طرفية الخادم وفي لوحة التحكم: ' + `${BASE.replace('127.0.0.1', 'localhost')}${config.server.DASHBOARD_PATH}\n`);

  // نتأكد أن الخادم حيّ
  try {
    const h = await fetch(`${BASE}/health`);
    const j: any = await h.json();
    log.ok(`الخادم يعمل — المحرك: ${j.engine ?? '?'} | الوضع: ${j.mode ?? '?'} | قاعدة معرفة: ${j.knowledgeFiles?.length ?? 0} ملف\n`);
  } catch {
    log.error('الخادم لا يستجيب على المنفذ ' + PORT);
    log.info('شغّله أولًا:  DEMO_MODE=true npm run start');
    process.exit(1);
  }

  for (const step of SCENARIO) {
    if (step.note) log.raw(`\n\x1b[36m▸ سيناريو: ${step.note}\x1b[0m`);
    const chTag = step.channel === 'tg' ? '[TG]' : '[WA]';
    log.raw(`\x1b[33m👤 ${step.name} (${step.from}) ${chTag}\x1b[0m${step.type && step.type !== 'text' ? ` [${step.type}]` : ''}: ${step.body || '(وسائط)'}`);
    const payload = step.channel === 'tg'
      ? { channel: 'tg', update: buildTgPayload(step) }
      : buildPayload(step);
    const ok = await send(payload);
    if (!ok) return;
    await sleep(step.gap ?? 4200);
  }

  log.raw('\n✅ انتهى السيناريو. افتح لوحة التحكم لترى كل المحادثات والردود.');
  log.raw('   جرّب الوضع التفاعلي:  npm run demo -- chat\n');
}

/** وضع حوار تفاعلي من الطرفية */
async function runChat() {
  const from = process.env.SIM_PHONE ?? '972509999999';
  const name = process.env.SIM_NAME ?? 'أنت';

  log.raw('\n💬 وضع الحوار التفاعلي — اكتب رسالتك واضغط Enter.');
  log.raw('   الأوامر الخاصة:  /خروج  |  /صورة  |  /موقع  |  /صوت\n');
  log.info(`رقمك التجريبي: ${from} — الردود تظهر في طرفية الخادم وفي اللوحة.\n`);

  const stdin = process.stdin;
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: true });

  rl.setPrompt('\x1b[32mأنت › \x1b[0m');
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/خروج' || text === '/exit') { rl.close(); process.exit(0); }

    let type = 'text';
    let body = text;
    if (text === '/صورة') { type = 'image'; body = 'صورة تجريبية'; }
    if (text === '/موقع') { type = 'location'; body = ''; }
    if (text === '/صوت') { type = 'audio'; body = ''; }

    await send(buildPayload({ from, name, body, type }));
    log.info('أُرسلت — شاهد الرد في طرفية الخادم أو اللوحة.');
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

const mode = process.argv[2] ?? 'scenario';
if (mode === 'chat') void runChat();
else void runScenario();
