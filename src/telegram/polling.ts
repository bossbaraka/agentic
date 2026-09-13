import { config } from '../config.js';
import { log, sleep } from '../lib/utils.js';
import { parseTelegramUpdate } from './incoming.js';
import type { TelegramUpdate } from './types.js';
import type { AgentOrchestrator } from '../agent/agent.ts';

/**
 * خدمة Telegram Long Polling
 * تتيح استقبال رسائل تلغرام على الخادم المحلي بدون الحاجة إلى Webhook أو ngrok/tunnel!
 */
export class TelegramPoller {
  private active = false;
  private offset = 0;

  constructor(private orchestrator: InstanceType<typeof AgentOrchestrator>) {}

  start(): void {
    if (!config.telegram.BOT_TOKEN) {
      log.warn('⚠️ TELEGRAM_BOT_TOKEN غير مضبوط — لن يتم تشغيل Telegram Polling.');
      return;
    }

    if (this.active) return;
    this.active = true;

    // حذف أي webhook قديم لتأكيد عمل Long Polling
    fetch(`https://api.telegram.org/bot${config.telegram.BOT_TOKEN}/deleteWebhook`)
      .then(() => log.ok('🚀 تم تشغيل خدمة Telegram Long Polling بنجاح'))
      .catch((err) => log.warn(`تنبيه deleteWebhook: ${err.message}`));

    // حلقة الاستطلاع المستمر
    void this.pollLoop();
  }

  stop(): void {
    this.active = false;
  }

  private async pollLoop(): Promise<void> {
    const url = `https://api.telegram.org/bot${config.telegram.BOT_TOKEN}/getUpdates`;

    while (this.active) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.offset,
            timeout: 30, // 30 ثانية لكل طلب استطلاع
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          }),
        });

        if (!res.ok) {
          log.warn(`خطأ استطلاع تلغرام (${res.status}): ${res.statusText}`);
          await sleep(5000);
          continue;
        }

        const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.offset = Math.max(this.offset, update.update_id + 1);
            const normalized = parseTelegramUpdate(update);
            if (normalized) {
              void this.orchestrator.handleInbound(normalized);
            }
          }
        }
      } catch (err) {
        if (!this.active) break;
        log.error(`استثناء في Telegram Polling: ${(err as Error).message}`);
        await sleep(5000);
      }
    }
  }
}
