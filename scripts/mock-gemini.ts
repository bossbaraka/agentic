/**
 * خادم محاكٍ لواجهة Gemini — لاختبار مسار الذكاء الكامل بدون مفتاح حقيقي.
 *
 * يفحص الطلب الفعلي الذي يبنيه المشروع (systemInstruction، contents،
 * الوسائط كـ inlineData، تعريف الأدوات) ويردّ كما يردّ Gemini:
 *   • أول استدعاء  → functionCall (يختبر حلقة الأدوات)
 *   • ثاني استدعاء → JSON بالعقد المطلوب (يختبر فكّ الاستجابة)
 *
 * التشغيل: npx tsx scripts/mock-gemini.ts   (منفذ 8787)
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8787);
let calls = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls++;
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* */ }

    const url = req.url ?? '';
    console.log(`\n━━━ [${calls}] ${req.method} ${url}`);

    // ── نفحص ما أرسله المشروع ──
    // الـ SDK يرسل الإعدادات في أعلى الجسم (وليس تحت config)
    const cfg = body.config ?? body;
    const model = body.model ?? (url.match(/models\/([^:?]+)/)?.[1] ?? '');
    const contents = body.contents ?? [];
    const sys = cfg.systemInstruction;
    const sysText = typeof sys === 'string' ? sys : JSON.stringify(sys ?? '');

    console.log(`  model            : ${model}`);
    console.log(`  systemInstruction: ${sysText.length} حرف`);
    console.log(`    · يذكر اسم البوت؟ ${/سارة|BOT_NAME|مساعد/.test(sysText)}`);
    console.log(`    · يحوي قاعدة المعرفة؟ ${/متجر النخبة|ديزنغوف/.test(sysText)}`);
    console.log(`    · يحوي عقد JSON؟ ${/reply_parts/.test(sysText)}`);
    console.log('  مفاتيح الجسم     : ' + Object.keys(body).join(', '));
    console.log(`  temperature      : ${cfg.temperature}  (generationConfig: ${JSON.stringify(body.generationConfig ?? cfg.generationConfig ?? null)})`);
    console.log(`  thinkingBudget   : ${cfg.thinkingConfig?.thinkingBudget ?? (body.generationConfig?.thinkingConfig?.thinkingBudget)}`);
    console.log(`  tools            : ${cfg.tools ? JSON.stringify(cfg.tools).length + ' حرف' : 'لا يوجد'}`);
    console.log(`  responseMimeType : ${cfg.responseMimeType ?? '—'}`);
    console.log(`  contents         : ${contents.length} دور`);
    contents.forEach((c: any, i: number) => {
      const kinds = (c.parts ?? []).map((p: any) =>
        p.text !== undefined ? `text(${String(p.text).length})`
        : p.inlineData ? `inlineData:${p.inlineData.mimeType}`
        : p.functionCall ? `functionCall:${p.functionCall.name}`
        : p.functionResponse ? `functionResponse:${p.functionResponse.name}`
        : Object.keys(p).join('|'),
      );
      console.log(`    [${i}] ${c.role}: ${kinds.join(', ')}`);
    });

    // ── هل أعاد المشروع نتيجة الأداة؟ ──
    const hasFnResponse = contents.some((c: any) =>
      (c.parts ?? []).some((p: any) => p.functionResponse),
    );

    res.setHeader('Content-Type', 'application/json');

    if (!hasFnResponse && /حجز|موعد|book/.test(JSON.stringify(contents))) {
      // الجولة الأولى: اطلب استدعاء أداة
      console.log('  → الرد: functionCall(book_appointment)');
      res.end(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'book_appointment',
                args: {
                  service: 'استشارة عناية بالبشرة',
                  preferred_date: '2026-09-11 17:00',
                  customer_name: 'خالد',
                  phone: '972503333333',
                },
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 40, totalTokenCount: 2140 },
      }));
      return;
    }

    // الجولة النهائية: JSON بالعقد المطلوب
    const payload = {
      reply_parts: [
        'أهلًا فيك 👋 سعر التوصيل داخل تل أبيب *25 ₪* وخلال 24–48 ساعة عمل.',
        'ولباقي المناطق *40 ₪* خلال 2–4 أيام. والتوصيل مجاني للطلبات فوق *400 ₪* 🙂',
      ],
      handoff: false,
      handoff_reason: '',
      intent: 'استفسار_شحن',
      sentiment: 'neutral',
    };

    console.log(`  → الرد: JSON (${payload.reply_parts.length} جزء)`);
    res.end(JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 2300, candidatesTokenCount: 95, totalTokenCount: 2395 },
    }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🧪 خادم Gemini المحاكي على http://localhost:${PORT}`);
  console.log('   استهدفه من المشروع بـ:  GEMINI_BASE_URL=http://localhost:' + PORT);
});
