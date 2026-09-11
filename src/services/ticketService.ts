/** خدمة تذاكر الدعم */
import {
  createTicket,
  getTicketByRef,
  listTicketsAdmin,
  listTicketsForContact,
  setTicketStatus,
} from '../db/repos/commerce.js';
import { ensureCustomer } from '../db/repos/users.js';
import { audit, recordMetric } from '../db/repos/system.js';
import { ServiceError } from './errors.js';
import { notifications } from './notificationService.js';
import type { TicketRow } from '../db/types.js';

export const ticketService = {
  open(input: {
    contactKey: string;
    issue: string;
    restaurantName?: string | null;
    plan?: string | null;
    priority?: TicketRow['priority'];
    language?: 'ar' | 'en';
  }): TicketRow {
    const issue = input.issue?.trim();
    if (!issue || issue.length < 5) throw new ServiceError('validation', 'وصف المشكلة قصير جدًا');
    const { user, customer } = ensureCustomer(input.contactKey, {
      displayName: input.restaurantName ?? null,
      language: input.language ?? 'ar',
    });
    const ticket = createTicket({
      contactKey: input.contactKey,
      issue: issue.slice(0, 2000),
      restaurantName: input.restaurantName ?? customer.restaurant_name,
      plan: input.plan ?? customer.preferred_plan,
      priority: input.priority ?? 'normal',
      userId: user.id,
      customerId: customer.id,
    });

    const prioAr: Record<string, string> = { urgent: 'عاجلة', high: 'عالية', normal: 'عادية', low: 'منخفضة' };
    notifications.staffAlert('human',
      `🎫 تذكرة دعم جديدة ${ticket.ref} (أولوية: ${prioAr[ticket.priority]})\n` +
      `المطعم: ${ticket.restaurant_name ?? '—'}${ticket.plan ? ` (${ticket.plan})` : ''}\n` +
      `المشكلة: ${ticket.issue.slice(0, 400)}`,
      { ticketRef: ticket.ref, contactKey: ticket.contact_key, name: ticket.restaurant_name ?? ticket.contact_key });
    audit({ actorType: 'customer', actorId: input.contactKey, action: 'ticket.open', entity: 'ticket', entityId: ticket.ref });
    recordMetric('ticket_opened', { refKey: input.contactKey });
    return ticket;
  },

  byRef(ref: string): TicketRow {
    const t = getTicketByRef(ref);
    if (!t) throw new ServiceError('not_found', 'التذكرة غير موجودة');
    return t;
  },

  listFor(contactKey: string): TicketRow[] {
    return listTicketsForContact(contactKey);
  },

  adminList(opts: { status?: string; limit?: number; offset?: number }) {
    return listTicketsAdmin(opts);
  },

  setStatus(adminId: number, ref: string, status: TicketRow['status'], resolution?: string): TicketRow {
    if (!getTicketByRef(ref)) throw new ServiceError('not_found', 'التذكرة غير موجودة');
    const updated = setTicketStatus(ref, status, resolution)!;
    audit({ actorType: 'admin', actorId: String(adminId), action: 'ticket.setStatus', entity: 'ticket', entityId: ref, meta: { status } });
    notifications.customer(updated.contact_key,
      status === 'RESOLVED'
        ? `تم حل تذكرتك ${ref} ✅ لو احتجت أي شيء آخر نحن هنا.`
        : `تحديث على تذكرتك ${ref}: الحالة الآن ${status}.`,
      { kind: 'ticket_status', extra: { ticketRef: ref } });
    return updated;
  },
};
