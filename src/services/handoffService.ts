/**
 * التحويل للموظف البشري (Human Handoff).
 * عند التحويل: حالة المحادثة human، البوت يصمت تمامًا، ويُنبّه الموظف
 * بالاسم/المعرّف/الطلب/السبب، وكل ذلك مدقّق ومقيس.
 */
import { setConversationState, ensureConversation } from '../db/repos/conversations.js';
import { audit, recordMetric } from '../db/repos/system.js';
import { notifications } from './notificationService.js';

export interface HandoffMeta {
  /** مرحلة العميل في رحلة البيع */
  stage?: string;
  /** نقاط الجودة 0–100 */
  leadScore?: number;
  /** باقة معروضة/مختارة */
  plan?: string;
  /** عدد طاولات المطعم */
  tables?: number;
  /** اسم المطعم */
  restaurant?: string;
  /** نوع الاعتراض القائم إن وجد */
  objection?: string;
}

export const handoffService = {
  /** طلب عميل (أو الـ AI) التحويل لبشري — مع بيانات تسليم مفيدة للموظف */
  request(input: { contactKey: string; name?: string; reason?: string; lastMessage?: string; summary?: string; meta?: HandoffMeta }): void {
    ensureConversation(input.contactKey, input.name ?? '');
    setConversationState(input.contactKey, 'human', { reason: input.reason ?? 'طلب العميل موظفًا بشريًا' });

    const m = input.meta;
    const metaLines: string[] = [];
    if (m?.stage) metaLines.push(`المرحلة: ${m.stage}`);
    if (m?.leadScore !== undefined) metaLines.push(`نقاط الجودة: ${m.leadScore}/100`);
    if (m?.restaurant) metaLines.push(`المطعم: ${m.restaurant}`);
    if (m?.tables) metaLines.push(`الطاولات: ${m.tables}`);
    if (m?.plan) metaLines.push(`الباقة: ${m.plan}`);
    if (m?.objection) metaLines.push(`اعتراض قائم: ${m.objection}`);

    const note =
      `🙋 *تحويل محادثة لبشري*\n` +
      `العميل: ${input.name ?? input.contactKey} (${input.contactKey})\n` +
      (input.reason ? `السبب: ${input.reason}\n` : '') +
      (metaLines.length ? `سياق العميل: ${metaLines.join(' · ')}\n` : '') +
      (input.summary ? `ملخص: ${input.summary.slice(0, 500)}\n` : '') +
      (input.lastMessage ? `آخر رسالة: ${input.lastMessage.slice(0, 400)}` : '');

    notifications.staffAlert('human', note, {
      contactKey: input.contactKey,
      name: input.name ?? input.contactKey,
      lastMessage: input.lastMessage ?? '',
      reason: input.reason,
      ...(m ?? {}),
    });
    audit({ actorType: 'customer', actorId: input.contactKey, action: 'handoff.request', entity: 'conversation', entityId: input.contactKey, meta: { reason: input.reason ?? null, ...(m ?? {}) } });
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
