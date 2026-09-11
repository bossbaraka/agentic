/**
 * واجهة الموظف الإدارية عبر تيليجرام — RBAC بالكامل.
 * أوامر: /admin (لوحة)، وإجراءات نصية مختصرة موثّقة في شاشة اللوحة.
 * كل العمليات تمر عبر adminService الذي يفرض الصلاحيات ويسجّل التدقيق.
 */
import { adminService } from '../services/adminService.js';
import { catalogService } from '../services/catalogService.js';
import { bookingService } from '../services/bookingService.js';
import { handoffService } from '../services/handoffService.js';
import { store } from '../lib/store.js';
import { ServiceError } from '../services/errors.js';
import { roleLabelAr } from '../services/rbac.js';
import type { AdminRow, BookingStatus } from '../db/types.js';
import type { NormalizedInbound } from '../whatsapp/types.js';
import {
  tgSendMessage,
  tgEditMessage,
  type SendMessageOpts,
  type TgInlineButton,
  type TgInlineKeyboard,
} from './client.js';
import type { CallbackContext, CallbackResult } from './router.js';
import { menus, dayName } from './menus.js';
import { bookingStatusText, orderStatusText, type UiLang } from '../lib/i18n.js';
import { t } from '../lib/i18n.js';

type Deps = {
  send(chatId: string, opts: SendMessageOpts): Promise<unknown>;
  edit(chatId: string, messageId: string | number, opts: { text: string; inline?: TgInlineKeyboard }): Promise<unknown>;
};
const deps: Deps = { send: tgSendMessage, edit: tgEditMessage };

const PAGE = 6;

const adminMenuKeyboard = (): TgInlineKeyboard => [
  [{ text: '📊 الإحصائيات', callback_data: 'a:stats' }, { text: '🗓️ الحجوزات', callback_data: 'a:bk:CONFIRMED:0' }],
  [{ text: '📋 الطلبات', callback_data: 'a:od:0' }, { text: '🎫 التذاكر', callback_data: 'a:tk:0' }],
  [{ text: '🛎️ الخدمات', callback_data: 'a:sv:0' }, { text: '👥 العملاء', callback_data: 'a:cu' }],
  [{ text: '🧑‍💼 الموظفون', callback_data: 'a:st' }, { text: '📜 السجل', callback_data: 'a:lg' }],
  [{ text: '🏠 الرئيسية', callback_data: 'h' }],
];

export class TelegramAdminHandler {
  private adminFrom(telegramId: string): AdminRow | undefined {
    return adminService.resolveByTelegramId(telegramId);
  }

  /** أوامر نصية — يرجع true إذا عالجها */
  async handleText(msg: NormalizedInbound): Promise<boolean> {
    if (msg.channel !== 'tg') return false;
    const telegramId = msg.from.replace(/^tg:/, '');
    const body = msg.body.trim();
    const isAdminCmd = /^\/(admin|addstaff|rmstaff|take|resumeadmin|bkstatus|ostatus|tstatus)\b/.test(body.toLowerCase());
    if (!isAdminCmd) return false;
    const admin = this.adminFrom(telegramId);
    if (!admin) {
      await deps.send(telegramId, { text: '⛔ هذه الأوامر للموظفين فقط. لو كنت عضوًا في الفريق اطلب من مشرف أعلى إضافتك.' });
      return true;
    }

    try {
      const [cmd, ...args] = body.replace(/^\//, '').split(/\s+/);
      switch (cmd!.toLowerCase()) {
        case 'admin':
          if (!args.length || args[0] === 'menu' || args[0] === 'start') {
            await deps.send(telegramId, { text: this.menuText(admin), inline: adminMenuKeyboard() });
            return true;
          }
          await this.runSubcommand(admin, telegramId, args);
          return true;
        case 'addstaff': {
          const [id, role] = args;
          if (!id || !role) return this.usage(telegramId, '/addstaff <telegram_id> <STAFF|MANAGER|ADMIN>');
          const row = adminService.addStaff(admin, id, role.toUpperCase());
          await deps.send(telegramId, { text: `✅ ${roleLabelAr(row.role)} مضاف: ${id}` });
          return true;
        }
        case 'rmstaff': {
          if (!args[0]) return this.usage(telegramId, '/rmstaff <telegram_id>');
          adminService.removeStaff(admin, args[0]);
          await deps.send(telegramId, { text: `✅ تم تعطيل الموظف ${args[0]}` });
          return true;
        }
        case 'take': {
          if (!args[0]) return this.usage(telegramId, '/take <tg:123 أو wa_id>');
          adminService.takeover(admin, args[0]);
          await deps.send(telegramId, { text: `✅ استلمت المحادثة ${args[0]} — البوت صامت الآن.` });
          return true;
        }
        case 'resumeadmin': {
          if (!args[0]) return this.usage(telegramId, '/resumeadmin <key>');
          adminService.resume(args[0]);
          store.setState(args[0], 'bot', '🤖 إرجاع آلي بقرار موظف');
          await deps.send(telegramId, { text: `✅ أُعيدت المحادثة ${args[0]} للبوت.` });
          return true;
        }
        case 'bkstatus': {
          const [ref, status] = args;
          if (!ref || !status) return this.usage(telegramId, '/bkstatus <BKG-XXXXXX> <CONFIRMED|COMPLETED|NO_SHOW|CANCELLED>');
          const b = adminService.setBookingStatus(admin, ref, status.toUpperCase() as BookingStatus);
          await deps.send(telegramId, { text: `✅ حجز ${b.ref} → ${bookingStatusText(b.status, 'ar')}` });
          return true;
        }
        case 'ostatus': {
          const [ref, status] = args;
          if (!ref || !status) return this.usage(telegramId, '/ostatus <ORD-XXXXXX> <CONFIRMED|IN_PROGRESS|COMPLETED|CANCELLED>');
          const o = adminService.setOrderStatus(admin, ref, status.toUpperCase() as any);
          await deps.send(telegramId, { text: `✅ طلب ${o.ref} → ${orderStatusText(o.status, 'ar' as UiLang)}` });
          return true;
        }
        case 'tstatus': {
          const [ref, status] = args;
          if (!ref || !status) return this.usage(telegramId, '/tstatus <TCK-XXXXXX> <IN_PROGRESS|RESOLVED|CLOSED>');
          const tk = adminService.setTicketStatus(admin, ref, status.toUpperCase() as any);
          await deps.send(telegramId, { text: `✅ تذكرة ${tk.ref} → ${tk.status}` });
          return true;
        }
      }
    } catch (err) {
      await deps.send(telegramId, { text: `⚠️ ${err instanceof ServiceError ? err.message : (err as Error).message}` });
    }
    return true;
  }

  private async runSubcommand(admin: AdminRow, chatId: string, args: string[]): Promise<void> {
    const [sub, a, b] = args;
    switch (sub) {
      case 'stats':
        await deps.send(chatId, { text: this.statsText(admin), inline: adminMenuKeyboard() });
        return;
      case 'bookings': case 'bk': {
        const status = (a ?? 'CONFIRMED').toUpperCase() as BookingStatus | 'all';
        await deps.send(chatId, this.bookingsScreen(admin, status, 0));
        return;
      }
      case 'orders': case 'od':
        await deps.send(chatId, this.ordersScreen(admin, 0));
        return;
      case 'tickets': case 'tk':
        await deps.send(chatId, this.ticketsScreen(admin, 0));
        return;
      case 'services': case 'sv':
        await deps.send(chatId, this.servicesScreen(admin, 0));
        return;
      case 'staff': case 'st':
        await deps.send(chatId, { text: this.staffText(admin), inline: adminMenuKeyboard() });
        return;
      case 'logs': case 'lg':
        await deps.send(chatId, { text: this.logsText(admin), inline: adminMenuKeyboard() });
        return;
      case 'customers': case 'cu':
        await deps.send(chatId, { text: this.customersText(admin), inline: adminMenuKeyboard() });
        return;
      case 'take':
        if (a) { adminService.takeover(admin, a); await deps.send(chatId, { text: `✅ استلمت ${a}` }); }
        return;
      default:
        await deps.send(chatId, { text: this.menuText(admin), inline: adminMenuKeyboard() });
    }
  }

  /** معالجة أزرار الإدارة — يرجع null إذا لم تكن أزرارها */
  async handleCallback(c: CallbackContext): Promise<CallbackResult | null> {
    if (!c.data.startsWith('a:')) return null;
    const admin = this.adminFrom(c.fromId);
    if (!admin) return { alert: '⛔ للموظفين فقط', popup: true };
    const parts = c.data.split(':');
    const action = parts[1]!;
    try {
      switch (action) {
        case 'menu':
          await deps.edit(c.chatId, c.messageId, { text: this.menuText(admin), inline: adminMenuKeyboard() });
          return null;
        case 'stats':
          await deps.edit(c.chatId, c.messageId, { text: this.statsText(admin), inline: adminMenuKeyboard() });
          return null;
        case 'bk':
          await deps.edit(c.chatId, c.messageId, this.bookingsScreen(admin, (parts[2] as BookingStatus) ?? 'CONFIRMED', Number(parts[3] ?? 0)));
          return null;
        case 'bi': {
          const b = adminService.booking(admin, parts[2]!);
          const canWrite = adminService.can(admin, 'bookings.write');
          const kb: TgInlineKeyboard = [
            ...(canWrite && ['PENDING', 'CONFIRMED'].includes(b.status)
              ? [[
                  { text: '✅ تأكيد', callback_data: `a:bs:${b.ref}:CONFIRMED` },
                  { text: '🎉 إكمال', callback_data: `a:bs:${b.ref}:COMPLETED` },
                  { text: '🚫 عدم حضور', callback_data: `a:bs:${b.ref}:NO_SHOW` },
                ]]
              : []),
            ...(adminService.can(admin, 'bookings.cancel') && b.status !== 'CANCELLED' && b.status !== 'COMPLETED'
              ? [[{ text: '❌ إلغاء', callback_data: `a:bs:${b.ref}:CANCELLED` }]]
              : []),
            [{ text: '🔙 رجوع', callback_data: `a:bk:${b.status}:0` }],
          ];
          await deps.edit(c.chatId, c.messageId, {
            text: `${menus.bookingDetail(b, 'ar')}\n\n👤 المفتاح: ${b.contact_key}`,
            inline: kb,
          });
          return null;
        }
        case 'bs': {
          const b = adminService.setBookingStatus(admin, parts[2]!, parts[3] as BookingStatus);
          await deps.edit(c.chatId, c.messageId, this.bookingsScreen(admin, b.status === 'CANCELLED' || b.status === 'COMPLETED' || b.status === 'NO_SHOW' ? 'all' : b.status, 0));
          return { alert: `${b.ref} → ${bookingStatusText(b.status, 'ar')}` };
        }
        case 'od':
          await deps.edit(c.chatId, c.messageId, this.ordersScreen(admin, Number(parts[2] ?? 0)));
          return null;
        case 'tk':
          await deps.edit(c.chatId, c.messageId, this.ticketsScreen(admin, Number(parts[2] ?? 0)));
          return null;
        case 'sv':
          await deps.edit(c.chatId, c.messageId, this.servicesScreen(admin, Number(parts[2] ?? 0)));
          return null;
        case 'so': {
          const row = adminService.setServiceStatus(admin, parts[2]!, (parts[3] as 'active' | 'inactive') === 'active' ? 'active' : 'inactive');
          return { alert: `${row.slug} → ${row.status}` };
        }
        case 'st':
          await deps.edit(c.chatId, c.messageId, { text: this.staffText(admin), inline: adminMenuKeyboard() });
          return null;
        case 'lg':
          await deps.edit(c.chatId, c.messageId, { text: this.logsText(admin), inline: adminMenuKeyboard() });
          return null;
        case 'cu':
          await deps.edit(c.chatId, c.messageId, { text: this.customersText(admin), inline: adminMenuKeyboard() });
          return null;
      }
    } catch (err) {
      return { alert: err instanceof ServiceError ? err.message : (err as Error).message, popup: true };
    }
    return null;
  }

  // ───────────────────────── الشاشات النصية ─────────────────────────

  private menuText(admin: AdminRow): string {
    return [
      '🛠️ *لوحة إدارة مُريح*',
      `الدور: ${roleLabelAr(admin.role)}`,
      '',
      'الأزرار بالأسصفل، أو الأوامر النصية:',
      '• /admin stats — الإحصائيات',
      '• /admin bk [الحالة] — الحجوزات',
      '• /admin od — الطلبات · /admin tk — التذاكر',
      '• /admin sv — الخدمات · /admin cu — العملاء',
      '• /admin st — الموظفون · /admin lg — السجل',
      '• /take <key> — استلام محادثة · /resumeadmin <key>',
      '• /bkstatus و /ostatus و /tstatus لتغيير الحالات',
      '• /addstaff <id> <role> · /rmstaff <id>',
    ].join('\n');
  }

  private statsText(admin: AdminRow): string {
    const s = adminService.stats(admin);
    const bk = s.bookings;
    return [
      '📊 *الإحصائيات*',
      '',
      `👥 المستخدمون: ${s.users}`,
      `💬 المحادثات: ${s.conversations}`,
      `📋 الطلبات: ${s.orders} (تحويل ${s.conversionRate}%)`,
      `🗓️ الحجوزات — مؤكدة: ${bk.CONFIRMED}، قيد: ${bk.PENDING}، مكتملة: ${bk.COMPLETED}، ملغاة: ${bk.CANCELLED}، غياب: ${bk.NO_SHOW}`,
      `🎫 تذاكر مفتوحة: ${s.ticketsOpen}`,
      `🙋 تحويلات بشرية: ${s.handoffs}`,
      `⏱️ متوسط زمن الرد: ${s.avgResponseMs}ms`,
      `📈 معدل إلغاء الحجوزات: ${s.bookingCancellationRate}%`,
      '',
      'الخدمات الأكثر طلبًا:',
      ...s.topServices.map((x) => `• ${x.name || x.slug || '—'}: ${x.count}`),
      '',
      `آخر 24 ساعة: ${s.inbound24h} وارد / ${s.outbound24h} صادر`,
    ].join('\n');
  }

  private bookingsScreen(admin: AdminRow, status: BookingStatus | 'all', page: number): { text: string; inline: TgInlineKeyboard } {
    const { rows, total } = adminService.bookings(admin, { status, limit: PAGE, offset: page * PAGE });
    const filters: TgInlineButton[] = ['CONFIRMED', 'PENDING', 'COMPLETED', 'all'].map((f) => ({
      text: ({ CONFIRMED: '✅ مؤكدة', PENDING: '⏳ قيد', COMPLETED: '🎉 مكتملة', all: 'الكل' } as Record<string, string>)[f]!,
      callback_data: `a:bk:${f}:0`,
    }));
    const kb: TgInlineKeyboard = [];
    for (let i = 0; i < filters.length; i += 2) kb.push(filters.slice(i, i + 2));
    kb.push(...rows.map((b) => [{ text: `${b.ref} · ${b.slot_date} ${b.slot_time}`, callback_data: `a:bi:${b.ref}` }]));
    const nav: TgInlineButton[] = [];
    if (page > 0) nav.push({ text: '◀️', callback_data: `a:bk:${status}:${page - 1}` });
    if ((page + 1) * PAGE < total) nav.push({ text: '▶️', callback_data: `a:bk:${status}:${page + 1}` });
    if (nav.length) kb.push(nav);
    kb.push([{ text: '🔙 اللوحة', callback_data: 'a:menu' }]);
    const text = rows.length
      ? `🗓️ *الحجوزات (${status}) — ${total}*\n\n` + rows.map((b) => `${b.ref} · ${b.slot_date} (${dayName(b.slot_date, 'ar')}) ${b.slot_time} · ${bookingStatusText(b.status, 'ar' as UiLang)}\n${b.contact_key} · ${b.full_name ?? ''}`).join('\n\n')
      : 'لا توجد حجوزات في هذه الفئة.';
    return { text, inline: kb };
  }

  private ordersScreen(admin: AdminRow, page: number): { text: string; inline: TgInlineKeyboard } {
    const { rows, total } = adminService.orders(admin);
    const kb: TgInlineKeyboard = [];
    for (const o of rows) {
      kb.push([{ text: `${o.ref} · ${orderStatusText(o.status, 'ar' as UiLang)}`, callback_data: 'a:od:0' }]);
    }
    kb.push([{ text: '🔙 اللوحة', callback_data: 'a:menu' }]);
    return {
      text: `📋 *الطلبات — ${total}*\n\n` + (rows.length ? rows.map((o) => `${o.ref} · ${orderStatusText(o.status, 'ar' as UiLang)}\n${o.summary.slice(0, 120)}`).join('\n\n') : 'لا طلبات.'),
      inline: kb,
    };
  }

  private ticketsScreen(admin: AdminRow, _page: number): { text: string; inline: TgInlineKeyboard } {
    const { rows, total } = adminService.tickets(admin);
    return {
      text: `🎫 *التذاكر — ${total} مفتوحة*\n\n` + (rows.length ? rows.map((x) => `${x.ref} [${x.priority}] ${x.status}\n${x.restaurant_name ?? '—'}: ${x.issue.slice(0, 140)}`).join('\n\n') : 'لا تذاكر.'),
      inline: [[{ text: '🔙 اللوحة', callback_data: 'a:menu' }]],
    };
  }

  private servicesScreen(admin: AdminRow, _page: number): { text: string; inline: TgInlineKeyboard } {
    const services = adminService.services(admin);
    const kb: TgInlineKeyboard = services.map((s) => [{
      text: `${s.status === 'active' ? '🟢' : '🔴'} ${s.name_ar}`,
      callback_data: `a:so:${s.slug}:${s.status === 'active' ? 'inactive' : 'active'}`,
    }]);
    kb.push([{ text: '🔙 اللوحة', callback_data: 'a:menu' }]);
    return {
      text: '🛎️ *الخدمات* (زر لتفعيل/إيقاف)\n' + services.map((s) => `${s.status === 'active' ? '🟢' : '🔴'} ${s.name_ar} — ${s.price === null ? 'حسب الطلب' : `${s.price} ₪`} (${s.slug})`).join('\n'),
      inline: kb,
    };
  }

  private staffText(admin: AdminRow): string {
    const rows = adminService.staffList(admin);
    return '🧑‍💼 *الموظفون*\n\n' + rows.map((r) => `${r.is_active ? '🟢' : '⚫'} ${roleLabelAr(r.role)} — ${r.telegram_id} (${r.username ?? r.display_name ?? '—'})`).join('\n');
  }

  private customersText(admin: AdminRow): string {
    const rows = adminService.customers(admin);
    return '👥 *آخر العملاء*\n\n' + (rows.length
      ? rows.map((c) => `${c.restaurant_name ?? c.full_name ?? '—'} (${c.contact_key}) · طاولات: ${c.tables ?? '—'} · باقة: ${c.preferred_plan ?? '—'}`).join('\n')
      : 'لا عملاء بعد.');
  }

  private logsText(admin: AdminRow): string {
    const rows = adminService.auditLog(admin, 20);
    const lines = rows.map((r) => {
      const d = new Date(Number(r.created_at)).toLocaleString('ar', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
      return `${d} · ${r.actor_type}:${r.actor_id ?? ''} → ${r.action} ${r.entity ? `(${r.entity}:${r.entity_id})` : ''}`;
    });
    return '📜 *آخر 20 حدثًا في سجل التدقيق*\n\n' + (lines.length ? lines.join('\n') : 'السجل فارغ.');
  }

  private async usage(chatId: string, text: string): Promise<boolean> {
    await deps.send(chatId, { text: `الصيغة: ${text}` });
    return true;
  }
}

/** إرجاع محادثة للبوت من زر الموظف في اللوحة (مستخدم أيضًا من مسارات أخرى) */
export function resumeConversation(key: string): void {
  handoffService.resume(key);
  store.setState(key, 'bot', '🤖 إرجاع آلي بقرار موظف');
}
