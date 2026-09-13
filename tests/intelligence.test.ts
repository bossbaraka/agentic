import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/db.js';
import {
  classifyIntent,
  normalize,
  detectPainPoints,
  detectObjections,
  objectionPolicy,
  computeLeadScore,
  categoryOf,
  advanceStage,
  stagePolicy,
  newCustomerState,
  applyAnalysis,
  analyzeMessages,
  detectBusinessType,
} from '../src/agent/intelligence/index.js';
import {
  applyResponsePolicy,
  checkPrices,
  stripTrailingCta,
} from '../src/agent/responsePolicy.js';
import { removeRepeatedMemoryQuestions } from '../src/agent/agent.js';
import { parseAgentJson, sanitizeReplyPart, buildModelChain } from '../src/agent/llm.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

describe('مصنّف النية الحتمي', () => {
  it('يطبّع الهمزات والتاء المربوطة', () => {
    assert.equal(normalize('بتأخّر'), 'بتاخر');
    assert.equal(normalize('غالية'), 'غاليه');
    assert.equal(normalize('هلاااا'), 'هلاا');
  });

  it('تحية بسيطة', () => {
    const r = classifyIntent('هلا');
    assert.equal(r.intent, 'greeting');
  });

  it('سؤال سعر بلهجة شامية (قديش؟)', () => {
    const r = classifyIntent('قديش الباقات؟');
    assert.equal(r.intent, 'pricing');
    assert.notEqual(r.confidence, 'low');
  });

  it('نية شراء صريحة (بدي أشترك)', () => {
    const r = classifyIntent('تمام بدي أشترك');
    assert.equal(r.intent, 'purchase_intent');
  });

  it('اعتراض سعري (غالي شوي / 550 كثير)', () => {
    assert.equal(classifyIntent('550 غالي شوي').intent, 'objection_price');
    assert.equal(classifyIntent('السعر مرتفع عندي').intent, 'objection_price');
  });

  it('تأجيل (خليني أفكر) — النص المطبَّع يطابق', () => {
    assert.equal(classifyIntent('خليني أفكر').intent, 'objection_timing');
    assert.equal(classifyIntent('بعدين ان شاء الله').intent, 'objection_timing');
  });

  it('طلب بشري صريح', () => {
    assert.equal(classifyIntent('ابغى اتكلم مع موظف').intent, 'human_request');
  });

  it('حجز موعد تفعيل', () => {
    assert.equal(classifyIntent('ابغى احجز موعد تفعيل').intent, 'booking');
  });

  it('إلغاء حجز يتقدم على الحجز العام', () => {
    const r = classifyIntent('بدي ألغي الحجز');
    assert.equal(r.intent, 'booking_cancellation');
  });

  it('مطعم ببيانات (عندي مطعم 20 طاولة)', () => {
    assert.equal(classifyIntent('عندي مطعم 20 طاولة').intent, 'restaurant_qualification');
  });

  it('مقارنة باقات (شو الفرق؟)', () => {
    assert.equal(classifyIntent('شو الفرق بين الباقات؟').intent, 'plan_comparison');
  });

  it('ألم صريح في رسالة الأسعار لا يخفي السؤال — السعر يتقدم', () => {
    const r = classifyIntent('النادل عندي بيتاخر كثير، بكم الباقات؟');
    assert.equal(r.intent, 'pricing');
  });

  it('رسالة قصيرة بلا سياق = unclear لا تخمين', () => {
    assert.equal(classifyIntent('طيب').intent, 'unclear');
  });

  it('جواب قصير يُفسَّر بآخر سؤال للبوت', () => {
    const r = classifyIntent('25', { lastBotMessage: 'كم طاولة تشتغل عندك؟' });
    assert.equal(r.intent, 'restaurant_qualification');
  });

  it('جواب قصير يحمل اعتراضًا لا يُفسَّر كجواب موضع', () => {
    const r = classifyIntent('550 غالي', { lastBotMessage: 'كم طاولة تشتغل عندك؟' });
    assert.equal(r.intent, 'objection_price');
  });

  it('تحية + سؤال = السؤال يتقدم', () => {
    assert.equal(classifyIntent('هلا، بكم الباقات؟').intent, 'pricing');
  });

  it('سؤال عن خدمات المنصة', () => {
    assert.equal(classifyIntent('شو خدماتكم؟').intent, 'product_information');
  });

  it('طلب موقع إلكتروني', () => {
    assert.equal(classifyIntent('بدي موقع لمطعمي').intent, 'service_information');
  });

  it('طلب وكيل واتساب', () => {
    assert.equal(classifyIntent('في عندكم بوت واتساب؟').intent, 'service_information');
  });
});

describe('نقاط الألم', () => {
  it('نادل متأخر → slow_waiter مع حل وسؤال', () => {
    const hits = detectPainPoints('النادل عندي بتأخر كثير');
    assert.equal(hits[0]!.pain, 'slow_waiter');
    assert.ok(hits[0]!.qualificationQuestion.length > 5);
  });

  it('طلبات بتضيع → lost_orders', () => {
    assert.equal(detectPainPoints('الطلبات بتضيع وقت الذروة')[0]!.pain, 'lost_orders');
  });

  it('منيو ورقي → paper_menu', () => {
    assert.equal(detectPainPoints('عندي منيو ورقي وكل تغيير سعر بيطبع من جديد')[0]!.pain, 'paper_menu');
  });

  it('حسابات يدوية → manual_accounting', () => {
    assert.equal(detectPainPoints('الحسابات عندنا يدوية بالدفتر آخر اليوم')[0]!.pain, 'manual_accounting');
  });

  it('فرعين → multi_branch', () => {
    assert.equal(detectPainPoints('عندي فرعين وبيصعب المتابعة')[0]!.pain, 'multi_branch');
  });

  it('بلا ألم = قائمة فارغة', () => {
    assert.equal(detectPainPoints('شكرا جزيلا').length, 0);
  });

  it('بدي موقع → no_website', () => {
    assert.equal(detectPainPoints('بدي موقع')[0]!.pain, 'no_website');
  });

  it('واتساب ما نرد → missed_messages', () => {
    assert.equal(detectPainPoints('رسائل الواتساب ما نرد عليها بالليل')[0]!.pain, 'missed_messages');
  });
});

describe('الاعتراضات', () => {
  it('رصد أكثر من اعتراض في رسالة واحدة', () => {
    const hits = detectObjections('غالي ومعقد ما بفهم فيه');
    assert.deepEqual(hits.map((h) => h.kind).sort(), ['complexity', 'price']);
  });

  it('لكل اعتراض سياسة «افعل/تجنب»', () => {
    const p = objectionPolicy('price');
    assert.ok(p.approach.includes('قس'));
    assert.ok(p.avoid.includes('خصم'));
  });
});

describe('نقاط الجودة (حتمية)', () => {
  it('نية شراء + مطعم + طاولات = qualified على الأقل', () => {
    const state = newCustomerState();
    state.purchaseIntent = true;
    const r = computeLeadScore(state, ['purchase_intent'], { restaurantName: 'مطعم', tables: 20 });
    assert.ok(r.score >= 61, `score=${r.score}`);
    assert.equal(categoryOf(r.score), 'qualified');
  });

  it('التكرار لا يتضاعف — نفس الإشارة تُحسب مرة', () => {
    const a = computeLeadScore(newCustomerState(), ['purchase_intent', 'purchase_intent', 'purchase_intent'], {});
    const b = computeLeadScore(newCustomerState(), ['purchase_intent'], {});
    assert.equal(a.score, b.score);
  });

  it('موضوع غير مرتبط يخصم', () => {
    const state = newCustomerState();
    const r = computeLeadScore(state, ['unrelated_topic'], {});
    assert.equal(r.score, 2); // 10 - 8
    assert.equal(r.category, 'cold');
  });

  it('النقاط لا تتجاوز 100 ولا تنزل عن 0', () => {
    const hot = computeLeadScore(newCustomerState(), ['purchase_intent', 'requested_onboarding', 'asked_pricing', 'asked_comparison', 'pain_point_shared'], { restaurantName: 'x', tables: 5 });
    assert.ok(hot.score <= 100);
    const cold = computeLeadScore(newCustomerState(), ['unrelated_topic', 'rejection_signal', 'unrelated_topic'], {});
    assert.ok(cold.score >= 0);
  });
});

describe('آلة مراحل البيع', () => {
  it('لا يقفز للتحويل من الاكتشاف', () => {
    const s = advanceStage('DISCOVERY', { intent: 'greeting', profile: {} });
    assert.equal(s, 'DISCOVERY');
    const s2 = advanceStage('DISCOVERY', { intent: 'restaurant_qualification', profile: {} });
    assert.equal(s2, 'QUALIFICATION');
  });

  it('نية شراء صريحة ترفع لـ PURCHASE_INTENT', () => {
    assert.equal(advanceStage('DISCOVERY', { intent: 'purchase_intent', profile: {} }), 'PURCHASE_INTENT');
  });

  it('اعتراض بعد التوصية يعالج الاعتراض', () => {
    assert.equal(advanceStage('RECOMMENDATION', { intent: 'objection_price', profile: {}, newObjection: true }), 'OBJECTION_HANDLING');
  });

  it('شكوى = CUSTOMER_SUPPORT من أي مرحلة', () => {
    assert.equal(advanceStage('PURCHASE_INTENT', { intent: 'complaint', profile: {} }), 'CUSTOMER_SUPPORT');
  });

  it('تأكيد إطلاق (أداة) = ONBOARDING', () => {
    assert.equal(advanceStage('PURCHASE_INTENT', { intent: 'purchase_intent', profile: { preferredPlan: 'pro' }, launchStatus: 'confirmed' }), 'ONBOARDING');
  });

  it('لكل مرحلة سياسة نصية', () => {
    for (const stage of ['DISCOVERY', 'PURCHASE_INTENT', 'CUSTOMER_SUPPORT'] as const) {
      assert.ok(stagePolicy(stage).length > 30);
    }
  });

  it('سياسة الاكتشاف تمنع البيع', () => {
    assert.ok(stagePolicy('DISCOVERY').includes('ممنوع البيع'));
  });
});

describe('applyAnalysis — تحديث الحالة الدائمة', () => {
  it('يجمع ألمًا واعتراضًا ونية شراء ويرفع النقاط', () => {
    const state = newCustomerState();
    const analysis = analyzeMessages({ combined: 'النادل بيتاخر والطلبات بتضيع، بس 550 غالي' });
    const next = applyAnalysis({ state, analysis, profile: {} });
    assert.ok(next.painPoints.length >= 1);
    assert.ok(next.objections.some((o) => o.kind === 'price'));
    assert.equal(next.stage, 'OBJECTION_HANDLING');
    assert.ok(next.leadScore > newCustomerState().leadScore);
  });

  it('نية شراء تعيّن conversationGoal ولا تُنزع لاحقًا', () => {
    const state = newCustomerState();
    const a1 = analyzeMessages({ combined: 'بدي أشترك' });
    const next = applyAnalysis({ state, analysis: a1, profile: {} });
    assert.equal(next.purchaseIntent, true);
    const a2 = analyzeMessages({ combined: 'شكرا' });
    const next2 = applyAnalysis({ state: next, analysis: a2, profile: {} });
    assert.equal(next2.purchaseIntent, true);
  });

  it('يكتشف طابع النشاط من النص', () => {
    assert.equal(detectBusinessType('عندي كافيه صغير'), 'cafe');
    assert.equal(detectBusinessType('عندي سلسلة مطاعم'), 'chain');
  });
});

describe('سياسة الاستجابة', () => {
  it('يرفض سعرًا غير رسمي قرب اسم باقة ويصححه', () => {
    const { parts, findings } = checkPrices(['الباقة الاحترافية بـ 620 ₪/شهر']);
    assert.equal(findings[0]!.kind, 'price_violation');
    assert.equal(findings[0]!.repaired, true);
    assert.ok(parts[0]!.includes('550'));
  });

  it('يقبل الأسعار الرسمية وأقساط الطاولات المحسوبة', () => {
    const { findings } = checkPrices([
      'الاحترافية 550 ₪/شهر — أي ~22 ₪ للطاولة عند 25 طاولة، والسنوي 5500 ₪',
    ]);
    assert.equal(findings.length, 0);
  });

  it('يمنع تكرار CTA من الرد السابق', () => {
    const prev = 'هذي باقتك المقترحة. تبيني أجهّز لك التفعيل؟';
    const { parts, findings } = applyResponsePolicy({
      parts: ['وخلصنا التفاصيل. تبيني أجهّز لك التفعيل؟'],
      previousOutboundText: prev,
      purchaseIntent: false,
      supportMode: false,
      intentUnclear: false,
      engine: 'gemini',
      sessionKey: 'test',
    });
    assert.ok(findings.some((f) => f.kind === 'cta_repeat' && f.repaired));
    assert.ok(!parts.join(' ').includes('تبيني أجهّز لك التفعيل'));
  });

  it('لا يحذف CTA عند نية شراء صريحة', () => {
    const prev = 'تبيني أجهّز لك التفعيل؟';
    const { findings } = applyResponsePolicy({
      parts: ['تمام نجهزها. تبيني أجهّز لك التفعيل؟'],
      previousOutboundText: prev,
      purchaseIntent: true,
      supportMode: false,
      intentUnclear: false,
      engine: 'gemini',
      sessionKey: 'test',
    });
    assert.equal(findings.length, 0);
  });

  it('يحذف أي بيع في رسالة دعم', () => {
    const { parts, findings } = applyResponsePolicy({
      parts: ['بنحلها مع بعض. تحب نبدأ التفعيل؟'],
      previousOutboundText: 'ردي السابق فيه CTA مثلا تبيني أجهز لك التفعيل',
      purchaseIntent: false,
      supportMode: true,
      intentUnclear: false,
      engine: 'gemini',
      sessionKey: 'test',
    });
    assert.ok(findings.some((f) => f.kind === 'premature_cta'));
    assert.ok(!parts.join(' ').includes('نبدأ التفعيل'));
  });

  it('stripTrailingCta يحذف جملة البيع الختامية فقط', () => {
    const out = stripTrailingCta('هذي التفاصيل كاملة. تبيني أجهّز لك التفعيل؟');
    assert.ok(out.startsWith('هذي التفاصيل'));
    assert.ok(!out.includes('تفعيل'));
  });

  it('ينظف تسرب الاستدلال الداخلي', () => {
    const { parts } = applyResponsePolicy({
      parts: ['تحليل داخلي: النية تسعير\nالجواب: السعر 300'],
      purchaseIntent: false,
      supportMode: false,
      intentUnclear: false,
      engine: 'gemini',
      sessionKey: 'test',
    });
    assert.ok(!parts.join(' ').includes('تحليل داخلي'));
    assert.ok(parts.join(' ').includes('300'));
  });
});

describe('حارس الأسئلة المحفوظة (القديم + الجديد)', () => {
  it('يحذف سؤال الطاولات إذا محفوظة', () => {
    const out = removeRepeatedMemoryQuestions(
      ['حلو يا أبو خالد. كم طاولة تشتغل عندك؟'],
      { tables: 20 },
      undefined,
    );
    assert.equal(out.length, 0);
  });

  it('يحذف سؤال اسم المطعم إذا محفوظ', () => {
    const out = removeRepeatedMemoryQuestions(
      ['تمام. شو اسم المطعم؟'],
      { restaurant_name: 'الأصيل' },
      undefined,
    );
    assert.equal(out.length, 0);
  });
});

describe('عقد إخراج النموذج (parse + sanitize)', () => {
  it('يفك JSON سليمًا', () => {
    const r = parseAgentJson('{"reply_parts":["أهلًا"],"quick_replies":[],"handoff":false,"intent":"تحية","sentiment":"positive"}');
    assert.equal(r.ok, true);
    assert.equal(r.parts[0], 'أهلًا');
    assert.equal(r.intent, 'تحية');
  });

  it('ينقذ JSON مكسورًا', () => {
    const r = parseAgentJson('{"reply_parts":["سطر أول", "سطر ثاني",]');
    assert.equal(r.ok, true);
    assert.ok(r.parts.length >= 1);
  });

  it('لا يرسل JSON خام للعميل أبدًا', () => {
    assert.equal(sanitizeReplyPart('{"reply_parts":["x"]}'), '');
  });

  it('ينظف ملاحظات النظام المتسربة', () => {
    const out = sanitizeReplyPart('جملة للعميل [ملاحظة نظام: لا تكرر السؤال] تكملة');
    assert.ok(!out.includes('ملاحظة نظام'));
    assert.ok(out.includes('جملة للعميل'));
  });
});

describe('سلسلة الموديلات', () => {
  it('بلا موديلات معاينة أو موقوفة في الافتراضي', () => {
    const chain = buildModelChain();
    for (const m of chain) {
      assert.ok(!/preview/i.test(m), `موديل معاينة في السلسلة: ${m}`);
      assert.ok(!/gemini-(1\.|2\.0)/i.test(m), `موديل موقوف في السلسلة: ${m}`);
    }
  });

  it('الأساسي أولًا ثم بديل واحد مُدقَّق على الأقل', () => {
    const chain = buildModelChain();
    assert.ok(chain.length >= 2);
    assert.equal(chain[0], 'gemini-2.5-flash');
  });
});

describe('تركيب البرومبت الطبقي', () => {
  const base = {
    mode: 'business' as const,
    customerName: 'أحمد',
    customerNumber: '972500',
    sessionLanguage: 'ar',
    summary: 'ملخص سابق',
    toolsEnabled: true,
  };

  it('يحتوي كل الطبقات الأساسية', () => {
    const p = buildSystemPrompt({ ...base, profile: { tables: 20 } });
    assert.ok(p.includes('من أنت'));
    assert.ok(p.includes('أولويات الرد'));
    assert.ok(p.includes('الذاكرة'));
    assert.ok(p.includes('الأمان'));
    assert.ok(p.includes('الأدوات'));
    assert.ok(p.includes('reply_parts'));
    assert.ok(p.includes('منهج البيع'));
  });

  it('كتلة التحليل الحتمي تُحقن كما هي', () => {
    const p = buildSystemPrompt({ ...base, intelligenceBlock: '- مرحلة العميل: DISCOVERY' });
    assert.ok(p.includes('مرحلة العميل: DISCOVERY'));
  });

  it('وضع المساعد يستثني سياسة البيع', () => {
    const p = buildSystemPrompt({ ...base, mode: 'assistant', toolsEnabled: false });
    assert.ok(!p.includes('منهج البيع'));
  });

  it('الذاكرة تُذكر مرة واحدة بلا تكرار ضخم', () => {
    const p = buildSystemPrompt({ ...base });
    const count = (p.match(/سجل ملزم/g) ?? []).length;
    assert.ok(count <= 2, `تكرار قواعد الذاكرة: ${count}`);
  });
});
