/**
 * سجلّ الأدوات (Tool Registry) — عقد موحّد لكل ما يستطيع الـ LLM استدعاءه:
 *   validate  : تحقق صارم من الوسيطات قبل لمس منطق الأعمال
 *   authorize: كل أدوات النموذج في نطاق العميل؛ الملكية تُفرض داخل الخدمات
 *   audit     : تسجيل العمليات المعدِّلة في سجل التدقيق
 *   idempotent: العمليات المعدِّلة تحمل مفتاح ثبات
 *
 * النموذج لا يرى أي أداة إدارية إطلاقًا (لا تُمرّر تعريفاتها إليه).
 */
import { audit } from '../db/repos/system.js';
import { log } from '../lib/utils.js';
import type { ToolContext, ToolResult } from './tools-types.js';

export interface ToolSpec {
  /** وسائط مقبولة فقط (أي مفتاح غير مُعلن يُتجاهل) */
  validate: (args: Record<string, unknown>) => string | null;
  /** عملية معدِّلة تستحق التدقيق */
  mutating?: boolean;
  /** فعل التدقيق */
  auditAction?: string;
  /** نوع الكيان للتدقيق */
  auditEntity?: string;
}

// ───────────────────────── متحققات صغيرة قابلة لإعادة الاستخدام ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const REF_RE = /^[A-Z]{2,5}-[A-Z0-9]{4,12}$/i;

const str = (v: unknown, field: string, { max = 300, min = 0, optional = true } = {}): string | null => {
  if (v === undefined || v === null || v === '') return optional ? null : `الحقل ${field} مطلوب`;
  if (typeof v !== 'string') return `${field} يجب أن يكون نصًا`;
  const t = v.trim();
  if (t.length < min) return `${field} قصير جدًا`;
  if (t.length > max) return `${field} أطول من الحد (${max})`;
  return null;
};

const num = (v: unknown, field: string, { min = 0, max = 100000, optional = true } = {}): string | null => {
  if (v === undefined || v === null) return optional ? null : `الحقل ${field} مطلوب`;
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${field} يجب أن يكون رقمًا`;
  if (v < min || v > max) return `${field} خارج النطاق المسموح`;
  return null;
};

const oneOf = (v: unknown, values: string[], optional = true): string | null => {
  if (v === undefined || v === null || v === '') return optional ? null : 'قيمة مطلوبة';
  if (!values.includes(String(v))) return `قيمة غير مسموحة (المسموح: ${values.join(' | ')})`;
  return null;
};

// ───────────────────────── مواصفات الأدوات ─────────────────────────

export const TOOL_SPECS: Record<string, ToolSpec> = {
  get_services: {
    validate: (a) => str(a.category, 'category', { max: 60 }),
  },
  get_service_details: {
    validate: (a) => {
      if (a.service_id === undefined || a.service_id === null || a.service_id === '') return 'service_id مطلوب (رقم أو slug)';
      if (typeof a.service_id !== 'string' && typeof a.service_id !== 'number') return 'service_id غير صالح';
      if (typeof a.service_id === 'string' && a.service_id.length > 60) return 'service_id طويل';
      return null;
    },
  },
  check_availability: {
    validate: (a) => {
      if (a.date !== undefined && a.date !== '' && !DATE_RE.test(String(a.date))) return 'التاريخ بصيغة YYYY-MM-DD';
      if (a.time !== undefined && a.time !== '' && !TIME_RE.test(String(a.time))) return 'الوقت بصيغة HH:MM';
      return null;
    },
  },
  create_booking: {
    mutating: true, auditAction: 'tool.booking_create', auditEntity: 'booking',
    validate: (a) => {
      if (!DATE_RE.test(String(a.date ?? ''))) return 'تاريخ الحجز مطلوب بصيغة YYYY-MM-DD';
      if (!TIME_RE.test(String(a.time ?? ''))) return 'وقت الحجز مطلوب بصيغة HH:MM';
      if (a.service !== undefined && a.service !== '' && typeof a.service !== 'string' && typeof a.service !== 'number') {
        return 'الخدمة غير صالحة';
      }
      return (
        str(a.full_name, 'full_name', { max: 60 }) ??
        str(a.restaurant_name, 'restaurant_name', { max: 80 }) ??
        str(a.city, 'city', { max: 60 }) ??
        str(a.notes, 'notes', { max: 300 }) ??
        num(a.tables, 'tables', { min: 1, max: 2000 })
      );
    },
  },
  update_booking: {
    mutating: true, auditAction: 'tool.booking_update', auditEntity: 'booking',
    validate: (a) => {
      if (a.date !== undefined && a.date !== '' && !DATE_RE.test(String(a.date))) return 'التاريخ بصيغة YYYY-MM-DD';
      if (a.time !== undefined && a.time !== '' && !TIME_RE.test(String(a.time))) return 'الوقت بصيغة HH:MM';
      return str(a.booking_ref, 'booking_ref', { max: 20 }) ?? str(a.notes, 'notes', { max: 300 });
    },
  },
  cancel_booking: {
    mutating: true, auditAction: 'tool.booking_cancel', auditEntity: 'booking',
    validate: (a) => str(a.booking_ref, 'booking_ref', { max: 20 }) ?? str(a.reason, 'reason', { max: 200 }),
  },
  get_customer_bookings: { validate: () => null },
  get_order_status: {
    validate: (a) => {
      if (typeof a.order_ref !== 'string' || !REF_RE.test(a.order_ref.trim())) return 'order_ref غير صالح (مثال: ORD-AB12CD)';
      return null;
    },
  },
  create_support_ticket: {
    mutating: true, auditAction: 'tool.ticket_create', auditEntity: 'ticket',
    validate: (a) =>
      str(a.issue, 'issue', { min: 5, max: 2000, optional: false }) ??
      str(a.restaurant_name, 'restaurant_name', { max: 80 }) ??
      oneOf(a.priority, ['low', 'normal', 'high', 'urgent']),
  },
  handoff_to_human: {
    mutating: true, auditAction: 'tool.handoff', auditEntity: 'conversation',
    validate: (a) => str(a.reason, 'reason', { max: 300 }) ?? str(a.summary, 'summary', { max: 800 }),
  },
  recommend_plan: {
    validate: (a) => num(a.tables, 'tables', { min: 1, max: 100000 }),
  },
  save_restaurant_profile: {
    validate: (a) =>
      str(a.full_name, 'full_name', { max: 60 }) ??
      str(a.restaurant_name, 'restaurant_name', { max: 80 }) ??
      str(a.city, 'city', { max: 60 }) ??
      str(a.notes, 'notes', { max: 500 }) ??
      num(a.tables, 'tables', { min: 1, max: 2000 }) ??
      num(a.branches, 'branches', { min: 1, max: 500 }) ??
      num(a.menu_items, 'menu_items', { min: 1, max: 100000 }) ??
      oneOf(a.preferred_plan, ['starter', 'pro', 'enterprise']),
  },
  send_notification: {
    mutating: true, auditAction: 'tool.notify_staff', auditEntity: 'notification',
    validate: (a) =>
      str(a.message, 'message', { min: 2, max: 600, optional: false }) ??
      oneOf(a.to, ['manager', 'human']) ??
      oneOf(a.priority, ['low', 'normal', 'high', 'urgent']),
  },
  build_launch_blueprint: { validate: () => null },
  confirm_launch_order: {
    mutating: true, auditAction: 'tool.order_confirm', auditEntity: 'order',
    validate: (a) => {
      const isConfirmed = a.confirmed === true || a.confirmed === 'true' || a.confirmed === 1 || a.confirmed === '1' || a.confirmed === 'نعم';
      return (!isConfirmed ? 'يجب أن يكون confirmed=true' : null) ?? str(a.notes, 'notes', { max: 500 });
    },
  },
  get_plan_details: {
    validate: (a) => oneOf(a.plan_id, ['starter', 'pro', 'enterprise'], false) ?? oneOf(a.billing, ['monthly', 'yearly']),
  },
  get_menu: { validate: () => null },
  get_restaurant_info: { validate: () => null },
  get_customer: { validate: () => null },
  capture_subscription_lead: { validate: () => null }, // متوافق خلفي فقط
};

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * المنفّذ الآمن الموحّد. أي أداة غير معلنة أو ذات وسيط فاسد تُرفض قبل التنفيذ،
 * وأي خطأ يُلتقط ويُعاد كنتيجة فاشلة منظّفة (لا يصل الاستثناء لحلقة النموذج).
 */
export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined | null,
  ctx: ToolContext,
  handlers: Record<string, ToolHandler>,
): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const spec = TOOL_SPECS[name];

  // أدوات غير معلنة للسجل → مرفوضة (لا يوجد تنفيذ ضمني/سري)
  if (!spec || !handlers[name]) {
    audit({ actorType: 'llm', actorId: ctx.sessionKey, action: 'tool.denied', entity: 'tool', entityId: name });
    log.warn(`🚫 رفض استدعاء أداة غير مصرّح بها: ${name}`);
    return { ok: false, data: { error: `دالة غير معروفة أو غير مصرّح بها: ${name}` } };
  }

  const error = spec.validate(args);
  if (error) {
    audit({ actorType: 'llm', actorId: ctx.sessionKey, action: 'tool.validation_failed', entity: 'tool', entityId: name, meta: { error } });
    log.warn(`🚫 وسائط غير صالحة للأداة ${name}: ${error}`);
    return { ok: false, data: { error }, userMessage: '' };
  }

  try {
    const result = await handlers[name]!(args as Record<string, any>, ctx);
    if (spec.mutating) {
      audit({
        actorType: 'llm',
        actorId: ctx.sessionKey,
        action: spec.auditAction ?? `tool.${name}`,
        entity: spec.auditEntity ?? name,
        entityId: extractRef(result) ?? String(args.booking_ref ?? args.order_ref ?? ''),
        meta: { ok: result.ok, ...safeArgs(args) },
      });
    }
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log.error(`فشل تنفيذ الأداة ${name}: ${message}`);
    audit({ actorType: 'system', actorId: ctx.sessionKey, action: 'tool.error', entity: 'tool', entityId: name, meta: { message } });
    return { ok: false, data: { error: message }, userMessage: '' };
  }
}

function extractRef(result: ToolResult): string | undefined {
  const d = result.data as Record<string, unknown> | null;
  return typeof d?.ref === 'string' ? d.ref : typeof d?.order_ref === 'string' ? d.order_ref : undefined;
}

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
