/**
 * التحويل للموظف البشري (Human Handoff).
 * عند التحويل: حالة المحادثة human، البوت يصمت تمامًا، ويُنبّه الموظف
 * بالاسم/المعرّف/الطلب/السبب، وكل ذلك مدقّق ومقيس.
 */
import { setConversationState, ensureConversation } from '../db/repos/conversations.js';
import { audit, recordMetric } from '../db/repos/system.js';
import { notifications } from './notificationService.js';

export const handoffService = {
  /** طلب عميل (أو الـ AI) التحويل لبشري */
  request(input: { contactKey: string; name?: string; reason?: string; lastMessage?: string; summary?: string }): void {
    ensureConversation(input.contactKey, input.name ?? '');
    setConversationState(input.contactKey, 'human', { reason: input.reason ?? 'طلب العميل موظفًا بشريًا' });

    const note =
      `🙋 *تحويل محادثة لبشري*\n` +
      `العميل: ${input.name ?? input.contactKey} (${input.contactKey})\n` +
      (input.reason ? `السبب: ${input.reason}\n` : '') +
      (input.summary ? `ملخص: ${input.summary.slice(0, 500)}\n` : '') +
      (input.lastMessage ? `آخر رسالة: ${input.lastMessage.slice(0, 400)}` : '');

    notifications.staffAlert('human', note, {
      contactKey: input.contactKey,
      name: input.name ?? input.contactKey,
      lastMessage: input.lastMessage ?? '',
      reason: input.reason,
    });
    audit({ actorType: 'customer', actorId: input.contactKey, action: 'handoff.request', entity: 'conversation', entityId: input.contactKey, meta: { reason: input.reason ?? null } });
    recordMetric('handoff', { refKey: input.contactKey });
  },

  /** موظف يستلم المحادثة */
  takeover(admin: { id: number; role: string }, contactKey: string): void {
    setConversationState(contactKey, 'human', { assignedAdminId: admin.id, reason: `استلمها الموظف #${admin.id}` });
    audit({ actorType: 'admin', actorId: String(admin.id), action: 'handoff.takeover', entity: 'conversation', entityId: contactKey });
  },

  /** إعادة المحادثة للبوت */
  resume(contactKey: string, actorId?: number): void {
    setConversationState(contactKey, 'bot', { reason: null, assignedAdminId: null });
    audit({ actorType: actorId ? 'admin' : 'system', actorId: actorId ? String(actorId) : null, action: 'handoff.resume', entity: 'conversation', entityId: contactKey });
  },
};
