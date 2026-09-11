# خريطة المعمارية وخريطة الأسباب الجذرية — وكيل مُريح

> وثيقة داخلية: نتيجة التدقيق الكامل للمستودع قبل أي تعديل (Phase 1–2).
> كل تعديل لاحق في الكود يسير وراء هذه الخريطة.

## 1) خريطة مسار التنفيذ الفعلي (كما هو في الكود)

```
WhatsApp / Telegram webhook  (src/server.ts)
  └→ AgentOrchestrator.handleInbound        (src/agent/agent.ts)
       1. منع التكرار (wamid) + تحديث اسم العميل + bridge.inbound (SQLite)
       2. تعليم كمقروء + تفاعل إيموجي
       3. أوامر التحكم (/بوت /بشري /مسح ...)
       4. حالة المحادثة (bot | human | paused)
       5. كبح المعدل (rateLimiter)
       6. تجميع الرسائل المتتابعة (debounce 0.9–1.4s)
       └→ respondToBatch
            a. autoExtractFacts (regex) → store.patchProfile
            b. rotateIfStale + maybeSummarize (تلخيص بالنموذج السريع)
            c. تنزيل الوسائط
            d. buildSystemPrompt (مونوليث: شخصية+قواعد+بيع+أدوات+قاعدة معرفة+عقد إخراج)
            e. extraContext (حراس متابعة، دليل بيعي regex: salesHint)
            f. generateReply (src/agent/llm.ts)
                 PROVIDER=openai → OpenAI (حلقة function calling ≤4)
                 وإلا Gemini (سلسلة موديلات + مفاتيح متعددة + retry)
                 فشل كلي → mockReply (محرك قواعد محلي) بوسم degraded=true
            g. removeRepeatedMemoryQuestions (حارس regex للأسئلة المحفوظة)
            h. coherentQuickReplies (اتساق الأزرار مع النص)
            i. إرسال بأجزاء مع تأخير كتابة بشري
            j. إجراءات جانبية (handoff / notify_manager / notify_human)
            k. كشف اللغة + مزامنة bridge (SQLite)
```

**الأدوات:** 20 تعريفًا (`TOOL_DECLARATIONS`) تنفَّذ عبر `toolRegistry.executeTool`:
تحقق وسائط صارم + تدقيق (audit) + رفض الأدوات غير المعلنة. الخدمات (bookingService,
orderService, ticketService, handoffService, catalogService) هي طبقة الأعمال والملكية
تُفرض بـ contactKey — أي النموذج لا يتحكم بالتصريح.

**الذاكرة:** `store` (JSON ذرّي على القرص) لكل جلسة: profile, launch, summary, messages,
stats — يُدمج اختياريًا في SQLite (users/customers/conversations/messages) عبر bridge.
`SESSION_TTL=45 دقيقة` لكن `rotateIfStale` لا يحذف شيئًا (السجل كامل محفوظ).

**الحقيقة المزدوجة للأسعار:** plans.ts (كود) + knowledge/business-info.md (نص محقون في
الـ prompt) — متطابقتان حاليًا لكن المصدرين منفصلان يدويًا. الأدوات تقرأ من plans.ts ✅.

## 2) الأسباب الجذرية لسلوك «البوت الغبي» (بالأولوية)

| # | السبب | الدليل في الكود | الأثر على العميل |
|---|-------|----------------|------------------|
| R1 | **سقوط صامت إلى المحرك الوهمي** | `generateReply` → أي فشل LLM → `mockReply` (450 سطر قواعد جافة). في الإنتاج بمفتاح فاشل/منتهي يصبح البوت فجأة سكربتًا غبيًا يكرر «كم طاولة عندك؟» | أسوأ سلوك يظهر بالضبط عندما لا ينتبه صاحب البوت |
| R2 | **سلسلة موديلات تخمينية** | `GEMINI_MODEL_FALLBACKS` الافتراضي: `gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3-flash-preview` — أسماء غير مؤكدة؛ كل واحد قد يحرق 45 ثانية مهلة قبل البديل التالي | تأخيرات دقائق ثم سقوط للمحرك الوهمي (R1) |
| R3 | **لا طبقة نيّة/مرحلة بيعية حتمية** | النية تأتي من نص حر في JSON النموذج، ولا تُحفظ ولا تُستخدم للقرار. لا توجد `salesStage` ولا `leadScore` ولا `objections` — كل «ذكاء بيعي» تلميحات regex (`salesHint`) تُحقن كنص | القفز للبيع («هل تريد الاشتراك؟») في أي لحظة، وفقدان السياق بين الجلسات |
| R4 | **برومبت مونوليث متضارب** | systemPrompt.ts واحد ~40KB: قواعد الذاكرة مكررة 4 مرات، «اختم دائمًا بخطوة تالية» + «الإغلاق بسؤالين بالتناوب» + «لا CTA في كل رسالة» معًا | إلحاح بيعي متكرر، «ممتاز/يا سلام» في كل رد، أسئلة بعد الأجوبة |
| R5 | **الأدوات تُرجع نصًا تسويقيًا جاهزًا** | `get_plan_details`/`recommend_plan`/`get_menu` تُلحق «تبيني أجهّز لك التفعيل؟» داخل `userMessage` من الأداة نفسها | النموذج يُمرّر CTA الأداة حرفيًا → تكرار الإلحاح حتى في رسائل الدعم |
| R6 | **لا تحقق استجابة** | يوجد تحقق أزرار وأسئلة محفوظة، لكن لا حارس لـ: CTA مبكر، أرقام أسعار مهلوسة، تكرار عبارات عبر الرسائل | أسعار مخترعة تمر، إلحاح متكرر يمر |
| R7 | **ذاكرة بيعية غير موجودة** | profile يحفظ (اسم/مطعم/مدينة/طاولات/باقة) فقط. لا تُحفظ: المرحلة، الألم، الاعتراض، آخر عرض، نية الشراء، نقاط الجودة | «أنا رجعت بدي أكمل» يُعامل كعميل جديد |
| R8 | **لا مقاييس جودة AI** | لا يُقاس: نسبة السقوط للاحتياطي، نجاح الأدوات، تطابق النية، انتهاكات الأسعار | لا طريقة لمعرفة أن البوت يتدهور |
| R9 | **أخطاء typecheck قديمة** | `src/db/client.ts` يمرر `unknown[]` إلى node:sqlite | `npm run build` فاشل أصلًا قبل أي تعديل |
| R10 | **لا جناح تقييم محادثات** | لا يوجد أي اختبار سلوك محادثة (فقط أدوات/حجوزات/RBAC/راوتر) | أي تعديل برومبت = مقامرة عمياء |

## 3) المعمارية المستهدفة (مُنفَّذة في هذا الفرع)

```
USER MESSAGE
 → normalization/debounce (موجود)
 → DETERMINISTIC ANALYSIS  (src/agent/intelligence/)
     intent.ts         نيّة + كيانات + ثقة (عربي/إنجليزي/عبري، unknown عند الانخفاض)
     painPoints.ts     ألم → حل → سؤال تأهيل (داخلي، لا يُعرض استدلاله)
     objections.ts     اعتراض (سعر/قيمة/ثقة/تعقيد/تأجيل) + حالته
     salesStage.ts     آلة حالات البيع (DISCOVERY→…→CONVERSION/ONBOARDING/SUPPORT)
     leadScore.ts      نقاط شفافة حتمية 0–100 (cold/warm/qualified/hot)
     customerState.ts  حالة عميل دائمة تُحفظ في الجلسة + SQLite
 → CONTEXT ASSEMBLY (src/agent/prompts/)
     corePolicy + conversationPolicy + salesPolicy(+سياق المرحلة) + safetyPolicy
     + toolPolicy + brandVoice + CURRENT_CONTEXT (ذاكرة العميل + المرحلة + الألم
     + الاعتراض + النية الحتمية) + قاعدة المعرفة + عقد الإخراج
 → LLM REASONING + TOOL LOOP (موجود، مع سلسلة موديلات نظيفة)
 → TOOL EXECUTION (موجود: registry + validation + audit) — مخرجات بنيوية بلا نثريات
 → RESPONSE POLICY (src/agent/responsePolicy.ts)
     حارس CTA (لا إلحاح متكرر/مبكر) + حارس أسعار (كل رقم ₪ من plans.ts أو حساب مشتق)
     + حارس تسرب الاستدلال الداخلي
 → MEMORY UPDATE (customerState + profile + summary + metrics)
 → FINAL RESPONSE
```

قواعد عدم الاختراق: كل التغييرات إضافية — نفس متغيرات البيئة، نفس عقود الأدوات
والأسماء، نفس عقد JSON للإخراج، نفس واجهات Services وقاعدة البيانات (هجرة إضافية فقط
أعمدة جديدة).
