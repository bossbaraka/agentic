/** خدمة الطلبات (تجهيز الاشتراكات + طلبات الخدمات الرقمية) */
import {
  createOrder,
  getOrderByRef,
  listOrdersForContact,
  listOrdersAdmin,
  setOrderStatus,
} from '../db/repos/commerce.js';
import { getService, serviceName } from '../db/repos/catalog.js';
import { ensureCustomer } from '../db/repos/users.js';
import { audit } from '../db/repos/system.js';
import { recordMetric } from '../db/repos/system.js';
import { ServiceError } from './errors.js';
import { notifications } from './notificationService.js';
import type { OrderRow } from '../db/types.js';

export const orderService = {
  /** طلب خدمة رقمية (غير محجوزة بموعد) — يتحول لطلب PENDING ويُنبّه الفريق */
  requestService(input: { contactKey: string; serviceIdOrSlug: number | string; language?: 'ar' | 'en'; notes?: string }): OrderRow {
    const service = getService(input.serviceIdOrSlug);
    if (!service) throw new ServiceError('not_found', 'الخدمة غير موجودة');
    if (service.status !== 'active') throw new ServiceError('unavailable', 'الخدمة غير متاحة حاليًا');

    const { user } = ensureCustomer(input.contactKey, { language: input.language ?? 'ar' });
    const name = input.language === 'en' && service.name_en ? service.name_en : service.name_ar;
    const order = createOrder({
      contactKey: input.contactKey,
      kind: 'service_inquiry',
      service,
      summary: `طلب خدمة: ${name}${input.notes ? ` — ${input.notes}` : ''}`,
      totalAmount: service.price,
      userId: user.id,
      idempotencyKey: `svc:${input.contactKey}:${service.id}`,
    });

    notifications.staffAlert('manager',
      `📝 طلب خدمة جديد ${order.ref}\n📦 ${name}\n💬 ${input.contactKey}${input.notes ? `\n📝 ${input.notes.slice(0, 200)}` : ''}`,
      { orderRef: order.ref, contactKey: input.contactKey });
    audit({ actorType: 'customer', actorId: input.contactKey, action: 'order.service_request', entity: 'order', entityId: order.ref });
    recordMetric('order_created', { refKey: input.contactKey, meta: { kind: 'service_inquiry', ref: order.ref } });
    return order;
  },

  /** طلب تجهيز/إطلاق مؤكد (من مسار الباقات) */
  launchOrder(input: {
    contactKey: string;
    summary: string;
    payload: Record<string, unknown>;
    serviceSlug?: string;
    totalAmount?: number | null;
    language?: 'ar' | 'en';
  }): OrderRow {
    const { user, customer } = ensureCustomer(input.contactKey, { language: input.language ?? 'ar' });
    const service = input.serviceSlug ? getService(input.serviceSlug) : undefined;
    // ثبات: طلب إطلاق واحد نشط لكل عميل على نفس الخدمة
    const existing = listOrdersForContact(input.contactKey).find(
      (o) => o.kind === 'launch' && o.status !== 'CANCELLED' && o.service_id === (service?.id ?? null),
    );
    if (existing) return existing;

    const order = createOrder({
      contactKey: input.contactKey,
      kind: 'launch',
      service: service ?? null,
      summary: input.summary,
      totalAmount: input.totalAmount ?? service?.price ?? null,
      payload: { ...input.payload, customer: customer.id },
      userId: user.id,
      customerId: customer.id,
      status: 'CONFIRMED',
    });

    notifications.staffAlert('manager', `🚀 طلب إطلاق مؤكد ${order.ref}\n${input.summary}`, {
      orderRef: order.ref, contactKey: input.contactKey,
    });
    audit({ actorType: 'customer', actorId: input.contactKey, action: 'order.launch_confirmed', entity: 'order', entityId: order.ref });
    recordMetric('order_created', { refKey: input.contactKey, meta: { kind: 'launch', ref: order.ref } });
    return order;
  },

  byRef(ref: string, contactKey?: string): OrderRow {
    const order = getOrderByRef(ref);
    if (!order) throw new ServiceError('not_found', 'الطلب غير موجود');
    if (contactKey && order.contact_key !== contactKey) {
      audit({ actorType: 'customer', actorId: contactKey, action: 'order.access_denied', entity: 'order', entityId: ref });
      throw new ServiceError('forbidden', 'لا تملك صلاحية على هذا الطلب');
    }
    return order;
  },

  listFor(contactKey: string): OrderRow[] {
    return listOrdersForContact(contactKey);
  },

  serviceLabel(order: OrderRow, lang: 'ar' | 'en' = 'ar'): string {
    if (!order.service_id) return '—';
    const s = getService(order.service_id);
    return s ? serviceName(s, lang) : '—';
  },

  adminList(opts: { status?: string; limit?: number; offset?: number }) {
    return listOrdersAdmin(opts);
  },

  setStatus(adminId: number, ref: string, status: OrderRow['status']): OrderRow {
    const order = getOrderByRef(ref);
    if (!order) throw new ServiceError('not_found', 'الطلب غير موجود');
    const updated = setOrderStatus(ref, status)!;
    audit({ actorType: 'admin', actorId: String(adminId), action: 'order.setStatus', entity: 'order', entityId: ref, meta: { status } });
    notifications.customer(order.contact_key,
      status === 'COMPLETED' ? '🎉 تم إكمال طلبك بنجاح. شكرًا لاختيارك مُريح!' : `تم تحديث حالة طلبك ${ref} إلى: ${status}.`,
      { kind: 'order_status', extra: { orderRef: ref } });
    return updated;
  },
};
