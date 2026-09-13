# ✈️ دليل ربط وتشغيل بوت تلغرام (Telegram Bot API)

هذا الدليل يشرح كيفية إضافة وتفعيل بوت **Telegram** في المشروع إلى جانب واتساب خلال أقل من **دقيقتين**.

---

## الخطوة ١: الحصول على توكن البوت من `@BotFather`

1. افتح تطبيق **Telegram** وابحث عن **[@BotFather](https://t.me/BotFather)**.
2. أرسل الأمر: `/newbot`.
3. أدخل اسم البوت (مثال: `مساعد متجر النخبة`).
4. أدخل معرف البوت (يجب أن ينتهي بـ `bot` أو `_bot`، مثال: `EliteStore_bot`).
5. سيعطيك BotFather توكناً بالشكل التالي:
   ```text
   7123456789:AAFxxx_example_token_abcdef123456
   ```

---

## الخطوة ٢: التشغيل المحلي التجريبي (Long Polling) - بدون Webhook!

مميزات هذه الطريقة:
* **لا تحتاج ngrok أو cloudflared أو نفق**.
* تعمل مباشرة من جهازك المحلي.

في ملف `.env`:
```env
TELEGRAM_BOT_TOKEN=7123456789:AAFxxx_example_token_abcdef123456
TELEGRAM_MODE=polling
```

ثم اطلب تشغيل المشروع:
```bash
npm run start
```

ستشاهد في الطرفية:
```text
🚀 تم تشغيل خدمة Telegram Long Polling بنجاح
```

الآن افتح بوتك في تلغرام وأرسل له رسالة! سيرد البوت فوراً وستظهر المحادثة في لوحة التحكم **http://localhost:3000/admin** مع أيقونة **✈️ تلغرام**.

---

## الخطوة ٣: تشغيل الإنتاج (Webhook Mode)

إذا قمت بنشر البوت على سيرفر بموديل HTTPS (مثل Render أو Railway أو VPS):

1. في ملف `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=7123456789:AAFxxx_example_token_abcdef123456
   TELEGRAM_MODE=webhook
   TELEGRAM_SECRET_TOKEN=كلمة-سر-اختيارية-للأمان
   ```

2. قم بتسجيل الـ Webhook في تلغرام بإرسال الطلب التالي في المتصفح أو Curl:
   ```text
   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-domain.com/telegram/webhook&secret_token=كلمة-سر-اختيارية-للأمان
   ```

---

## الميزات المدعومة في تلغرام:
* 💬 **المحادثات النصية** وفهم الأوامر (`/بوت`, `/بشري`, `/مساعدة`).
* 📸 **استقبال الصور** وتحليلها بواسطة Gemini.
* 🎙️ **الرسائل الصوتية والمستندات**.
* 🙋 **التحويل لموظف بشري والرد اليدوي** من لوحة التحكم.
* ⚡ **مؤشر "يكتب الآن..."** أثناء تفكير النموذج.
