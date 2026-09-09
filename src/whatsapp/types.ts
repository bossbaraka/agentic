/** أنواع WhatsApp Cloud API كما تصل في الـ webhook */

export interface WebhookPayload {
  object: 'whatsapp_business_account';
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  field: string;
  value: WebhookValue;
}

export interface WebhookValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WebhookContact[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
  errors?: { code: number; title: string; message?: string }[];
}

export interface WebhookContact {
  profile: { name: string };
  wa_id: string;
}

export interface WebhookStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title: string; message?: string }[];
  pricing?: { billable: boolean; category: string };
}

/** رسالة واردة — الحقول تختلف حسب type */
export interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  /** لو الرسالة محوّلة من محادثة أخرى */
  forward?: boolean;
  context?: { from?: string; id?: string };

  text?: { body: string };

  image?: MediaRef & { caption?: string };
  audio?: MediaRef;           // يشمل الرسائل الصوتية
  voice?: MediaRef;            // تسجيل صوتي داخل واتساب
  video?: MediaRef & { caption?: string };
  document?: MediaRef & { caption?: string; filename?: string };
  sticker?: MediaRef;

  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };

  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];

  reaction?: { message_id: string; emoji: string };

  button?: { text: string; payload?: string };

  interactive?:
    | { type: 'button_reply'; button_reply: { id: string; title: string } }
    | { type: 'list_reply'; list_reply: { id: string; title: string; description?: string } }
    | { type: string; [k: string]: unknown };

  order?: { text?: string; catalog_id?: string; product_items?: unknown[] };

  /** أنواع غير مدعومة (مثل: call log) */
  unsupported?: { type?: string };
  errors?: { code: number; title: string; message?: string }[];
}

interface MediaRef {
  id: string;
  mime_type: string;
  sha256: string;
}

/** رسالة واردة بعد توحيد شكلها داخليًا */
export interface NormalizedInbound {
  /** القناة: واتساب أو تيليجرام */
  channel: 'wa' | 'tg';
  /** wamid أو معادل تيليجرام — مفتاح منع التكرار */
  waId: string;
  /** رقم العميل (واتساب) أو `tg:<chatId>` (تيليجرام) */
  from: string;
  phoneNumberId: string;    // رقم النشاط الذي استقبل الرسالة
  contactName: string;
  type: string;             // text | image | audio | ...
  timestamp: number;
  forwarded: boolean;

  /** النص الأساسي الموحّد (جسم الرسالة أو وصف الوسائط) */
  body: string;
  caption?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };

  /** مرجع الوسائط للتنزيل لاحقًا */
  media?: { id: string; mimeType: string; kind: 'image' | 'audio' | 'video' | 'document' };

  /** أزرار/قوائم تفاعلية */
  reply?: { id: string; title: string };
  reaction?: { messageId: string; emoji: string };

  raw: WebhookMessage | Record<string, unknown>;
}
