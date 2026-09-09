import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log, uid } from '../lib/utils.js';
import { getPlan, MUREEH_PLANS, recommendPlan, type PlanId } from './plans.js';

/**
 * أدوات البوت الخاصة بمنصة مُريح (Function Calling).
 *
 * الأدوات الأربع:
 *  1. get_plan_details          — تفاصيل باقة بالأسعار الدقيقة (من src/agent/plans.ts)
 *  2. recommend_plan            — توصية حتمية بالباقة حسب الطاولات والاحتياجات
 *  3. capture_subscription_lead — تسجيل ليد اشتراك + حفظ data/leads.json + تنبيه الفريق
 *  4. create_support_ticket     — فتح تذكرة دعم للمشتركين + حفظ data/tickets.json + تنبيه
 *
 * للتكامل مع نظام حقيقي: استبدل جسم كل دالة بنداء API — التوقيعات ثابتة.
 */

export interface ToolContext {
  sessionKey: string;
  customerName: string;
  /** رقم رسالة واتساب للرد/الربط */
  replyTo?: string;
}

export interface ToolResult {
  ok: boolean;
  /** ما يُرجَع للنموذج كنص */
  data: unknown;
  /** رسالة تُعرض على العميل مباشرة (اختياري) */
  userMessage?: string;
  /** إجراء جانبي يطلبه المنفّذ (مثل تنبيه الموظف) */
  sideEffect?: {
    kind: 'send_media' | 'notify_human';
    payload: Record<string, unknown>;
  };
}

// ─────────────────────── تعريفات للدوال لـ Gemini ───────────────────────

export const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'get_plan_details',
        description:
          'جلب تفاصيل باقة من باقات منصة مُريح بالأسعار الرسمية الدقيقة. استخدمها عندما يسأل العميل عن سعر/مزايا باقة محددة (الأساسية / الاحترافية / المؤسسات).',
        parameters: {
          type: 'OBJECT',
          properties: {
            plan_id: {
              type: 'STRING',
              enum: ['starter', 'pro', 'enterprise'],
              description:
                'starter = الباقة الأساسية، pro = الباقة الاحترافية، enterprise = باقة المؤسسات والسلاسل',
            },
            billing: {
              type: 'STRING',
              enum: ['monthly', 'yearly'],
              description: 'فترة الدفع المطلوبة (اختياري، الافتراضي monthly)',
            },
          },
          required: ['plan_id'],
        },
      },
      {
        name: 'recommend_plan',
        description:
          'توصية بالباقة الأنسب لمطعم العميل حسب عدد الطاولات واحتياجاته. استخدمها عندما يعرف العميل عدد طاولاته أو مزاياه المطلوبة ولم يحسم باقة بعد.',
        parameters: {
          type: 'OBJECT',
          properties: {
            tables: {
              type: 'NUMBER',
              description: 'عدد الطاولات في المطعم (اختياري إن لم يذكر العميل)',
            },
            needs: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description:
                'احتياجات العميل بكلمات قصيرة (مثال: ["شاشة مطبخ","هوية بصرية"] أو ["فروع متعددة"])',
            },
          },
          required: [],
        },
      },
      {
        name: 'capture_subscription_lead',
        description:
          'تسجيل طلب تفعيل اشتراك جديد. استدعِها فقط عندما يقرّر العميل الاشتراك فعليًا وبعد جمع البيانات المطلوبة. لا تستدعِها للاستفسارات العامة.',
        parameters: {
          type: 'OBJECT',
          properties: {
            full_name: { type: 'STRING', description: 'اسم العميل الكامل' },
            restaurant_name: { type: 'STRING', description: 'اسم المطعم/المقهى' },
            city: { type: 'STRING', description: 'مدينة المطعم' },
            tables: { type: 'NUMBER', description: 'عدد الطاولات' },
            preferred_plan: {
              type: 'STRING',
              enum: ['starter', 'pro', 'enterprise'],
              description: 'الباقة المختارة',
            },
            whatsapp_number: { type: 'STRING', description: 'رقم واتساب للتواصل (رقم العميل في الجلسة إن لم يذكر)' },
          },
          required: ['full_name', 'restaurant_name', 'city', 'tables', 'preferred_plan', 'whatsapp_number'],
        },
      },
      {
        name: 'create_support_ticket',
        description:
          'فتح تذكرة دعم لمشترك لديه مشكلة تقنية أو شكوى. استخدمها عندما يكون العميل مشترَكًا بالفعل وواجه مشكلة في المنصة، أو عند أي شكوى جدية.',
        parameters: {
          type: 'OBJECT',
          properties: {
            restaurant_name: { type: 'STRING', description: 'اسم مطعم العميل' },
            plan: { type: 'STRING', description: 'باقة العميل إن عُرفت (اختياري)' },
            issue: { type: 'STRING', description: 'وصف المشكلة كما رآها العميل' },
            priority: {
              type: 'STRING',
              enum: ['low', 'normal', 'high', 'urgent'],
              description:
                'urgent = النظام متوقف تمامًا عن العمل، high = مشكلة حرجة تؤثر على الخدمة، normal = مشكلة عادية، low = استفسار/اقتراح',
            },
          },
          required: ['restaurant_name', 'issue', 'priority'],
        },
      },
    ],
  },
];

// ─────────────────────── حفظ ليدز/تذاكر (JSON ذرّي) ───────────────────────

async function appendJsonFile(name: 'leads' | 'tickets', record: Record<string, unknown>): Promise<void> {
  const file = path.join(config.paths.DATA_DIR, `${name}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let all: Record<string, unknown>[] = [];
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) all = parsed;
  } catch {
    /* أول تسجيل */
  }
  all.push(record);

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

// ─────────────────────── التنفيذ ───────────────────────

type Handler = (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

export const TOOL_HANDLERS: Record<string, Handler> = {
  /** تفاصيل باقة بالأسعار الرسمية (دائمًا من plans.ts) */
  get_plan_details(args) {
    const id = (['starter', 'pro', 'enterprise'].includes(args.plan_id) ? args.plan_id : 'pro') as PlanId;
    const billing = args.billing === 'yearly' ? 'yearly' : 'monthly';
    const plan = getPlan(id);

    const lines = [
      `*${plan.name}*${plan.mostPopular ? ' ← الأكثر طلبًا' : ''} — ${plan.tagline}`,
      billing === 'monthly'
        ? `السعر: *${plan.priceMonthly} ₪/شهر*`
        : `السعر السنوي: *${plan.priceYearly} ₪* دفعة واحدة (≈ ${plan.priceYearlyPerMonth} ₪/شهر)`,
    ];
    if (billing === 'monthly') {
      lines.push(`ولو دفعت سنوي: ${plan.priceYearlyPerMonth} ₪/شهر — توفير *${plan.yearlySavings} ₪* (~17%)`);
    }
    lines.push('المزايا:');
    for (const f of plan.features) lines.push(`• ${f}`);
    lines.push('تبيني أجهّز لك التفعيل، أو تبي باقة ثانية؟');

    log.tool(`get_plan_details → ${id} (${billing})`);
    return { ok: true, data: { plan: plan.id, billing, price: plan[billing === 'monthly' ? 'priceMonthly' : 'priceYearly'] }, userMessage: lines.join('\n') };
  },

  /** توصية حتمية بالباقة */
  recommend_plan(args) {
    const tables = typeof args.tables === 'number' && args.tables > 0 ? Math.round(args.tables) : undefined;
    const needs = Array.isArray(args.needs) ? args.needs.map(String) : [];
    const rec = recommendPlan({ tables, needs });
    const p = rec.plan;

    log.tool(`recommend_plan → ${p.id} (tables=${tables ?? '?'}, needs=${needs.join(',') || '—'})`);

    return {
      ok: true,
      data: { recommended: p.id, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, reason: rec.reason },
      userMessage: [
        `أنسب باقة لحالتك: *${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' ← الأكثر طلبًا' : ''}`,
        rec.reason + '.',
        `ولو سنوي: ${p.priceYearlyPerMonth} ₪/شهر — توفير *${p.yearlySavings} ₪*، والترقية من اللوحة في أي وقت.`,
        'تبيني أجهّز لك التفعيل؟',
      ].join('\n'),
    };
  },

  /** تسجيل ليد اشتراك جديد */
  async capture_subscription_lead(args, ctx) {
    const lead = {
      ref: `SUB-${uid('').slice(-6).toUpperCase()}`,
      full_name: String(args.full_name ?? 'غير مذكور'),
      restaurant_name: String(args.restaurant_name ?? 'غير مذكور'),
      city: String(args.city ?? 'غير مذكورة'),
      tables: args.tables ?? null,
      preferred_plan: String(args.preferred_plan ?? 'غير محددة'),
      whatsapp_number: String(args.whatsapp_number ?? ctx.sessionKey),
      sessionKey: ctx.sessionKey,
      customer_name_profile: ctx.customerName || null,
      created_at: new Date().toISOString(),
    };

    await appendJsonFile('leads', lead);
    log.tool(`capture_subscription_lead → ${lead.ref} | ${lead.full_name} | ${lead.restaurant_name} (${lead.city}) | ${lead.tables} طاولة | ${lead.preferred_plan}`);

    const planName =
      MUREEH_PLANS.find((p) => p.id === lead.preferred_plan)?.name ?? lead.preferred_plan;

    return {
      ok: true,
      data: lead,
      userMessage:
        `يا سلام، سجّلت طلب التفعيل ✅ الرقم: *${lead.ref}*\n` +
        `*${lead.restaurant_name}* — ${lead.city} · ${lead.tables} طاولة · *${planName}*\n\n` +
        `الفريق يتواصل معك الآن لاستكمال التجهيز — خلال دقائق عادة وبدون بطاقة ائتمانية للبدء 🚀`,
      sideEffect: {
        kind: 'notify_human',
        payload: {
          note:
            `💼 *ليد اشتراك جديد* ${lead.ref}\n` +
            `العميل: ${lead.full_name} — ${lead.whatsapp_number}\n` +
            `المطعم: ${lead.restaurant_name} (${lead.city}) · ${lead.tables} طاولة\n` +
            `الباقة: ${planName}`,
        },
      },
    };
  },

  /** تذكرة دعم للمشتركين */
  async create_support_ticket(args, ctx) {
    const ticket = {
      ref: `TCK-${uid('').slice(-6).toUpperCase()}`,
      restaurant_name: String(args.restaurant_name ?? 'غير مذكور'),
      plan: args.plan ?? null,
      issue: String(args.issue ?? ''),
      priority: String(args.priority ?? 'normal'),
      sessionKey: ctx.sessionKey,
      customer_name_profile: ctx.customerName || null,
      created_at: new Date().toISOString(),
    };

    await appendJsonFile('tickets', ticket);
    log.tool(`create_support_ticket → ${ticket.ref} | ${ticket.restaurant_name} | [${ticket.priority}] ${ticket.issue.slice(0, 60)}`);

    const prioAr: Record<string, string> = {
      urgent: 'عاجلة (الخدمة متوقفة)',
      high: 'عالية',
      normal: 'عادية',
      low: 'منخفضة',
    };

    return {
      ok: true,
      data: ticket,
      userMessage:
        `فتحت لك متابعة فورية برقم *${ticket.ref}* (أولوية: ${prioAr[ticket.priority] ?? 'عادية'}).\n` +
        `زميلي من الدعم يكمل معك قريبًا. أنا آسف على الإزعاج، وبنحلّها.`,
      sideEffect: {
        kind: 'notify_human',
        payload: {
          note:
            `️ *تذكرة دعم جديدة* ${ticket.ref}\n` +
            `المطعم: ${ticket.restaurant_name}${ticket.plan ? ` (${ticket.plan})` : ''}\n` +
            `الأولوية: ${ticket.priority}\n` +
            `المشكلة: ${ticket.issue.slice(0, 200)}`,
        },
      },
    };
  },
};

/** تنفيذ دالة بأمان مع التقاط أي خطأ */
export async function runTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!config.bot.TOOLS_ENABLED) {
    return { ok: false, data: { error: 'الأدوات معطّلة في الإعدادات' } };
  }

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { ok: false, data: { error: `دالة غير معروفة: ${name}` } };
  }

  try {
    return await handler(args ?? {}, ctx);
  } catch (err) {
    log.error(`فشل تنفيذ الأداة ${name}: ${(err as Error).message}`);
    return { ok: false, data: { error: (err as Error).message } };
  }
}

/** أسماء الأدوات المتاحة (للسجلات ولوحة التحكم) */
export const TOOL_NAMES = Object.keys(TOOL_HANDLERS);
