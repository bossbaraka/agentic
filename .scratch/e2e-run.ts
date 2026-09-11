/** E2E حتمي: مسار كامل عبر المنسّق بمحرك mock (بدون مفتاح LLM) — بيئة معزولة */
process.env.DEMO_MODE = 'true';
process.env.DATA_DIR = '/tmp/agentic-e2e/data';
process.env.DB_PATH = '/tmp/agentic-e2e/mureeh.sqlite';
process.env.NOTIFICATIONS_ENABLED = 'false';

const { store } = await import('../src/lib/store.js');
await store.init();
const { orchestrator } = await import('../src/agent/agent.js');

const sentMessages: string[] = [];
const origAddOutbound = store.addOutbound.bind(store);
(store as any).addOutbound = (key: string, rec: any) => {
  if (rec?.dir === 'out') sentMessages.push(rec.body);
  return origAddOutbound(key, rec);
};

async function send(from: string, body: string) {
  const msg: any = {
    waId: `wamid.${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    from, type: 'text', body, timestamp: Date.now(), contactName: 'أبو خالد',
    phoneNumberId: 'SIM', channel: 'wa' as const,
  };
  await orchestrator.handleInbound(msg);
  await new Promise(r => setTimeout(r, 2600));
}

const key = `97250000${Math.floor(Math.random() * 900 + 100)}`;
await send(key, 'هلا');
console.log('--- R1:', JSON.stringify(sentMessages.at(-1)));
await send(key, 'عندي مطعم 20 طاولة');
console.log('--- R2:', JSON.stringify(sentMessages.at(-1)));
await send(key, 'النادل عندي بتأخر كثير والطلبات بتضيع وقت الذروة');
console.log('--- R3:', JSON.stringify(sentMessages.at(-1)));
await send(key, 'قديش السعر؟');
console.log('--- R4:', JSON.stringify(sentMessages.at(-1)));
await send(key, '550 غالي شوي');
console.log('--- R5:', JSON.stringify(sentMessages.at(-1)));
await send(key, 'تمام بدي أشترك');
console.log('--- R6:', JSON.stringify(sentMessages.at(-1)));

const s = store.get(key);
console.log('=== FINAL STATE ===');
console.log(JSON.stringify({ stage: s.customer?.stage, pains: s.customer?.painPoints, objections: s.customer?.objections?.map(o => o.kind), purchaseIntent: s.customer?.purchaseIntent, leadScore: s.customer?.leadScore, leadCategory: s.customer?.leadCategory, lastIntent: s.customer?.lastIntent, businessType: s.customer?.businessType }, null, 0));
process.exit(0);
