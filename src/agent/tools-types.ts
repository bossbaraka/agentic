/** أنواع عقود الأدوات المشتركة (مستقلة عن التنفيذ لتجنب الاستيراد الدائري) */

export interface ToolContext {
  /** مفتاح الجلسة الموحّد (tg:<id> أو wa_id) — أساس الملكية والتفويض */
  sessionKey: string;
  /** اسم العميل للعرض */
  customerName: string;
  /** رقم رسالة القناة للرد/الربط */
  replyTo?: string;
  /** قناة المصدر */
  channel?: 'tg' | 'wa';
  /** لغة العميل المكتشفة */
  language?: 'ar' | 'en' | 'he';
  /** معرّف المستخدم في قاعدة البيانات إن وُجد */
  userId?: number;
}

export interface ToolResult {
  ok: boolean;
  /** ما يُرجَع للنموذج كبيانات */
  data: unknown;
  /** رسالة جاهزة تُعرض للعميل مباشرة (اختياري) */
  userMessage?: string;
  /** إجراء جانبي يطلبه المنفّذ (تنبيه فريق، تحويل بشري...) */
  sideEffect?:
    | { kind: 'send_media' | 'notify_human' | 'notify_manager'; payload: Record<string, unknown> }
    | { kind: 'handoff'; payload: { reason?: string; lastMessage?: string } };
}
