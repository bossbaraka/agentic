/**
 * اختبار تدفّق سريع — يتحقق من السلوكيات الحرجة بدون مفاتيح حقيقية.
 * التشغيل: npm run test  (يتطلب أن الخادم يعمل في طرفية أخرى)
 */
import { config } from '../src/config.js';

const BASE = `http://127.0.0.1:${config.server.PORT}`;

function payload(from: string, name: string, body: string, type = 'text') {
  const message: Record<string, unknown> = {
    from, id: `wamid.T${Date.now()}${Math.floor(Math.random() * 999)}`,
    timestamp: String(Math.floor(Date.now() / 1000)), type,
  };
  if (type === 'text') message.text = { body };
  if (type === 'image') message.image = { id: 'sim', mime_type: 'image/jpeg', sha256: 'x', caption: body || undefined };
  if (type === 'location') message.location = { latitude: 32.08, longitude: 34.78, name: 'تل أبيب' };

  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'W1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '972500000000', phone_number_id: 'SIM_PNID' },
      contacts: [{ profile: { name }, wa_id: from }],
      messages: [message],
    } }] }],
  };
}

const send = async (from: string, name: string, body: string, type = 'text') => {
  const r = await fetch(`${BASE}/internal/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(from, name, body, type)),
  });
  return r.json();
};

const getSession = async (key: string) => {
  const r = await fetch(`${BASE}/api/sessions/${key}`);
  const d: any = await r.json();
  return d.session;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
  console.log('\n🧪 اختبار التدفّق\n');

  // 1) أمر المساعدة يُسجَّل بأسطر جديدة حقيقية
  console.log('1) أوامر التحكم تُسجَّل في السجل');
  await send('972500000001', 'مجرّب', '/مساعدة');
  await sleep(600);
  let s = await getSession('972500000001');
  const helpOut = s.messages.find((m: any) => m.dir === 'out');
  check('رد الأمر مخزّن', Boolean(helpOut));
  check('يحتوي أسطرًا جديدة حقيقية', Boolean(helpOut?.body.includes('\n')), JSON.stringify(helpOut?.body?.slice(0, 60)));
  check('رسالة العميل مسجّلة', s.messages.some((m: any) => m.dir === 'in'));

  // 2) تجميع الرسائل المتتابعة → رد واحد
  console.log('\n2) تجميع الرسائل المتتابعة (debounce)');
  await send('972500000002', 'سارة', 'هلا');
  await sleep(250);
  await send('972500000002', 'سارة', 'بكم التوصيل؟');
  await sleep(250);
  await send('972500000002', 'سارة', 'وهل يوجد دفع عند الاستلام؟');
  await sleep(3500);
  s = await getSession('972500000002');
  const inbound = s.messages.filter((m: any) => m.dir === 'in').length;
  const outbound = s.messages.filter((m: any) => m.dir === 'out').length;
  check(`ثلاث رسائل واردة سُجّلت (${inbound})`, inbound === 3);
  check(`ورد واحد فقط (outbound=${outbound} ≤ 3 أجزاء)`, outbound >= 1 && outbound <= 3);

  // 3) منع التكرار بنفس wamid
  console.log('\n3) منع التكرار (dedup)');
  const dup = payload('972500000003', 'مكرر', 'نفس الرسالة');
  (dup as any).entry[0].changes[0].value.messages[0].id = 'wamid.DUPLICATE_FIXED_ID';
  const post = () => fetch(`${BASE}/internal/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dup),
  });
  await post(); await sleep(200); await post(); await sleep(2500);
  s = await getSession('972500000003');
  check('سُجّلت مرة واحدة فقط', s.messages.filter((m: any) => m.dir === 'in').length === 1);

  // 4) التحويل لبشري يُسكت البوت
  console.log('\n4) التحويل لموظف بشري');
  await send('972500000004', 'زبون', '/بشري');
  await sleep(500);
  s = await getSession('972500000004');
  check('الحالة = human', s.state === 'human', s.state);
  await send('972500000004', 'زبون', 'هل من أحد؟');
  await sleep(2500);
  s = await getSession('972500000004');
  const outAfter = s.messages.filter((m: any) => m.dir === 'out').length;
  check('البوت لم يرد بعد التحويل', outAfter === 1, `out=${outAfter}`);
  await send('972500000004', 'زبون', '/بوت');
  await sleep(500);
  s = await getSession('972500000004');
  check('أمر /بوت أرجع الحالة للآلي', s.state === 'bot', s.state);

  // 5) أنواع رسائل مختلفة لا تكسر التحليل
  console.log('\n5) أنواع رسائل متنوعة');
  await send('972500000005', 'وسائط', 'صورة للمنتج', 'image');
  await sleep(200);
  await send('972500000005', 'وسائط', '', 'location');
  await sleep(2600);
  s = await getSession('972500000005');
  check('الصورة سُجّلت بنوع image', s.messages.some((m: any) => m.type === 'image'));
  check('الموقع سُجّل بنوع location', s.messages.some((m: any) => m.type === 'location'));

  // 6) الرد اليدوي من اللوحة يأخذ المحادثة
  console.log('\n6) الرد اليدوي من لوحة التحكم');
  const r = await fetch(`${BASE}/api/sessions/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: '972500000005', text: 'أهلًا، أنا موظف من الفريق وأتابع معك الآن.', takeOver: true }),
  });
  const rj: any = await r.json();
  check('أُرسل بنجاح', rj.ok === true);
  await sleep(300);
  s = await getSession('972500000005');
  check('الحالة صارت human', s.state === 'human', s.state);
  check('الرد اليدوي مخزّن', s.messages.some((m: any) => m.dir === 'out' && m.meta?.manual === true));

  console.log(`\n${'─'.repeat(46)}`);
  console.log(`  النتيجة: ${pass} نجح / ${fail} فشل`);
  console.log(`${'─'.repeat(46)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
