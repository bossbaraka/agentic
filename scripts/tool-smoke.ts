/** فحص سريع مباشر للأدوات (نفس مسار Gemini) */
import { runTool } from '../src/agent/tools.js';

const ctx = { sessionKey: '972590000099', customerName: 'عادل حبيب' };

async function main() {
  const rec = await runTool('recommend_plan', { tables: 25, needs: [] }, ctx);
  console.log('--- recommend_plan (25) ---'); console.log(rec.userMessage);

  const det = await runTool('get_plan_details', { plan_id: 'pro', billing: 'yearly' }, ctx);
  console.log('\n--- get_plan_details (pro/yearly) ---'); console.log(det.userMessage);

  const lead = await runTool('capture_subscription_lead', {
    full_name: 'عادل حبيب', restaurant_name: 'زهرة', city: 'حيفا',
    tables: 8, preferred_plan: 'starter', whatsapp_number: '972590000099',
  }, ctx);
  console.log('\n--- capture_subscription_lead ---'); console.log(lead.userMessage);
  console.log('sideEffect:', lead.sideEffect?.payload?.note);

  const tix = await runTool('create_support_ticket', {
    restaurant_name: 'نور', plan: 'pro', issue: 'شاشة المطبخ لا تعطي تنبيهات', priority: 'high',
  }, ctx);
  console.log('\n--- create_support_ticket ---'); console.log(tix.userMessage);
}
main().catch((e) => { console.error(e); process.exit(1); });
