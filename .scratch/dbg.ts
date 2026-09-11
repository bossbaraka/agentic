import { applyResponsePolicy } from '../src/agent/responsePolicy.js';
const r = applyResponsePolicy({
  parts: ['بنحلها مع بعض. تحب نبدأ التفعيل؟'],
  previousOutboundText: 'ردي السابق فيه CTA مثلا تبيني أجهز لك التفعيل',
  purchaseIntent: false, supportMode: true, intentUnclear: false,
  engine: 'gemini', sessionKey: 't',
});
console.log(JSON.stringify(r, null, 1));
