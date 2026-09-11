import { classifyIntent, normalize } from '../src/agent/intelligence/intent.js';
for (const t of ['كيف يعمل النظام بالضبط؟', 'كيفك؟', 'شو مزايا الباقة الاحترافية؟', 'شو باقاتكم؟', 'شو تشمل الأساسية؟']) {
  const n = normalize(t);
  console.log(JSON.stringify({ t, n, r: classifyIntent(t) }));
}
