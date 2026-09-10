import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log, uid } from '../lib/utils.js';
import { store } from '../lib/store.js';
import { getPlan, MUREEH_PLANS, perTableMonthly, recommendPlan, type PlanId } from './plans.js';
import {
  buildBlueprintText,
  isProfileReady,
  managerOrderMessage,
  missingRequired,
  nextQuestion,
  orderSummaryLine,
} from './onboarding.js';
import {
  availability,
  availableSlotsForDate,
  bookingStore,
  bookingSummary,
  checkSlot,
  formatAvailabilityText,
  nextAvailableDays,
  serviceName,
} from './bookings.js';
import type { RestaurantProfile } from '../types.js';

/**
 * أدوات البوت الخاصة بمنصة مُريح (Function Calling).
 *
 * الأدوات:
 *  1. get_plan_details       — تفاصيل باقة بالأسعار الدقيقة (من src/agent/plans.ts)
 *  2. recommend_plan         — توصية حتمية بالباقة حسب الطاولات والاحتياجات
 *  3. save_restaurant_profile — حفظ تفاصيل المطعم تدريجيًا في ملف الجلسة
 *  4. build_launch_blueprint — بناء التصور الكامل الجاهز للإطلاق من الملف
 *  5. confirm_launch_order   — تأكيد الطلب + إرساله لمدير المنصة + تحويل المحادثة
 *  6. create_support_ticket  — فتح تذكرة دعم للمشتركين + حفظ data/tickets.json + تنبيه
 *  (capture_subscription_lead أُبقيت للتوافق فقط ولا تُعرض على النموذج)
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
    kind: 'send_media' | 'notify_human' | 'notify_manager';
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
        name: 'save_restaurant_profile',
        description:
          'حفظ تفاصيل المطعم التي ذكرها العميل (اسم، مطعم، مدينة، فروع، طاولات، باقة، أصناف، شعار). استدعِها كلما ذكر العميل أي تفصيلة — كل الحقول اختيارية وتُدمج مع السابق. لا تسأل عن كل الحقول دفعة واحدة؛ سؤال واحد فقط في كل رد.',
        parameters: {
          type: 'OBJECT',
          properties: {
            full_name: { type: 'STRING', description: 'اسم العميل' },
            restaurant_name: { type: 'STRING', description: 'اسم المطعم/المقهى' },
            city: { type: 'STRING', description: 'مدينة المطعم' },
            branches: { type: 'NUMBER', description: 'عدد الفروع (1 لو فرع واحد)' },
            tables: { type: 'NUMBER', description: 'عدد الطاولات' },
            preferred_plan: {
              type: 'STRING',
              enum: ['starter', 'pro', 'enterprise'],
              description: 'الباقة المختارة: starter=الأساسية، pro=الاحترافية، enterprise=المؤسسات',
            },
            menu_items: { type: 'NUMBER', description: 'عدد أصناف المنيو التقريبي' },
            has_logo: { type: 'BOOLEAN', description: 'هل الشعار/الهوية جاهزان عند العميل؟' },
            notes: { type: 'STRING', description: 'أي ملاحظات إضافية ذكرها العميل' },
          },
          required: [],
        },
      },
      {
        name: 'build_launch_blueprint',
        description:
          'بناء «التصور الكامل الجاهز للإطلاق» من ملف المطعم المحفوظ (التجهيزات + السعر + خطوات الإطلاق). استدعِها فقط عندما يكتمل الملف الأساسي (الاسم، المطعم، المدينة، الطاولات، الباقة). اعرض نتيجتها على العميل كما هي ثم اطلب تأكيد الطلب.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'confirm_launch_order',
        description:
          'تأكيد طلب الإطلاق وإرسال الملف الكامل لمدير المنصة وتحويل المحادثة إليه. استدعِها فقط بعد أن عرضت التصور على العميل ووافق عليه صراحة (نعم/أكيد/تم/أكّد). لا تستدعِها أبدًا قبل عرض التصور.',
        parameters: {
          type: 'OBJECT',
          properties: {
            confirmed: { type: 'BOOLEAN', description: 'تأكيد العميل الصريح (يجب أن يكون true)' },
            notes: { type: 'STRING', description: 'ملاحظات أخيرة قبل الإرسال لمدير المنصة (اختياري)' },
          },
          required: ['confirmed'],
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
      {
        name: 'get_menu',
        description:
          'جلب قائمة المنتجات/الخدمات بالأسعار الرسمية (باقات الاشتراك الثلاث: الأساسية/الاحترافية/المؤسسات). استخدمها عندما يسأل العميل «وش عندكم؟» أو يريد رؤية كل الخيارات والأسعار دفعة واحدة.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_restaurant_info',
        description:
          'جلب معلومات النشاط الرسمية: الاسم، القنوات، ساعات عمل فريق الحجز/التفعيل. استخدمها عندما يسأل العميل عن ساعات العمل أو طرق التواصل أو معلومات عامة عن النشاط.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_customer',
        description:
          'جلب بيانات العميل المحفوظة في الجلسة (الاسم، المطعم، المدينة، الطاولات، الباقة) مع حجوزاته النشطة. استخدمها قبل سؤال العميل عن بيانات سبق ذكرها، أو عندما يسأل عن حالة حجوزه.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'check_availability',
        description:
          'التحقق من المواعيد المتاحة للحجز في تاريخ محدد (YYYY-MM-DD). أرجع الفتحات المتاحة فعلًا بعد خصم الإشغال. إن لم يحدد العميل تاريخًا، أرجع أقرب الأيام المتاحة. استخدمها دائمًا قبل عرض أي موعد أو تأكيد حجز — ولا تعرض موعدًا من عندك أبدًا.',
        parameters: {
          type: 'OBJECT',
          properties: {
            date: {
              type: 'STRING',
              description: 'التاريخ المطلوب بصيغة YYYY-MM-DD (اختياري — إن تُرك فارغًا تُرجع أقرب الأيام المتاحة)',
            },
            time: {
              type: 'STRING',
              description: 'وقت محدد بصيغة HH:MM للتحقق من فتحة معينة (اختياري)',
            },
          },
          required: [],
        },
      },
      {
        name: 'create_booking',
        description:
          'إنشاء حجز (موعد تفعيل) للعميل بعد التأكد من التوفر. لا تستدعِها إلا بعد جمع: الباقة (الخدمة) + التاريخ + الوقت، وبعد نجاح check_availability. لا تؤكد للعميل أي حجز قبل نجاح هذه الأداة. اسم العميل/المطعم/المدينة/الطاولات تُؤخذ من ذاكرة الجلسة إن وُجدت.',
        parameters: {
          type: 'OBJECT',
          properties: {
            service: {
              type: 'STRING',
              enum: ['starter', 'pro', 'enterprise'],
              description: 'الباقة المحجوزة (الخدمة): starter=الأساسية، pro=الاحترافية، enterprise=المؤسسات',
            },
            date: { type: 'STRING', description: 'تاريخ الحجز بصيغة YYYY-MM-DD' },
            time: { type: 'STRING', description: 'وقت الحجز بصيغة HH:MM' },
            full_name: { type: 'STRING', description: 'اسم العميل (اختياري إن كان محفوظًا في الجلسة)' },
            restaurant_name: { type: 'STRING', description: 'اسم المطعم (اختياري)' },
            city: { type: 'STRING', description: 'المدينة (اختياري)' },
            tables: { type: 'NUMBER', description: 'عدد الطاولات (اختياري)' },
            notes: { type: 'STRING', description: 'ملاحظات خاصة (اختياري)' },
          },
          required: ['service', 'date', 'time'],
        },
      },
      {
        name: 'update_booking',
        description:
          'تعديل حجز موجود (التاريخ/الوقت/الباقة/الملاحظات). حدد الحجز بمعرّفه booking_ref أو استخدم آخر حجز نشط للعميل. تحقق من التوفر الجديد أولًا بأداة check_availability قبل التعديل. لا تقل «تم التعديل» إلا بعد نجاح الأداة.',
        parameters: {
          type: 'OBJECT',
          properties: {
            booking_ref: { type: 'STRING', description: 'معرّف الحجز BKG-XXXXXX (اختياري — يُستخدم آخر حجز نشط إن تُرك فارغًا)' },
            service: {
              type: 'STRING',
              enum: ['starter', 'pro', 'enterprise'],
              description: 'الباقة الجديدة (اختياري)',
            },
            date: { type: 'STRING', description: 'التاريخ الجديد بصيغة YYYY-MM-DD (اختياري)' },
            time: { type: 'STRING', description: 'الوقت الجديد بصيغة HH:MM (اختياري)' },
            notes: { type: 'STRING', description: 'ملاحظات محدّثة (اختياري)' },
          },
          required: [],
        },
      },
      {
        name: 'cancel_booking',
        description:
          'إلغاء حجز موجود. حدد الحجز بمعرّفه booking_ref أو استخدم آخر حجز نشط للعميل. اسأل العميل عن السبب بلطف قبل الإلغاء. لا تقل «تم الإلغاء» إلا بعد نجاح الأداة.',
        parameters: {
          type: 'OBJECT',
          properties: {
            booking_ref: { type: 'STRING', description: 'معرّف الحجز BKG-XXXXXX (اختياري — يُستخدم آخر حجز نشط إن تُرك فارغًا)' },
            reason: { type: 'STRING', description: 'سبب الإلغاء (اختياري — مفيد لتقليل التكرار وتحسين الخدمة)' },
          },
          required: [],
        },
      },
      {
        name: 'send_notification',
        description:
          'إرسال تنبيه داخلي للموظف البشري/مدير المنصة (لا يظهر نصه للعميل). استخدمها عند حجز/تعديل/إلغاء مهم، أو عند حالة تحتاج متابعة بشرية فورية. لا تستخدمها إلا لتنبيه الفريق بأمر يتطلب تدخلًا بشريًا.',
        parameters: {
          type: 'OBJECT',
          properties: {
            message: { type: 'STRING', description: 'نص التنبيه الداخلي للفريق' },
            to: {
              type: 'STRING',
              enum: ['manager', 'human'],
              description: 'جهة التنبيه: manager=مدير المنصة، human=الموظف البشري المناوب',
            },
            priority: {
              type: 'STRING',
              enum: ['low', 'normal', 'high', 'urgent'],
              description: 'أولوية التنبيه (اختياري، الافتراضي normal)',
            },
          },
          required: ['message'],
        },
      },
    ],
  },
];

// ─────────────────────── حفظ ليدز/تذاكر (JSON ذرّي) ───────────────────────

async function appendJsonFile(name: 'leads' | 'tickets' | 'orders', record: Record<string, unknown>): Promise<void> {
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
        ? `السعر: *${plan.priceMonthly} ₪/شهر* — ثابت مهما زادت طلباتك، وبدون رسوم مخفية`
        : `السعر السنوي: *${plan.priceYearly} ₪* دفعة واحدة (≈ ${plan.priceYearlyPerMonth} ₪/شهر)`,
    ];
    if (billing === 'monthly') {
      lines.push(`ولو دفعت سنوي: ${plan.priceYearlyPerMonth} ₪/شهر — توفير *${plan.yearlySavings} ₪* (~17%)`);
    }
    lines.push('وش تحصل عليه:');
    for (const f of plan.features) lines.push(`• ${f}`);
    lines.push('تبيني أجهّز لك التفعيل على هذي الباقة؟');

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

    const perTable = tables ? `، يعني ~*${perTableMonthly(p, tables)} ₪* بس للطاولة الواحدة` : '';
    return {
      ok: true,
      data: { recommended: p.id, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, reason: rec.reason },
      userMessage: [
        `أنسب باقة لحالتك: *${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' ← الأكثر طلبًا' : ''}${perTable}`,
        rec.reason + '.',
        `ولو سنوي: ${p.priceYearlyPerMonth} ₪/شهر — توفير *${p.yearlySavings} ₪*، وبدون بطاقة للبدء، والترقية من اللوحة بأي وقت.`,
        'تبيني أجهّز لك التفعيل؟',
      ].join('\n'),
    };
  },

  /** @deprecated استُبدلت بمسار التجهيز للإطلاق (profile→blueprint→confirm). تُبقى للتوافق الخلفي فقط. */
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

    // تثبيت بيانات العميل في ملف الجلسة والذاكرة الدائمة
    store.patchProfile(ctx.sessionKey, {
      full_name: lead.full_name !== 'غير مذكور' ? lead.full_name : undefined,
      restaurant_name: lead.restaurant_name !== 'غير مذكور' ? lead.restaurant_name : undefined,
      city: lead.city !== 'غير مذكورة' ? lead.city : undefined,
      tables: typeof lead.tables === 'number' && lead.tables > 0 ? lead.tables : undefined,
      preferred_plan: ['starter', 'pro', 'enterprise'].includes(lead.preferred_plan) ? (lead.preferred_plan as PlanId) : undefined,
    });
    store.patchLaunch(ctx.sessionKey, {
      status: 'confirmed',
      orderRef: lead.ref,
      confirmedAt: Date.now(),
    });

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

  /** حفظ/دمج تفاصيل المطعم في ملف الجلسة — خطوة بخطوة */
  save_restaurant_profile(args, ctx) {
    const patch: Partial<RestaurantProfile> = {};
    if (typeof args.full_name === 'string' && args.full_name.trim()) patch.full_name = args.full_name.trim().slice(0, 60);
    if (typeof args.restaurant_name === 'string' && args.restaurant_name.trim()) patch.restaurant_name = args.restaurant_name.trim().slice(0, 80);
    if (typeof args.city === 'string' && args.city.trim()) patch.city = args.city.trim().slice(0, 60);
    if (typeof args.branches === 'number' && args.branches > 0) patch.branches = Math.min(500, Math.round(args.branches));
    if (typeof args.tables === 'number' && args.tables > 0) patch.tables = Math.min(2000, Math.round(args.tables));
    if (['starter', 'pro', 'enterprise'].includes(args.preferred_plan)) patch.preferred_plan = args.preferred_plan;
    if (typeof args.menu_items === 'number' && args.menu_items > 0) patch.menu_items = Math.min(10000, Math.round(args.menu_items));
    if (typeof args.has_logo === 'boolean') patch.has_logo = args.has_logo;
    if (typeof args.notes === 'string' && args.notes.trim()) patch.notes = args.notes.trim().slice(0, 500);
    if (!ctx.sessionKey.startsWith('tg:')) patch.whatsapp_number = ctx.sessionKey;
    else if (typeof args.whatsapp_number === 'string' && args.whatsapp_number.trim()) patch.whatsapp_number = args.whatsapp_number.trim();

    const profile = store.patchProfile(ctx.sessionKey, patch);
    store.patchLaunch(ctx.sessionKey, { status: 'collecting' });
    const missing = missingRequired(profile);
    const ready = missing.length === 0;

    log.tool(`save_restaurant_profile → ${ctx.sessionKey} | ناقص: ${missing.join(',') || 'لا شيء — جاهز ✅'}`);

    return {
      ok: true,
      data: {
        profile,
        missing,
        next_question: nextQuestion(profile),
        ready_for_blueprint: ready,
      },
    };
  },

  /** بناء التصور الكامل الجاهز للإطلاق من الملف المحفوظ */
  build_launch_blueprint(_args, ctx) {
    const session = store.get(ctx.sessionKey);
    const profile = session.profile ?? {};

    if (!isProfileReady(profile)) {
      const missing = missingRequired(profile);
      log.tool(`build_launch_blueprint → ناقص: ${missing.join(',')}`);
      return {
        ok: false,
        data: { missing, next_question: nextQuestion(profile) },
        userMessage: '',
      };
    }

    const blueprint = buildBlueprintText(profile);
    store.patchLaunch(ctx.sessionKey, { status: 'awaiting_confirmation', blueprint });
    log.tool(`build_launch_blueprint → ${ctx.sessionKey} | ${profile.restaurant_name} (${profile.city})`);

    return {
      ok: true,
      data: { blueprint, ready: true },
      userMessage:
        blueprint +
        '\n\nهذا تصور نسختك كاملًا 👆 راجعه، ولو كل شيء تمام اضغط *تأكيد الطلب* — وأي تعديل اكتبه لي وأنا أظبطه فورًا.',
    };
  },

  /** تأكيد الطلب: حفظ + إرسال الملف الكامل لمدير المنصة + تحويل المحادثة */
  async confirm_launch_order(args, ctx) {
    const session = store.get(ctx.sessionKey);
    const profile = session.profile ?? {};

    if (args.confirmed !== true) {
      return { ok: false, data: { error: 'لم يؤكد العميل بعد — اعرض التصور واطلب التأكيد الصريح أولًا' } };
    }
    if (!isProfileReady(profile)) {
      return {
        ok: false,
        data: { error: 'الملف ناقص', missing: missingRequired(profile), next_question: nextQuestion(profile) },
      };
    }
    if (session.launch?.status === 'confirmed' && session.launch.orderRef) {
      return { ok: true, data: { order_ref: session.launch.orderRef, duplicate: true } };
    }

    if (typeof args.notes === 'string' && args.notes.trim()) {
      store.patchProfile(ctx.sessionKey, { notes: args.notes.trim().slice(0, 500) });
    }

    const orderRef = `ORD-${uid('').slice(-6).toUpperCase()}`;
    store.patchLaunch(ctx.sessionKey, { status: 'confirmed', orderRef, confirmedAt: Date.now() });

    const record = {
      ref: orderRef,
      ...store.get(ctx.sessionKey).profile,
      sessionKey: ctx.sessionKey,
      customer_name_profile: ctx.customerName || null,
      summary: orderSummaryLine(store.get(ctx.sessionKey).profile ?? {}, orderRef),
      created_at: new Date().toISOString(),
    };
    await appendJsonFile('orders', record);
    log.tool(`confirm_launch_order → ${orderRef} | ${record.summary}`);

    const managerNote = managerOrderMessage(store.get(ctx.sessionKey).profile ?? {}, orderRef, ctx.sessionKey);

    return {
      ok: true,
      data: { order_ref: orderRef, summary: record.summary },
      userMessage:
        `تم تأكيد طلبك ✅ رقم الطلب: *${orderRef}*\n` +
        `ملفك الكامل وصل *مدير المنصة* — يتواصل معك ويجهز نسختك، خلال دقائق عادة وبدون بطاقة للبدء 🚀\n` +
        `المحادثة الآن معه مباشرة، وأنا هنا لو احتجتني بعدين.`,
      sideEffect: { kind: 'notify_manager', payload: { note: managerNote, orderRef } },
    };
  },

  // ─────────────────────── نظام الحجوزات (مواعيد التفعيل) ───────────────────────

  /** قائمة المنتجات/الخدمات (الباقات) بالأسعار الرسمية */
  get_menu() {
    const lines = ['*باقاتنا الثلاث* — كلها بدون عقود وبدون رسوم مخفية:'];
    for (const p of MUREEH_PLANS) {
      lines.push(`• *${p.name}* — *${p.priceMonthly} ₪/شهر*${p.mostPopular ? ' ← الأكثر طلبًا' : ''}`);
    }
    lines.push('الدفع السنوي يوفّر شهرين كاملين مجانًا، ويمكن الترقية أو الإلغاء بأي وقت.');
    log.tool('get_menu → 3 باقات');
    return {
      ok: true,
      data: {
        services: MUREEH_PLANS.map((p) => ({
          id: p.id,
          name: p.name,
          priceMonthly: p.priceMonthly,
          priceYearly: p.priceYearly,
        })),
      },
      userMessage: lines.join('\n'),
    };
  },

  /** معلومات النشاط الرسمية (هوية + قنوات + ساعات عمل فريق الحجز) */
  get_restaurant_info() {
    const lines = [
      '*منصة مُريح* — نظام إدارة مطاعم ومقاهٍ سحابي (منيو QR، شاشة مطبخ حية، كاشير، تحليلات).',
      '💬 تيليجرام المبيعات والدعم: +972 599 891 559',
      `⏰ ساعات عمل فريق الحجز والتفعيل: ${formatAvailabilityText()}`,
      '🤖 هذا البوت يرد عليك 24/7، والمتابعة البشرية خلال ساعات العمل.',
    ];
    log.tool('get_restaurant_info');
    return {
      ok: true,
      data: {
        name: config.bot.BUSINESS_NAME,
        channels: 'telegram +972599891559',
        working_hours: formatAvailabilityText(),
        timezone: availability().timezone,
      },
      userMessage: lines.join('\n'),
    };
  },

  /** بيانات العميل المحفوظة + حجوزاته النشطة */
  get_customer(_args, ctx) {
    const session = store.get(ctx.sessionKey);
    const p = session.profile ?? {};
    const bookings = bookingStore.bySession(ctx.sessionKey).filter((b) => b.status === 'confirmed');

    const facts: string[] = [];
    if (p.full_name) facts.push(`الاسم: ${p.full_name}`);
    if (p.restaurant_name) facts.push(`المطعم: ${p.restaurant_name}`);
    if (p.city) facts.push(`المدينة: ${p.city}`);
    if (p.tables) facts.push(`الطاولات: ${p.tables}`);
    if (p.preferred_plan) facts.push(`الباقة: ${serviceName(p.preferred_plan)}`);

    const bLines = bookings.map((b) => `• ${b.ref} — ${b.date} ${b.time} — ${serviceName(b.service)}`);
    log.tool(`get_customer → ${ctx.sessionKey} | حجوزات نشطة: ${bookings.length}`);

    return {
      ok: true,
      data: {
        profile: p,
        active_bookings: bookings.map((b) => ({ ref: b.ref, date: b.date, time: b.time, service: b.service })),
      },
      userMessage: [
        facts.length ? `بياناتك المسجلة عندي:\n${facts.join('\n')}` : 'لسا ما عندي تفاصيل كثيرة عنك — أول ما نكمّل الحجز بسجّلها.',
        bookings.length
          ? `حجوزاتك النشطة:\n${bLines.join('\n')}`
          : 'ما عندك حجوزات نشطة حاليًا.',
      ].join('\n\n'),
    };
  },

  /** التحقق من التوفر (فتحات فعلية بعد خصم الإشغال) */
  check_availability(args) {
    const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : '';

    // تاريخ محدد
    if (date) {
      const res = availableSlotsForDate(date);
      if (!res.ok) {
        return {
          ok: false,
          data: { date, day: res.dayName, reason: res.reason },
          userMessage: `${res.reason}.`,
        };
      }
      // فتحة محددة؟
      if (typeof args.time === 'string' && args.time.trim()) {
        const s = checkSlot(date, args.time.trim());
        if (!s.ok) {
          return { ok: false, data: { date, time: args.time, reason: s.reason }, userMessage: s.reason! };
        }
        return {
          ok: true,
          data: { date, day: res.dayName, time: args.time, available: true },
          userMessage: `متاح ✅ ${date} الساعة ${args.time}`,
        };
      }
      const shown = res.slots.slice(0, 8);
      return {
        ok: true,
        data: { date, day: res.dayName, slots: res.slots },
        userMessage: [
          `مواعيد *${date}* (${res.dayName}) المتاحة:`,
          shown.map((s) => `• ${s}`).join('\n'),
          res.slots.length > shown.length
            ? `وعندنا ${res.slots.length - shown.length} مواعيد ثانية — قل لي الوقت اللي يناسبك وأتأكد لك.`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    // بدون تاريخ → أقرب أيام متاحة
    const next = nextAvailableDays(3);
    if (next.length === 0) {
      return {
        ok: false,
        data: { next: [] },
        userMessage: 'ما في مواعيد متاحة ضمن المدى الحالي — بوصلك بالفريق يرتبون لك مباشرة.',
      };
    }
    const lines = ['أقرب أيام متاحة للحجز:'];
    for (const d of next) lines.push(`• ${d.date} (${d.dayName}): ${d.slots.join('، ')}`);
    return {
      ok: true,
      data: { next: next.map((d) => ({ date: d.date, day: d.dayName, slots: d.slots })) },
      userMessage: lines.join('\n') + '\nأي تاريخ يناسبك؟',
    };
  },

  /** إنشاء حجز — لا نجاح إلا بعد التحقق من التوفر فعليًا */
  create_booking(args, ctx) {
    const service = ['starter', 'pro', 'enterprise'].includes(args.service) ? (args.service as PlanId) : '';
    if (!service) return { ok: false, data: { error: 'الباقة (الخدمة) غير محددة' } };

    const date = String(args.date ?? '').trim();
    const time = String(args.time ?? '').trim();
    if (!date || !time) {
      return { ok: false, data: { error: 'التاريخ والوقت مطلوبان للحجز' } };
    }

    const slot = checkSlot(date, time);
    if (!slot.ok) {
      return {
        ok: false,
        data: { error: slot.reason },
        userMessage: `ما أقدر أحجز هالموعد — ${slot.reason}. أعطني وقتًا ثاني أو خلّني أعرض لك المتاح.`,
      };
    }

    const p = store.get(ctx.sessionKey).profile ?? {};
    const booking = bookingStore.create({
      service,
      date,
      time,
      fullName: typeof args.full_name === 'string' && args.full_name.trim() ? args.full_name.trim().slice(0, 60) : p.full_name,
      restaurantName: typeof args.restaurant_name === 'string' && args.restaurant_name.trim() ? args.restaurant_name.trim().slice(0, 80) : p.restaurant_name,
      city: typeof args.city === 'string' && args.city.trim() ? args.city.trim().slice(0, 60) : p.city,
      tables: typeof args.tables === 'number' && args.tables > 0 ? Math.round(args.tables) : p.tables,
      contact: ctx.sessionKey,
      notes: typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim().slice(0, 300) : undefined,
    });

    // ثبّت أي بيانات جديدة في ذاكرة العميل الدائمة حتى لا يُعاد السؤال عنها لاحقًا
    const patch: Partial<RestaurantProfile> = {};
    if (booking.fullName) patch.full_name = booking.fullName;
    if (booking.restaurantName) patch.restaurant_name = booking.restaurantName;
    if (booking.city) patch.city = booking.city;
    if (booking.tables) patch.tables = booking.tables;
    if (Object.keys(patch).length) store.patchProfile(ctx.sessionKey, patch);

    const note =
      `🗓️ *حجز تفعيل جديد* ${booking.ref}\n` +
      `👤 ${booking.fullName ?? '—'}\n` +
      `🍽️ ${booking.restaurantName ?? '—'}${booking.city ? ` — ${booking.city}` : ''}\n` +
      `📦 ${serviceName(booking.service)}${booking.tables ? ` · ${booking.tables} طاولة` : ''}\n` +
      `📅 ${booking.date} ${booking.time}\n` +
      `💬 ${ctx.sessionKey}`;

    return {
      ok: true,
      data: { ref: booking.ref, date: booking.date, time: booking.time, service: booking.service },
      userMessage:
        `تم حجز موعد التفعيل ✅\n` +
        `رقم الحجز: *${booking.ref}*\n` +
        `📅 ${booking.date} · الساعة ${booking.time}\n` +
        `📦 ${serviceName(booking.service)}\n\n` +
        `فريقنا يتواصل معك في الموعد على رقمك. ولو تغيّر عندك شي، تقدر تعدّل أو تلغي بأي وقت وأنا أظبطه لك.`,
      sideEffect: { kind: 'notify_manager', payload: { note, orderRef: booking.ref } },
    };
  },

  /** تعديل حجز — تحقق من التوفر الجديد ثم نفّذ */
  update_booking(args, ctx) {
    const ref = typeof args.booking_ref === 'string' && args.booking_ref.trim() ? args.booking_ref.trim().toUpperCase() : '';
    const booking = ref ? bookingStore.byRef(ref) : bookingStore.latestActive(ctx.sessionKey);
    if (!booking) {
      return {
        ok: false,
        data: { error: 'لا يوجد حجز' },
        userMessage: 'ما لقيت حجز مسجل عندك لأعدّله. تبيني أتحقق لك من المواعيد المتاحة وأحجز لك واحد جديد؟',
      };
    }
    if (booking.status !== 'confirmed') {
      return {
        ok: false,
        data: { error: 'الحجز ليس نشطًا' },
        userMessage: 'هذا الحجز مو نشط (ملغى أو مكتمل). تبيني أجهز لك حجز جديد؟',
      };
    }

    const newDate = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : booking.date;
    const newTime = typeof args.time === 'string' && args.time.trim() ? args.time.trim() : booking.time;
    const newService = ['starter', 'pro', 'enterprise'].includes(args.service) ? (args.service as PlanId) : booking.service;

    if (newDate !== booking.date || newTime !== booking.time) {
      const slot = checkSlot(newDate, newTime, booking.ref);
      if (!slot.ok) {
        const alt = availableSlotsForDate(newDate);
        const suggestion = alt.ok && alt.slots.length ? ` أقرب بديل في ${newDate}: ${alt.slots.slice(0, 3).join('، ')}` : '';
        return {
          ok: false,
          data: { error: slot.reason },
          userMessage: `ما أقدر أنقل الحجز لهالموعد — ${slot.reason}.${suggestion}`,
        };
      }
    }

    const updated = bookingStore.update(booking.ref, {
      service: newService,
      date: newDate,
      time: newTime,
      notes: typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim().slice(0, 300) : booking.notes,
    });
    if (!updated) {
      return { ok: false, data: { error: 'تعذّر التحديث' }, userMessage: 'صار خطأ مؤقت بالتعديل — بوصلك بالفريق يظبطونه لك.' };
    }

    const note =
      `✏️ *تعديل حجز* ${updated.ref}\n` +
      `👤 ${updated.fullName ?? '—'}\n` +
      `📅 ${updated.date} ${updated.time}\n` +
      `📦 ${serviceName(updated.service)}`;
    return {
      ok: true,
      data: { ref: updated.ref, date: updated.date, time: updated.time, service: updated.service },
      userMessage:
        `ظبطت تعديلك ✅ الحجز *${updated.ref}* صار:\n` +
        `📅 ${updated.date} · الساعة ${updated.time}\n` +
        `📦 ${serviceName(updated.service)}`,
      sideEffect: { kind: 'notify_manager', payload: { note, orderRef: updated.ref } },
    };
  },

  /** إلغاء حجز — لا «تم الإلغاء» إلا بعد النجاح */
  cancel_booking(args, ctx) {
    const ref = typeof args.booking_ref === 'string' && args.booking_ref.trim() ? args.booking_ref.trim().toUpperCase() : '';
    const booking = ref ? bookingStore.byRef(ref) : bookingStore.latestActive(ctx.sessionKey);
    if (!booking) {
      return { ok: false, data: { error: 'لا يوجد حجز' }, userMessage: 'ما لقيت حجز مسجل عندك للإلغاء.' };
    }
    if (booking.status !== 'confirmed') {
      return {
        ok: true,
        data: { ref: booking.ref, already: booking.status },
        userMessage: `حجزك *${booking.ref}* مو نشط أصلًا (حالته: ${booking.status === 'cancelled' ? 'ملغى' : 'مكتمل'}).`,
      };
    }

    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : undefined;
    const cancelled = bookingStore.cancel(booking.ref, reason);
    if (!cancelled) {
      return { ok: false, data: { error: 'تعذّر الإلغاء' }, userMessage: 'صار خطأ مؤقت بالإلغاء — بوصلك بالفريق يتأكدون منه.' };
    }

    const note =
      `❌ *إلغاء حجز* ${cancelled.ref}\n` +
      `👤 ${cancelled.fullName ?? '—'}\n` +
      `📅 ${cancelled.date} ${cancelled.time}${reason ? `\n📝 السبب: ${reason}` : ''}`;
    return {
      ok: true,
      data: { ref: cancelled.ref, status: 'cancelled' },
      userMessage:
        `تم إلغاء حجزك *${cancelled.ref}* (${cancelled.date} — ${cancelled.time}). لو حاب نحجز لك موعد بديل، أنا جاهز.`,
      sideEffect: { kind: 'notify_manager', payload: { note, orderRef: cancelled.ref } },
    };
  },

  /** تنبيه داخلي للموظف/المدير (لا يظهر نصه للعميل) */
  send_notification(args) {
    const message = String(args.message ?? '').trim();
    if (!message) return { ok: false, data: { error: 'نص التنبيه مطلوب' } };
    const to = args.to === 'manager' ? 'manager' : 'human';
    const priority = ['low', 'normal', 'high', 'urgent'].includes(args.priority) ? args.priority : 'normal';
    const note = `🔔 تنبيه${priority !== 'normal' ? ` [${priority}]` : ''}: ${message}`;
    log.tool(`send_notification → ${to} [${priority}]`);
    return {
      ok: true,
      data: { sent: true, to, priority },
      sideEffect: { kind: to === 'manager' ? 'notify_manager' : 'notify_human', payload: { note } },
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
