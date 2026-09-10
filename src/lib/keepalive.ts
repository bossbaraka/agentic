import { config } from '../config.js';
import { log } from './utils.js';

/**
 * آلية الحفاظ على استيقاظ الخادم (Keep-Alive):
 *
 * الخوادم المجانية على Render (Free Web Services) تدخل في وضع السبات (Spin Down)
 * تلقائيًا بعد 15 دقيقة من عدم تلقي أي طلب HTTP وارد (Inbound).
 *
 * المشاكل التي يسببها ذلك:
 * 1. استطلاع تيليجرام (Long Polling) يتوقف نهائيًا لأن الاستعلام صادر وليس واردًا،
 *    فيموت البوت ولا يستقبل أي رسالة حتى يزوره أحد عبر المتصفح.
 * 2. رسائل واتساب (Webhook) تتأخر 50+ ثانية أثناء الإقلاع البارد (Cold Start)،
 *    مما يؤدي لتجاوز مهلة Meta (Webhook Timeout) وفشل تسليم الرسائل.
 *
 * الحل:
 * إرسال فحص دوري خفيف (GET /health أو /ping) كل 10 دقائق إلى الرابط العام للخدمة
 * (Render يمرر هذا الرابط تلقائيًا في RENDER_EXTERNAL_URL).
 * وصول الطلب عبر مسار النطاق الخارجي يُسجَّل لدى Render كطلب وارد نشط،
 * مما يعيد تصفير عدّاد الـ 15 دقيقة ويبقي البوت متصلًا 24/7.
 */

let keepAliveTimer: NodeJS.Timeout | null = null;
let pingCount = 0;

export function startKeepAlive(): void {
  if (!config.server.KEEP_ALIVE_ENABLED) {
    log.info('⏸ خدمة Keep-Alive معطلة يدويًا (KEEP_ALIVE_ENABLED=false).');
    return;
  }

  const rawUrl = (config.server.KEEP_ALIVE_URL || config.server.RENDER_EXTERNAL_URL || '').trim();
  if (!rawUrl) {
    log.info(
      'ℹ️ خدمة Keep-Alive في وضع الاستعداد (لم يتم رصد RENDER_EXTERNAL_URL أو KEEP_ALIVE_URL). ' +
        'عند نشر الخدمة على Render ستعمل تلقائيًا لمنع السبات بعد 15 دقيقة.'
    );
    return;
  }

  const baseUrl = rawUrl.replace(/\/+$/, '');
  const pingUrl = `${baseUrl}/ping`;
  const intervalMinutes = Math.max(2, Math.min(14, config.server.KEEP_ALIVE_INTERVAL_MINUTES));
  const intervalMs = intervalMinutes * 60 * 1000;

  log.ok(`🔄 خدمة Keep-Alive نشطة: فحص دوري كل ${intervalMinutes} دقيقة على ${pingUrl} لمنع توقف Render`);

  const ping = async () => {
    pingCount++;
    try {
      const res = await fetch(pingUrl, {
        headers: {
          'User-Agent': 'MureehBot-RenderKeepAlive/1.0',
          'X-Keep-Alive-Ping': String(pingCount),
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        log.info(`💓 Keep-Alive (#${pingCount}) بنجاح (${res.status}) — خادم Render نشط ومستيقظ`);
      } else {
        log.warn(`⚠️ Keep-Alive (#${pingCount}) استجاب بكود غير متوقع: ${res.status}`);
      }
    } catch (err) {
      log.warn(`⚠️ فشل اتصال Keep-Alive (#${pingCount}): ${(err as Error).message}`);
    }
  };

  // نبدأ أول فحص بعد دقيقتين من الإقلاع للتأكد من جاهزية الشبكة
  const initialDelayMs = 2 * 60 * 1000;
  keepAliveTimer = setTimeout(() => {
    void ping();
    keepAliveTimer = setInterval(() => void ping(), intervalMs);
  }, initialDelayMs);
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}
