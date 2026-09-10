# 📱 دليل الربط الكامل بـ WhatsApp Cloud API

هذا الدليل يأخذك من الصفر إلى بوت يردّ على رقم حقيقي.
الوقت المتوقع: **٢٠–٣٠ دقيقة**.

---

## المرحلة ١: حساب Meta وتطبيق

### 1. أنشئ تطبيقًا

1. اذهب إلى **https://developers.facebook.com/apps**
2. سجّل الدخول بحساب فيسبوك (يُفضّل حساب مرتبط بصفحة نشاطك)
3. اضغط **Create App** → اختر نوع **Business**
4. املأ الاسم (مثال: `بوت متجر النخبة`) واربطه بحساب Business Manager إن وُجد

### 2. أضف منتج WhatsApp

1. داخل لوحة التطبيق → **Add Product**
2. ابحث عن **WhatsApp** → اضغط **Set up**
3. ستُنقل تلقائيًا إلى **WhatsApp → API Setup**

### 3. انسخ ثلاثة أشياء من صفحة API Setup

في صفحة **API Setup** ستجد:

| ما تنسخه | أين تجده | ضعه في `.env` كـ |
|---|---|---|
| **Temporary access token** | أعلى الصفحة (يبدأ بـ `EAA...`) | `WHATSAPP_ACCESS_TOKEN` |
| **Phone number ID** | جدول الأرقام، عمود ID | `WHATSAPP_PHONE_NUMBER_ID` |
| **رقم واتساب** | `+1 (555) 000-0000` — رقم تجريبي تعطيه Meta | *(للاختبار فقط)* |

> ⚠️ **التوكن المؤقت ينتهي خلال ٢٤ ساعة!** للإنتاج تحتاج توكن دائم — انظر المرحلة ٥.

### 4. انسخ App Secret

1. **App settings → Basic**
2. حقل **App Secret** → اضغط **Show** → أدخل كلمة سر فيسبوك
3. انسخه إلى `WHATSAPP_APP_SECRET`

> 🔒 هذا السر يُستخدم للتحقق من توقيع كل webhook. بدونه يستطيع أي شخص إرسال طلبات مزيفة لبوتك.

---

## المرحلة ٢: أضف رقمك أنت للاختبار

الرقم التجريبي من Meta يسمح بإرسال الرسائل لعدد محدود من الأرقام الموثّقة.

1. في **API Setup** → قسم **To** → اضغط **Manage phone number list**
2. أضف رقم واتساب **الشخصي الذي ستختبر منه** (بالصيغة الدولية بدون `+`، مثال: `972501234567`)
3. سيصلك رمز تحقق على واتساب — أدخله
4. كرّر لحتى ٥ أرقام

الآن تستطيع إرسال رسالة **من** رقمك **إلى** الرقم التجريبي، وسيردّ بوتك.

---

## المرحلة ٣: شغّل الخادم وافتح نفقًا

Meta يجب أن تصل خادمك عبر الإنترنت بـ HTTPS. محليًا نستخدم نفقًا:

### الطرفية ١ — الخادم

```bash
cd whatsapp-ai-agent
cp .env.example .env      # ثم عدّل القيم التي نسختها أعلاه
# في .env اضبط: DEMO_MODE=false
npm install
npm run start
```

تأكد من سطر: `🚀 حقيقي` و `✨ Gemini (...)` في مخرجات الإقلاع.

### الطرفية ٢ — النفق

```bash
npm run tunnel
```

انتظر حتى يظهر سطر مثل:

```
Your quick Tunnel has been created! Visit it at:
https://random-words-1234.trycloudflare.com
```

**انسخ هذا الرابط** — سيتغيّر في كل مرة تشغّل النفق.

> البدائل: `ngrok http 3000` — أو للإنتاج انشر على Railway/Render/VPS برابط دائم.

### اختبار سريع قبل Meta

```bash
curl https://random-words-1234.trycloudflare.com/health
```

يجب أن يرجع JSON فيه `"ok":true`.

---

## المرحلة ٤: سجّل الـ Webhook في Meta

1. **WhatsApp → Configuration** (في لوحة تطبيقك)
2. قسم **Webhook** → اضغط **Edit**
3. املأ:

| الحقل | القيمة |
|---|---|
| **Callback URL** | `https://random-words-1234.trycloudflare.com/webhook` |
| **Verify token** | نفس قيمة `WHATSAPP_VERIFY_TOKEN` في `.env` تمامًا |

4. اضغط **Verify and Save**

> ✅ في طرفية الخادم يجب أن ترى: `✔ تم التحقق من الويب هوك بنجاح`
>
> ❌ لو فشل: تحقق أن الخادم يعمل، والنفق مفتوح، والرابط يبدأ بـ `https`،
> والـ token مطابق حرفيًا (بلا مسافات زائدة).

5. الآن **اشترك في الحقول**: في قسم **Webhook fields** اضغط **Subscribe** بجانب:
   - **messages** ← إلزامي (الرسائل الواردة)
   - **message_template_status_update** ← اختياري (حالة القوالب)

---

## المرحلة ٥: اختبر!

من واتساب على هاتفك، أرسل للرقم التجريبي:

```
السلام عليكم، بكم التوصيل؟
```

يجب أن ترى في طرفية الخادم:

```
🟢 واتساب ← اسمك (9725xxxxx): [text] السلام عليكم، بكم التوصيل؟
🤖 ذكاء ✨ [9725xxxxx] 1.8s · 2341↑/87↓ · نية: استفسار_شحن · 1 جزء
🟢 واتساب → 9725xxxxx | نص ✅
```

وافتح **http://localhost:3000/admin** لترى المحادثة حية.

### أشياء تستحق التجربة

| جرّب | ماذا يجب أن يحدث |
|---|---|
| أرسل صورة | يفهمها Gemini ويعلق عليها |
| أرسل رسالة صوتية | يحوّلها لنص ويفهمها ويردّ |
| أرسل ٣ رسائل بسرعة | يردّ **مرة واحدة** على الكل |
| اكتب `/بشري` | يصمت البوت وتنتقل للوحة التحكم |
| اكتب `/مساعدة` | قائمة الأوامر |
| افتح اللوحة وردّ يدويًا | يظهر للعميل وكأنه موظف حقيقي |
| اكتب شكوى غاضبة | تحويل تلقائي لبشري + تنبيه `HUMAN_AGENT_ID` |

---

## المرحلة ٦: توكن دائم (للإنتاج)

التوكن المؤقت ينتهي خلال ٢٤ ساعة. للإنتاج:

### الطريقة أ: System User Token (موصى بها)

1. **https://business.facebook.com/settings** → **Users → System Users**
2. **Add** → أنشئ مستخدم نظام بدور **Admin**
3. **Add Assets** → امنحه تطبيقك و WhatsApp Business Account
4. **Generate Token** → اختر التطبيق → فعّل الصلاحيات:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. انسخ التوكن (يظهر **مرة واحدة فقط**) إلى `WHATSAPP_ACCESS_TOKEN`

### الطريقة ب: ربط رقم نشاطك الحقيقي

1. **WhatsApp → API Setup → Add phone number**
2. اختر: رقم نشاطك، اسم العرض، طريقة التحقق (مكالمة/SMS)
3. ⚠️ **الرقم سيفصل من تطبيق واتساب العادي** ويصبح API فقط
4. استخدم `PHONE_NUMBER_ID` الجديد

### رفع حدّ الإرسال

الحساب الجديد محدود بـ **٢٥٠ محادثة/٢٤ ساعة**. يرفع تلقائيًا إلى ١٠٠٠ ثم أكثر
مع جودة إرسال جيدة (عدم وجود بلاغات من المستخدمين).

---

## المرحلة ٧: خصّص البوت لنشاطك

### 1) معلومات النشاط — الأهم

افتح `knowledge/business-info.md` واستبدل كل البيانات الوهمية:
الاسم، الهاتف، العنوان، ساعات العمل، الأسعار، سياسة الإرجاع.

> 💡 **كل معلومة لا تكتبها هنا = معلومة لا يعرفها البوت** → سيحوّل لبشري.
> هذا مقصود: أفضل من أن يخترع إجابة.

### 2) الشخصية والنبرة

`knowledge/tone-and-replies.md` — عدّل الأمثلة لتطابق أسلوب علامتك.
و`BOT_NAME` / `BUSINESS_NAME` في `.env`.

### 3) الوضع

```env
BOT_MODE=business    # خدمة عملاء صارمة
BOT_MODE=assistant   # مساعد شخصي عام
BOT_MODE=hybrid      # الاثنين معًا (الافتراضي)
```

### 4) اربط الأدوات بأنظمتك

`src/agent/tools.ts` — استبدل البيانات التجريبية بنداءات حقيقية
لقاعدة بياناتك / CRM / التقويم.

> 🗓️ **نظام الحجوزات جاهز للاستخدام فورًا** (يخزّن في `data/bookings.json`):
> اضبط ساعات عمل فريق الحجز في `.env` عبر `BOOKING_*` (الأيام، الفتح/الإغلاق، مدة
> الموعد، الحد الأقصى لكل موعد، مدى الحجز، المنطقة الزمنية). لتكامل أعمق
> (تقويم Google/Outlook)، استبدل `bookingStore` في `src/agent/bookings.ts` بنداء
> للتقويم — التوقيعات ثابتة.
> فحص سريع: `npx tsx scripts/booking-smoke.ts`

### 5) حدّث قاعدة المعرفة بدون إيقاف

زر 📚 في اللوحة، أو:
```bash
curl -X POST http://localhost:3000/api/knowledge/reload
```

---

## 🌍 النشر على الإنتاج

### الخيار ١: Docker على VPS

```bash
docker compose up -d
```
مع nginx/caddy أمامه لشهادة HTTPS (أو Cloudflare Tunnel باسم نطاق ثابت).

### الخيار ٢: منصّة جاهزة

| المنصّة | ملاحظات |
|---|---|
| **Railway** | الأسهل — اربط المستودع واضبط متغيرات البيئة |
| **Render** | خطة مجانية كافية للتجربة |
| **Fly.io** | أداء جيد وقريب جغرافيًا |
| **VPS** (Hetzner/DO) | أرخص على المدى الطويل، تحكم كامل |

في كل الحالات:
- أمر البناء: `npm install`
- أمر التشغيل: `npm run start`
- **أهم نقطة**: اجعل مجلد `data/` على قرص دائم (volume) وإلا فقدت المحادثات عند كل نشر
- اضبط `DASHBOARD_PASSWORD` و`NODE_ENV=production`

### قائمة أمان ما قبل الإطلاق

- [ ] `WHATSAPP_APP_SECRET` مضبوط (يرفض الطلبات المزيفة)
- [ ] `DASHBOARD_PASSWORD` قوية (وإلا لوحتك مكشوفة للعالم)
- [ ] `DEMO_MODE=false` و `INTERNAL_TEST_HOOK` غير مفعّل
- [ ] رابط HTTPS دائم بدل النفق المؤقت
- [ ] نسخ احتياطي لمجلد `data/`
- [ ] مراجعة [سياسة أعمال WhatsApp](https://www.whatsapp.com/legal/business-policy) — فئات المحتوى الممنوع
- [ ] أضف آلية إعادة تشغيل تلقائية (systemd / pm2 / سياسة المنصّة)

---

## 🩺 مشاكل شائعة

**Meta تقول "The URL specified is invalid"**
→ الخادم لا يعمل، أو النفق مقطوع، أو `WHATSAPP_VERIFY_TOKEN` غير مطابق، أو الرابط ليس HTTPS.

**الرسائل تصل للوحة لكن البوت لا يرد**
→ المحادثة في حالة `human` (اضغط 🤖 بوت)، أو `RATE_LIMIT_PER_MIN` مستنفد، أو مفتاح Gemini خاطئ (انظر السجلات).

**`(#131030) Recipient phone number not in allowed list`**
→ أضف رقم العميل في **API Setup → Manage phone number list** (قيود الرقم التجريبي).

**`(#131026) Message undeliverable`**
→ مرّت أكثر من ٢٤ ساعة على آخر رسالة من العميل. تحتاج إرسال **قالب معتمد** أولًا (استخدم `sendTemplate` في `src/whatsapp/outgoing.ts`).

**`(#368) Temporary block`**
→ التوكن منتهي أو الرقم محظور مؤقتًا بسبب بلاغات. راجع جودة رسائلك.

**الردود بطيئة (أكثر من ٥ ثوانٍ)**
→ `GEMINI_THINKING_BUDGET=0`، استخدم موديل `flash` أو `flash-lite`، وقلّل `HISTORY_TURNS`.

**الوسائط لا تُحلَّل**
→ تحقّق من `MAX_MEDIA_BYTES`، وأن التوكن يملك صلاحية `whatsapp_business_messaging`.

---

## 📞 نقاط مرجعية رسمية

- WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api
- مرجع الرسائل: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- Webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- Gemini API: https://ai.google.dev/gemini-api/docs
- سياسات أعمال WhatsApp: https://www.whatsapp.com/legal/business-policy
