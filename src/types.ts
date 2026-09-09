/** ===== الأنواع المشتركة في المشروع ===== */

/** وضع تشغيل المحادثة: بوت تلقائي، أو موظف بشري، أو إيقاف مؤقت */
export type ConversationState = 'bot' | 'human' | 'paused';

/** اتجاه الرسالة */
export type Direction = 'in' | 'out' | 'system';

/** نوع رسالة واتساب الواردة */
export type WaMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'button'
  | 'interactive'
  | 'reaction'
  | 'order'
  | 'unsupported'
  | 'unknown';

/** جزء وسائط يُمرَّر للنموذج */
export interface MediaPart {
  kind: 'image' | 'audio' | 'video' | 'document';
  mimeType: string;
  /** base64 بدون بادئة data: */
  data: string;
  bytes: number;
  /** وصف بديل لو فشل التنزيل */
  note?: string;
}

/** رسالة مخزّنة في السجل */
export interface StoredMessage {
  id: string;
  /** wamid الوارد من واتساب (مفتاح منع التكرار) */
  waId?: string;
  dir: Direction;
  type: WaMessageType;
  /** النص الفعلي أو وصف الوسائط */
  body: string;
  /** نص الوسائط (Caption) */
  caption?: string;
  createdAt: number;
  media?: {
    kind: MediaPart['kind'];
    mimeType: string;
    path?: string;
    bytes: number;
  };
  /** اسم الدالة التي استدعاها النموذج */
  tool?: string;
  meta?: Record<string, unknown>;
}

/** جلسة/محادثة مع عميل واحد */
export interface Session {
  /** رقم العميل (wa_id) */
  key: string;
  name: string;
  state: ConversationState;
  /** اللغة المكتشفة لآخر رسالة */
  language: string;
  /** ملخص تراكمي للمحادثة (يُبنى عند تجاوز السجل) */
  summary: string;
  /** اسم الموظف/العميل كما يعرفه البوت */
  knownName?: string;
  createdAt: number;
  updatedAt: number;
  lastInboundAt: number;
  lastOutboundAt: number;
  messages: StoredMessage[];
  stats: {
    inbound: number;
    outbound: number;
    handoffs: number;
    promptTokens: number;
    candidatesTokens: number;
    calls: number;
    errors: number;
  };
}

/** نتيجة مولّد الردود */
export interface AgentResult {
  /** الرد مقسّمًا إلى رسائل قصيرة مناسبة لواتساب */
  parts: string[];
  /** هل يطلب النموذج تحويل المحادثة لبشري؟ */
  handoff: boolean;
  reason?: string;
  intent?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** الدوال التي نُفّذت أثناء توليد الرد */
  toolsCalled: { name: string; args: Record<string, unknown>; result: unknown }[];
  usage: { promptTokens: number; candidatesTokens: number };
  model: string;
  /** المحرك المستخدم: gemini أو mock */
  engine: 'gemini' | 'mock';
  latencyMs: number;
}

/** حدث يُبثّ للوحة التحكم عبر WebSocket */
export type DashboardEvent =
  | { t: 'inbound'; sessionKey: string; name: string; message: StoredMessage; state: ConversationState }
  | { t: 'outbound'; sessionKey: string; name: string; message: StoredMessage; state: ConversationState }
  | { t: 'status'; sessionKey: string; state: ConversationState; note?: string }
  | { t: 'typing'; sessionKey: string; on: boolean }
  | { t: 'tool'; sessionKey: string; name: string; args: Record<string, unknown>; result: unknown }
  | { t: 'error'; sessionKey?: string; message: string }
  | { t: 'stats'; snapshot: StatsSnapshot };

export interface StatsSnapshot {
  sessions: number;
  activeBot: number;
  activeHuman: number;
  inbound: number;
  outbound: number;
  handoffs: number;
  avgLatencyMs: number;
  promptTokens: number;
  candidatesTokens: number;
  errors: number;
  demoMode: boolean;
  model: string;
}
