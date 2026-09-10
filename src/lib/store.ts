import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { ConversationState, LaunchState, RestaurantProfile, Session, StoredMessage } from '../types.js';
import { log, uid } from './utils.js';

/**
 * مخزن الجلسات.
 *
 * التصميم: ملفات JSON على القرص + كاش في الذاكرة، مع كتابة ذرّية (atomic)
 * عبر ملف مؤقت ثم إعادة تسمية. هذا يكفي تمامًا لمئات/آلاف المحادثات،
 * وصفر اعتماديات native. الواجهة (Store) مجرّدة بحيث يمكن استبدالها
 * بـ Postgres أو Redis لاحقًا دون لمس بقية الكود.
 */

const SESSIONS_FILE = () => path.join(config.paths.DATA_DIR, 'sessions.json');
const STATS_FILE = () => path.join(config.paths.DATA_DIR, 'stats.json');

interface PersistedStats {
  inbound: number;
  outbound: number;
  handoffs: number;
  errors: number;
  promptTokens: number;
  candidatesTokens: number;
  latencySumMs: number;
  latencyCount: number;
}

function emptySession(key: string, name: string): Session {
  const now = Date.now();
  return {
    key,
    name: name || key,
    state: 'bot',
    language: config.bot.DEFAULT_LANGUAGE,
    summary: '',
    createdAt: now,
    updatedAt: now,
    lastInboundAt: 0,
    lastOutboundAt: 0,
    messages: [],
    stats: {
      inbound: 0,
      outbound: 0,
      handoffs: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      calls: 0,
      errors: 0,
    },
  };
}

export class Store {
  private sessions = new Map<string, Session>();
  private stats: PersistedStats = {
    inbound: 0, outbound: 0, handoffs: 0, errors: 0,
    promptTokens: 0, candidatesTokens: 0, latencySumMs: 0, latencyCount: 0,
  };
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private loadPromise: Promise<void> | null = null;

  /** تحميل من القرص (مرة واحدة) */
  async init(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      fs.mkdirSync(config.paths.DATA_DIR, { recursive: true });
      if (config.paths.SAVE_MEDIA) fs.mkdirSync(config.paths.MEDIA_DIR, { recursive: true });

      try {
        if (fs.existsSync(SESSIONS_FILE())) {
          const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8')) as Session[];
          for (const s of raw) this.sessions.set(s.key, s);
          log.info(`تم تحميل ${raw.length} محادثة من القرص`);
        }
      } catch (err) {
        log.warn(`تعذّر قراءة ملف الجلسات — بدء نظيف. (${(err as Error).message})`);
      }

      try {
        if (fs.existsSync(STATS_FILE())) {
          this.stats = { ...this.stats, ...JSON.parse(fs.readFileSync(STATS_FILE(), 'utf8')) };
        }
      } catch { /* نتجاهل */ }

      // حفظ دوري كل 5 ثوانٍ لو تغيّر شيء
      this.flushTimer = setInterval(() => this.flushSync(), 5000);
      this.flushTimer.unref?.();
    })();
    return this.loadPromise;
  }

  get(key: string): Session {
    let s = this.sessions.get(key);
    if (!s) {
      s = emptySession(key, key);
      this.sessions.set(key, s);
      this.dirty = true;
    }
    return s;
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /**
   * هل انتهت صلاحية الجلسة (خمول طويل)؟
   * لو نعم → نلخّص المحادثة ونبدأ صفحة جديدة مع الاحتفاظ بالملخص.
   */
  isStale(session: Session): boolean {
    const last = Math.max(session.lastInboundAt, session.lastOutboundAt, session.updatedAt);
    return Date.now() - last > config.bot.SESSION_TTL_MINUTES * 60_000;
  }

  /** تدوير الجلسة بعد الخمول: نفرّغ السجل ونحتفظ بالملخص */
  rotateIfStale(session: Session): boolean {
    if (!this.isStale(session)) return false;
    const kept = session.messages.slice(-2);
    session.messages = kept;
    session.updatedAt = Date.now();
    this.dirty = true;
    return true;
  }

  setName(key: string, name: string): void {
    const s = this.get(key);
    if (name && name !== s.name) {
      s.name = name;
      this.dirty = true;
    }
  }

  setState(key: string, state: ConversationState, note?: string): void {
    const s = this.get(key);
    s.state = state;
    s.updatedAt = Date.now();
    if (note) {
      s.messages.push({
        id: uid('sys'), dir: 'system', type: 'text', body: note, createdAt: Date.now(),
      });
    }
    this.dirty = true;
  }

  setSummary(key: string, summary: string): void {
    const s = this.get(key);
    s.summary = summary;
    this.dirty = true;
  }

  setLanguage(key: string, lang: string): void {
    const s = this.get(key);
    if (lang && lang !== s.language) {
      s.language = lang;
      this.dirty = true;
    }
  }

  /** دمج حقول جديدة في ملف المطعم (مسار التجهيز للإطلاق) */
  patchProfile(key: string, patch: Partial<RestaurantProfile>): RestaurantProfile {
    const s = this.get(key);
    s.profile = { ...(s.profile ?? {}), ...patch, updatedAt: Date.now() };
    s.updatedAt = Date.now();
    this.dirty = true;
    return s.profile;
  }

  /** تحديث حالة طلب الإطلاق */
  patchLaunch(key: string, patch: Partial<LaunchState>): LaunchState {
    const s = this.get(key);
    s.launch = { status: 'collecting', ...(s.launch ?? {}), ...patch, updatedAt: Date.now() };
    s.updatedAt = Date.now();
    this.dirty = true;
    return s.launch;
  }

  /** إضافة رسالة واردة */
  addInbound(key: string, msg: StoredMessage): Session {
    const s = this.get(key);
    s.messages.push(msg);
    s.lastInboundAt = msg.createdAt;
    s.updatedAt = Date.now();
    s.stats.inbound++;
    this.stats.inbound++;
    this.trim(s);
    this.dirty = true;
    return s;
  }

  /** إضافة رسالة صادرة */
  addOutbound(key: string, msg: StoredMessage): Session {
    const s = this.get(key);
    s.messages.push(msg);
    s.lastOutboundAt = msg.createdAt;
    s.updatedAt = Date.now();
    s.stats.outbound++;
    this.stats.outbound++;
    this.trim(s);
    this.dirty = true;
    return s;
  }

  addSystem(key: string, body: string): void {
    const s = this.get(key);
    s.messages.push({ id: uid('sys'), dir: 'system', type: 'text', body, createdAt: Date.now() });
    s.updatedAt = Date.now();
    this.trim(s);
    this.dirty = true;
  }

  /** قصّ السجل المخزّن حتى لا يكبر الملف للأبد */
  private trim(session: Session): void {
    const cap = Math.max(config.bot.HISTORY_TURNS * 4, 60);
    if (session.messages.length > cap) {
      session.messages = session.messages.slice(-cap);
    }
  }

  recordHandoff(key: string): void {
    this.get(key).stats.handoffs++;
    this.stats.handoffs++;
    this.dirty = true;
  }

  recordUsage(key: string, u: { promptTokens: number; candidatesTokens: number; latencyMs: number; error?: boolean }): void {
    const s = this.get(key);
    s.stats.calls++;
    s.stats.promptTokens += u.promptTokens;
    s.stats.candidatesTokens += u.candidatesTokens;
    this.stats.promptTokens += u.promptTokens;
    this.stats.candidatesTokens += u.candidatesTokens;
    this.stats.latencySumMs += u.latencyMs;
    this.stats.latencyCount++;
    if (u.error) {
      s.stats.errors++;
      this.stats.errors++;
    }
    this.dirty = true;
  }

  /** آخر الرسائل غير الفارغة لبناء سياق النموذج */
  history(key: string, turns = config.bot.HISTORY_TURNS): StoredMessage[] {
    const s = this.get(key);
    return s.messages
      .filter((m) => m.dir !== 'system' && m.body && m.body.trim().length > 0)
      .slice(-turns);
  }

  all(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(key: string): boolean {
    const ok = this.sessions.delete(key);
    if (ok) this.dirty = true;
    return ok;
  }

  resetAll(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    this.dirty = true;
    return n;
  }

  snapshot() {
    const all = this.all();
    return {
      sessions: all.length,
      activeBot: all.filter((s) => s.state === 'bot').length,
      activeHuman: all.filter((s) => s.state === 'human').length,
      inbound: this.stats.inbound,
      outbound: this.stats.outbound,
      handoffs: this.stats.handoffs,
      errors: this.stats.errors,
      promptTokens: this.stats.promptTokens,
      candidatesTokens: this.stats.candidatesTokens,
      avgLatencyMs: this.stats.latencyCount ? Math.round(this.stats.latencySumMs / this.stats.latencyCount) : 0,
      demoMode: config.env.DEMO_MODE,
      model: config.gemini.API_KEY ? config.gemini.MODEL : 'mock-engine',
    };
  }

  /** حفظ ذرّي: ملف مؤقت ثم rename */
  flushSync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const data = this.all();
      const tmp = SESSIONS_FILE() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 0), 'utf8');
      fs.renameSync(tmp, SESSIONS_FILE());

      const tmp2 = STATS_FILE() + '.tmp';
      fs.writeFileSync(tmp2, JSON.stringify(this.stats, null, 2), 'utf8');
      fs.renameSync(tmp2, STATS_FILE());
    } catch (err) {
      log.error(`فشل حفظ الجلسات: ${(err as Error).message}`);
    }
  }

  async flush(): Promise<void> {
    this.dirty = true;
    this.flushSync();
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushSync();
  }
}

export const store = new Store();
