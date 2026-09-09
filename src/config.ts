import 'dotenv/config';

/** يحوّل قيمة نصية إلى رقم مع قيمة افتراضية آمنة */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on', 'نعم'].includes(raw.trim().toLowerCase());
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** قائمة مفصولة بفواصل */
function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export type BotMode = 'business' | 'assistant' | 'hybrid';

export const config = {
  env: {
    NODE_ENV: str('NODE_ENV', 'development'),
    DEMO_MODE: bool('DEMO_MODE', false),
  },

  server: {
    HOST: str('HOST', '0.0.0.0'),
    PORT: num('PORT', 3000),
    /** مسار الويب هوك — غيّره فقط إذا تعرف وش تسوي */
    WEBHOOK_PATH: str('WEBHOOK_PATH', '/webhook'),
    /** مسار لوحة التحكم */
    DASHBOARD_PATH: str('DASHBOARD_PATH', '/admin'),
    /** كلمة مرور لوحة التحكم (مطلوبة في الإنتاج) */
    DASHBOARD_PASSWORD: str('DASHBOARD_PASSWORD', ''),
  },

  gemini: {
    API_KEY: str('GEMINI_API_KEY', ''),
    BASE_URL: str('GEMINI_BASE_URL', ''),
    /** عنوان بديل للـ API (مفيد للاختبار مع خادم محاكٍ أو وسيط/Proxy) */
    MODEL: (() => {
      const m = str('GEMINI_MODEL', 'gemini-3.6-flash');
      return (m === 'gemini-2.5-flash' || m === 'gemini-2.5-flash') ? 'gemini-3.6-flash' : m;
    })(),
    /** نموذج أرخص/أسرع لمهام التلخيص */
    FAST_MODEL: (() => {
      const m = str('GEMINI_FAST_MODEL', 'gemini-3.5-flash-lite');
      return (m === 'gemini-2.5-flash-lite' || m === 'gemini-2.5-flash-lite') ? 'gemini-3.5-flash-lite' : m;
    })(),
    TEMPERATURE: num('GEMINI_TEMPERATURE', 0.8),
    MAX_OUTPUT_TOKENS: num('GEMINI_MAX_OUTPUT_TOKENS', 1024),
    /**
     * ميزانية "التفكير" للنموذج:
     *  0  = أسرع وأرخص (مناسب لردود واتساب)
     *  -1 = ديناميكي (النموذج يقرر)
     */
    THINKING_BUDGET: num('GEMINI_THINKING_BUDGET', 0),
    /** فرض مخرجات JSON. عطّله لو موديلك ما يدعمه */
    JSON_MODE: bool('GEMINI_JSON_MODE', true),
    TIMEOUT_MS: num('GEMINI_TIMEOUT_MS', 45_000),
    RETRIES: num('GEMINI_RETRIES', 2),
  },

  whatsapp: {
    /** false = الخدمة موقوفة مؤقتًا (لا webhook ولا إرسال) — أعد تشغيلها بـ true */
    ENABLED: bool('WHATSAPP_ENABLED', true),
    ACCESS_TOKEN: str('WHATSAPP_ACCESS_TOKEN', ''),
    PHONE_NUMBER_ID: str('WHATSAPP_PHONE_NUMBER_ID', ''),
    APP_SECRET: str('WHATSAPP_APP_SECRET', ''),
    VERIFY_TOKEN: str('WHATSAPP_VERIFY_TOKEN', ''),
    GRAPH_VERSION: str('GRAPH_API_VERSION', 'v23.0'),
    /** إظهار مؤشر "يكتب الآن..." */
    TYPING_INDICATOR: bool('TYPING_INDICATOR', true),
    /** إعادة فعل (إيموجي) على رسالة العميل فور وصولها */
    AUTO_REACTION: str('AUTO_REACTION', ''),
    /** رقم/معرّف الموظف البشري للتنبيه عند التحويل */
    HUMAN_AGENT_ID: str('HUMAN_AGENT_ID', ''),
  },

  /** تيليجرام — القناة البديلة/المكمّلة */
  telegram: {
    /** توكن البوت من @BotFather */
    TOKEN: str('TELEGRAM_BOT_TOKEN', ''),
    /** رابط عام نهائي (https) لو تريد وضع webhook بدل الاستطلاع الدوري */
    WEBHOOK_URL: str('TELEGRAM_WEBHOOK_URL', ''),
    /** سر تحقق إضافي في webhook (يوضع في ?secret_token=) */
    WEBHOOK_SECRET: str('TELEGRAM_WEBHOOK_SECRET', ''),
    /** معرف الدردشة الإدارية الذي يستقبل تنبيهات التحويل/الليدات (اختياري) */
    HUMAN_CHAT_ID: str('TELEGRAM_HUMAN_CHAT_ID', ''),
    TIMEOUT_MS: num('TELEGRAM_TIMEOUT_MS', 40_000),
    /** حد الرسالة الواحدة في تيليجرام 4096 — نترك هامش أمان */
    MAX_SEGMENT_CHARS: num('TELEGRAM_MAX_SEGMENT_CHARS', 3900),
  },

  bot: {
    MODE: str('BOT_MODE', 'hybrid') as BotMode,
    BOT_NAME: str('BOT_NAME', 'مساعد'),
    BUSINESS_NAME: str('BUSINESS_NAME', 'الشركة'),
    DEFAULT_LANGUAGE: str('DEFAULT_LANGUAGE', 'ar'),
    MAX_REPLY_PARTS: num('MAX_REPLY_PARTS', 3),
    /** حد الرسالة الواحدة في واتساب = 4096. نترك هامش أمان */
    MAX_SEGMENT_CHARS: num('MAX_SEGMENT_CHARS', 900),
    /** عدد رسائل المحادثة المرسلة للنموذج */
    HISTORY_TURNS: num('HISTORY_TURNS', 24),
    /** دقيقة خمول بعدها تُعتبر الجلسة جديدة */
    SESSION_TTL_MINUTES: num('SESSION_TTL_MINUTES', 45),
    /** حد رسائل العميل في الدقيقة قبل كبح الإساءة */
    RATE_LIMIT_PER_MIN: num('RATE_LIMIT_PER_MIN', 15),
    /** تفعيل استدعاء الدوال (حجز، حالة طلب، تذكرة) */
    TOOLS_ENABLED: bool('TOOLS_ENABLED', true),
    /** الرد على الرسائل التي يحوّلها العميل من محادثات أخرى */
    IGNORE_FORWARDED: bool('IGNORE_FORWARDED', false),
  },

  paths: {
    DATA_DIR: str('DATA_DIR', './data'),
    KNOWLEDGE_DIR: str('KNOWLEDGE_DIR', './knowledge'),
    MEDIA_DIR: str('MEDIA_DIR', './data/media'),
    SAVE_MEDIA: bool('SAVE_MEDIA', true),
    /** أقصى حجم وسائط يتم تنزيله وفهمه (بايت) */
    MAX_MEDIA_BYTES: num('MAX_MEDIA_BYTES', 8 * 1024 * 1024),
  },
} as const;

export type AppConfig = typeof config;

/**
 * فحص الإعدادات عند الإقلاع.
 * في وضع التجربة (DEMO_MODE) كل شيء اختياري.
 */
export function validateConfig(): { ok: boolean; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const demo = config.env.DEMO_MODE;

  if (!config.gemini.API_KEY) {
    const msg = 'GEMINI_API_KEY غير مضبوط — سيتم استخدام محرك ردود وهمي (Mock) للتجربة فقط.';
    demo ? warnings.push(msg) : errors.push(msg);
  }

  if (!config.whatsapp.ENABLED) {
    warnings.push('⏸ واتساب موقوف (WHATSAPP_ENABLED=false) — البوت يعمل عبر تيليجرام فقط.');
  } else {
    if (!config.whatsapp.ACCESS_TOKEN || !config.whatsapp.PHONE_NUMBER_ID) {
      const msg = 'WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID غير مضبوطة — لن يستطيع البوت الإرسال لواتساب الحقيقي.';
      demo ? warnings.push(msg) : errors.push(msg);
    }

    if (!config.whatsapp.VERIFY_TOKEN) {
      warnings.push('WHATSAPP_VERIFY_TOKEN غير مضبوط — Meta لن تتمكن من تأكيد رابط الويب هوك.');
    }

    if (!config.whatsapp.APP_SECRET) {
      warnings.push('WHATSAPP_APP_SECRET غير مضبوط — سيتم قبول أي طلب POST على الويب هوك (خطر أمني في الإنتاج).');
    }
  }

  if (!config.telegram.TOKEN && config.whatsapp.ENABLED && !demo) {
    warnings.push('لا توجد قناة مفعّلة (لا تيليجرام ولا مفتاح واتساب) — لن يصل البوت أحدًا.');
  }

  if (!demo && !config.server.DASHBOARD_PASSWORD) {
    warnings.push('DASHBOARD_PASSWORD فارغة — لوحة التحكم مكشوفة. اضبطها قبل النشر.');
  }

  if (config.bot.MODE !== 'business' && config.bot.MODE !== 'assistant' && config.bot.MODE !== 'hybrid') {
    warnings.push(`BOT_MODE="${config.bot.MODE}" غير معروف — تم اعتماده كـ hybrid.`);
  }

  return { ok: errors.length === 0, warnings, errors };
}
