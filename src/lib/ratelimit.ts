import { config } from '../config.js';

/**
 * كبح معدل بسيط في الذاكرة (نافذة منزلقة).
 * الغرض: حماية من الرسائل المتتالية السريعة ومن حلقات لا نهائية،
 * وحماية رصيد Gemini من الاستنزاف.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private windowMs = 60_000;

  constructor(private maxPerWindow = config.bot.RATE_LIMIT_PER_MIN) {}

  /** يرجع true لو مسموح، false لو تجاوز الحد */
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (arr.length >= this.maxPerWindow) {
      this.hits.set(key, arr);
      return false;
    }

    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** عدد الطلبات المتبقية في النافذة الحالية */
  remaining(key: string): number {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    return Math.max(0, this.maxPerWindow - arr.length);
  }

  /** تنظيف دوري للذاكرة */
  sweep(): void {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}

/**
 * طابور تسلسلي لكل عميل:
 * رسائل العميل الواحد تُعالَج بالترتيب (لا تداخل)،
 * بينما العملاء المختلفون يُعالَجون بالتوازي.
 */
export class PerKeyQueue {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    // نخزّن نسخة لا ترمي خطأ حتى لا ينكسر الطابور
    this.queues.set(key, next.catch(() => undefined));
    // ننظّف مدخل الطابور بعد انتهائه حتى لا تتسرب الذاكرة
    const tracked = this.queues.get(key);
    tracked?.then(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    }).catch(() => undefined);

    return next;
  }

  size(): number {
    return this.queues.size;
  }
}

export const rateLimiter = new RateLimiter();
export const queue = new PerKeyQueue();
