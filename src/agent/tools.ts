import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log, uid } from '../lib/utils.js';
import { store } from '../lib/store.js';
import { getPlan, MUREEH_PLANS, perTableMonthly, recommendPlan } from './plans.js';
import {
  buildBlueprintText,
  isProfileReady,
  managerOrderMessage,
  missingRequired,
  nextQuestion,
  orderSummaryLine,
} from './onboarding.js';
import {
  DAY_NAMES,
  bookingStatusLabelAr,
  formatAvailabilityText,
  planName,
} from './bookings.js';
import { catalogService } from '../services/catalogService.js';
import { bookingService } from '../services/bookingService.js';
import { orderService } from '../services/orderService.js';
import { ticketService } from '../services/ticketService.js';
import { handoffService } from '../services/handoffService.js';
import { notifications } from '../services/notificationService.js';
import { bridge } from '../services/conversationBridge.js';
import { ServiceError } from '../services/errors.js';
import type { RestaurantProfile } from '../types.js';
import { executeTool, TOOL_SPECS, type ToolHandler } from './toolRegistry.js';

export type { ToolContext, ToolResult } from './tools-types.js';
import type { ToolContext, ToolResult } from './tools-types.js';

/**
 * أدوات Function Calling المعروضة على النموذج + تنفيذها عبر طبقة الخدمات.
 * الأمان: الوسيطات تُتحقق في toolRegistry، الملكية تُفرض في الخدمات،
 * والعملية الحساسة لا تتم بنص النموذج بل بمنطق الأعمال والقيود في قاعدة البيانات.
 */

const uiLang = (ctx: ToolContext): 'ar' | 'en' => (ctx.language === 'en' ? 'en' : 'ar');

export const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'get_services',
        description:
          'جلب كل خدمات المنصة الديناميكية بالأسعار من قاعدة البيانات (باقات اشتراك + خدمات رقمية: مواقع، وكلاء ذكاء اصطناعي، إدارة تواصل، واتساب، حجوزات، حلول مخصصة). استخدمها عندما يسأل العميل «وش خدماتكم؟» أو يريد استعراض المتاح.',
        parameters: {
          type: 'OBJECT',
          properties: {
            category: { type: 'STRING', description: 'slug التصنيف اختياريًا (subscriptions | digital-services)' },
          },
          required: [],
        },
      },
      {
        name: 'get_service_details',
        description:
          'جلب تفاصيل خدمة محددة: الوصف، السعر (أو «حسب الطلب»)، المدة المتوقعة، المزايا، ومدى توفر الحجز. تمرر service_id كرقم أو slug مثل starter/pro/enterprise/website/ai-agent.',
        parameters: {
          type: 'OBJECT',
          properties: { service_id: { type: 'STRING', description: 'رقم الخدمة أو slug' } },
          required: ['service_id'],
        },
      },
      {
        name: 'get_plan_details',
        description:
          'تفاصيل باقة اشتراك بالأسعار الرسمية الدقيقة (starter=الأساسية، pro=الاحترافية، enterprise=المؤسسات) مع السعر الشهري/السنوي والمزايا.',
        parameters: {
          type: 'OBJECT',
          properties: {
            plan_id: { type: 'STRING', enum: ['starter', 'pro', 'enterprise'] },
            billing: { type: 'STRING', enum: ['monthly', 'yearly'] },
          },
          required: ['plan_id'],
        },
      },
      {
        name: 'recommend_plan',
        description: 'توصية حتمية بالباقة الأنسب حسب عدد الطاولات والاحتياجات.',
        parameters: {
          type: 'OBJECT',
          properties: {
            tables: { type: 'NUMBER' },
            needs: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: [],
        },
      },
      {
        name: 'get_menu',
        description: 'قائمة باقات الاشتراك الثلاث بأسعارها الرسمية المختصرة.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'save_restaurant_profile',
        description:
          'حفظ تفاصيل المطعم التي ذكرها العميل تدريجيًا (اسم، مطعم، مدينة، فروع، طاولات، باقة، أصناف، شعار، ملاحظات). استدعِها كلما ذكر أي تفصيلة — الحقول كلها اختيارية وتُدمج. لا تسأل عن كل الحقول دفعة واحدة.',
        parameters: { type: 'OBJECT', properties: {
          full_name: { type: 'STRING' },
          restaurant_name: { type: 'STRING' },
          city: { type: 'STRING' },
          branches: { type: 'NUMBER' },
          tables: { type: 'NUMBER' },
          preferred_plan: { type: 'STRING', enum: ['starter', 'pro', 'enterprise'] },
          menu_items: { type: 'NUMBER' },
          has_logo: { type: 'BOOLEAN' },
          notes: { type: 'STRING' },
        }, required: [] },
      },
      {
        name: 'build_launch_blueprint',
        description: 'بناء التصور الكامل للإطلاق من الملف المكتمل (الاسم، المطعم، المدينة، الطاولات، الباقة) — اعرضه ثم اطلب التأكيد.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'confirm_launch_order',
        description: 'تأكيد طلب الإطلاق بعد موافقة العميل الصريحة على التصور (confirmed=true). يحفظ الطلب في قاعدة البيانات وينبّه المدير وتُحوّل المحادثة له. ممنوع قبل عرض التصور وموافقة العميل.',
        parameters: {
          type: 'OBJECT',
          properties: { confirmed: { type: 'BOOLEAN' }, notes: { type: 'STRING' } },
          required: ['confirmed'],
        },
      },
      {
        name: 'check_availability',
        description:
          'المواعيد المتاحة للحجز (date=YYYY-MM-DD اختياري، time=HH:MM اختياري). بدون تاريخ تُرجع أقرب الأيام المتاحة فعليًا بعد خصم الإشغال. استخدمها دائمًا قبل عرض أي موعد — لا تخترع موعدًا.',
        parameters: {
          type: 'OBJECT',
          properties: { date: { type: 'STRING' }, time: { type: 'STRING' }, service: { type: 'STRING' } },
          required: [],
        },
      },
      {
        name: 'create_booking',
        description:
          'إنشاء حجز موعد (service = slug الخدمة/الباقة، date، time) — يُستدعى بعد نجاح check_availability وجمع الخدمة/التاريخ/الوقت. يمنع الحجز المزدوج تلقائيًا. لا تؤكد للحجز قبل نجاح الأداة.',
        parameters: {
          type: 'OBJECT',
          properties: {
            service: { type: 'STRING', description: 'slug الخدمة مثل pro/website أو رقمها' },
            service_id: { type: 'STRING' },
            date: { type: 'STRING' },
            time: { type: 'STRING' },
            full_name: { type: 'STRING' },
            restaurant_name: { type: 'STRING' },
            city: { type: 'STRING' },
            tables: { type: 'NUMBER' },
            notes: { type: 'STRING' },
          },
          required: ['date', 'time'],
        },
      },
      {
        name: 'update_booking',
        description: 'تعديل حجز (التاريخ/الوقت/الخدمة) بعد التحقق من التوفر الجديد. booking_ref اختياريًا (بدونه آخر حجز نشط للعميل).',
        parameters: {
          type: 'OBJECT',
          properties: {
            booking_ref: { type: 'STRING' },
            service: { type: 'STRING' },
            date: { type: 'STRING' },
            time: { type: 'STRING' },
            notes: { type: 'STRING' },
          },
          required: [],
        },
      },
      {
        name: 'cancel_booking',
        description: 'إلغاء حجز نشط. booking_ref اختياريًا (بدونه آخر حجز نشط للعميل). اسأل عن السبب بلطف أولًا. لا تؤكد الإلغاء قبل نجاح الأداة.',
        parameters: {
          type: 'OBJECT',
          properties: { booking_ref: { type: 'STRING' }, reason: { type: 'STRING' } },
          required: [],
        },
      },
      {
        name: 'get_customer_bookings',
        description: 'جلب حجوزات العميل الحالية والسابقة بحالاتها. استخدمها عندما يسأل «حجوزاتي» أو «موعدي».',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'get_order_status',
        description: 'متابعة حالة طلب برقمه المرجعي (ORD-XXXXXX). يرفض طلبات العملاء الآخرين.',
        parameters: { type: 'OBJECT', properties: { order_ref: { type: 'STRING' } }, required: ['order_ref'] },
      },
      {
        name: 'get_customer',
        description: 'بيانات العميل المحفوظة + حجوزاته النشطة + طلباته. استخدمها قبل إعادة سؤاله عن بيانات سبق إعطاؤها.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'create_support_ticket',
        description: 'فتح تذكرة دعم لمشترك لديه مشكلة تقنية أو شكوى جدية (issue وصف واضح، restaurant_name، priority). تُحوّل المحادثة لموظف بشري تلقائيًا.',
        parameters: {
          type: 'OBJECT',
          properties: {
            restaurant_name: { type: 'STRING' },
            plan: { type: 'STRING' },
            issue: { type: 'STRING' },
            priority: { type: 'STRING', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['issue', 'priority'],
        },
      },
      {
        name: 'handoff_to_human',
        description: 'تحويل المحادثة لموظف بشري عند: طلب العميل لإنسان، شكوى جدية، عملية مالية/حساسة، سؤال لا تملك إجابته، أو تعثّر مرتين متتاليتين.',
        parameters: {
          type: 'OBJECT',
          properties: { reason: { type: 'STRING', description: 'سبب التحويل باختصار' }, summary: { type: 'STRING' } },
          required: ['reason'],
        },
      },
      {
        name: 'send_notification',
        description: 'تنبيه داخلي للفريق (manager/human) لا يظهر للعميل — لحالات تحتاج متابعة بشرية فورية فقط.',
        parameters: {
          type: 'OBJECT',
          properties: {
            message: { type: 'STRING' },
            to: { type: 'STRING', enum: ['manager', 'human'] },
            priority: { type: 'STRING', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['message'],
        },
      },
      {
        name: 'get_restaurant_info',
        description: 'معلومات النشاط الرسمية: الهوية، القنوات، ساعات عمل فريق الحجز.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
    ],
  },
];

// ───────────────────────── أدوات مساعدة للعرض ─────────────────────────

function priceText(price: number | null, billing: string | null, lang: 'ar' | 'en'): string {
  if (price === null || price === undefined) return lang === 'en' ? 'On request' : 'حسب الطلب';
  const suf = billing === 'monthly' ? (lang === 'en' ? '/month' : ' ₪/شهر')
    : billing === 'yearly' ? (lang === 'en' ? '/year' : ' ₪/سنة')
    : billing === 'hourly' ? (lang === 'en' ? '/hour' : ' ₪/ساعة')
    : lang === 'en' ? ' ILS' : ' ₪';
  return `*${price}${suf}*`;
}

function serviceDetailsMessage(view: ReturnType<typeof catalogService.view>, lang: 'ar' | 'en'): string {
  const lines = [
    `*${view.name}*`,
    '',
    view.description,
    '',
    lang === 'en' ? `💵 ${priceText(view.price, view.billingPeriod, lang)}` : `💵 السعر: ${priceText(view.price, view.billingPeriod, lang)}`,
  ];
  if (view.durationText) {
    lines.push(lang === 'en' ? `⏱️ Duration: ${view.durationText}` : `⏱️ المدة المتوقعة: ${view.durationText}`);
  }
  if (view.availabilityText) lines.push(lang === 'en' ? `📅 ${view.availabilityText}` : `📅 ${view.availabilityText}`);
  if (view.features.length) {
    lines.push('', lang === 'en' ? '✨ What you get:' : '✨ المزايا:');
    for (const f of view.features.slice(0, 8)) lines.push(`• ${f}`);
  }
  if (view.isBookable) {
    lines.push('', lang === 'en' ? 'Tap 📅 Book an activation slot to pick a time.' : 'تبيني أحجز لك موعد تفعيل؟ اضغط زر الحجز أو قل لي اليوم المناسب.');
  } else {
    lines.push('', lang === 'en' ? 'Tap 📝 Request this service and our team will contact you.' : 'تبيني أرفع طلبك للفريق؟ اضغط «اطلب الخدمة» أو اكتب لي تفاصيل مشروعك.');
  }
  return lines.join('\n');
}

// ───────────────────────── التنفيذ ─────────────────────────

const HANDLERS: Record<string, ToolHandler> = {
  get_services(_args, ctx) {
    const lang = uiLang(ctx);
    const groups = catalogService.byCategory(lang);
    const data = groups.map((g) => ({
      category: lang === 'en' ? g.category.name_en || g.category.name_ar : g.category.name_ar,
      services: g.services.map((s) => ({
        id: s.id, slug: s.slug, name: s.name, price: s.price, billing: s.billingPeriod,
        bookable: s.isBookable, duration: s.durationText ?? null,
      })),
    }));
    const lines: string[] = [];
    for (const g of groups) {
      lines.push(`*${lang === 'en' && g.category.name_en ? g.category.name_en : g.category.name_ar}*`);
      for (const s of g.services) {
        lines.push(`• ${s.name} — ${priceText(s.price, s.billingPeriod, lang)}`);
      }
      lines.push('');
    }
    log.tool('get_services → كتالوج ديناميكي');
    return { ok: true, data: { groups: data }, userMessage: lines.join('\n').trim() };
  },

  get_service_details(args, ctx) {
    const lang = uiLang(ctx);
    const view = catalogService.details(String(args.service_id), lang);
    if (!view) return { ok: false, data: { error: 'الخدمة غير موجودة' }, userMessage: 'ما لقيت هذي الخدمة عندي — تبي أشوف لك قائمة الخدمات؟' };
    log.tool(`get_service_details → ${view.slug}`);
    return {
      ok: true,
      data: {
        id: view.id, slug: view.slug, name: view.name, price: view.price,
        billing: view.billingPeriod, durationText: view.durationText,
        bookable: view.isBookable, features: view.features,
      },
      userMessage: serviceDetailsMessage(view, lang),
    };
  },

  get_plan_details(args) {
    const id = ['starter', 'pro', 'enterprise'].includes(args.plan_id) ? args.plan_id : 'pro';
    const billing = args.billing === 'yearly' ? 'yearly' : 'monthly';
    const plan = getPlan(id);
    log.tool(`get_plan_details → ${id} (${billing})`);
    // بيانات منظمة كاملة — الصياغة للنموذج (الأداة لا تبيع ولا تطرح أسئلة)
    return {
      ok: true,
      data: {
        plan: plan.id,
        name: plan.name,
        billing,
        price: billing === 'monthly' ? plan.priceMonthly : plan.priceYearly,
        currency: 'ILS',
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        priceYearlyPerMonth: plan.priceYearlyPerMonth,
        yearlySavings: plan.yearlySavings,
        mostPopular: Boolean(plan.mostPopular),
        features: plan.features,
      },
      userMessage:
        `${plan.name}${plan.mostPopular ? ' (الأكثر طلبًا)' : ''}: ${plan.priceMonthly} ₪/شهر — ` +
        `أو سنويًا ${plan.priceYearly} ₪ (${plan.priceYearlyPerMonth} ₪/شهر مكافئ، توفير ${plan.yearlySavings} ₪). ` +
        `المزايا: ${plan.features.join(' • ')}`,
    };
  },

  recommend_plan(args) {
    const tables = typeof args.tables === 'number' && args.tables > 0 ? Math.round(args.tables) : undefined;
    const needs = Array.isArray(args.needs) ? args.needs.map(String) : [];
    const rec = recommendPlan({ tables, needs });
    const p = rec.plan;
    const perTable = tables ? perTableMonthly(p, tables) : undefined;
    log.tool(`recommend_plan → ${p.id} (tables=${tables ?? '?'})`);
    return {
      ok: true,
      data: {
        recommended: p.id,
        planName: p.name,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        priceYearlyPerMonth: p.priceYearlyPerMonth,
        yearlySavings: p.yearlySavings,
        perTableMonthly: perTable,
        reason: rec.reason,
        features: p.features,
      },
      userMessage:
        `التوصية الحتمية: ${p.name} — ${p.priceMonthly} ₪/شهر` +
        (perTable ? ` (~${perTable} ₪ للطاولة عند ${tables} طاولة)` : '') +
        `. السبب: ${rec.reason}. السنوي: ${p.priceYearlyPerMonth} ₪/شهر (توفير ${p.yearlySavings} ₪).`,
    };
  },

  get_menu() {
    return {
      ok: true,
      data: {
        plans: MUREEH_PLANS.map((p) => ({
          id: p.id, name: p.name, priceMonthly: p.priceMonthly,
          priceYearly: p.priceYearly, priceYearlyPerMonth: p.priceYearlyPerMonth,
          yearlySavings: p.yearlySavings, mostPopular: Boolean(p.mostPopular),
          tagline: p.tagline, features: p.features,
        })),
      },
      userMessage: MUREEH_PLANS.map((p) =>
        `${p.name}${p.mostPopular ? ' (الأكثر طلبًا)' : ''}: ${p.priceMonthly} ₪/شهر — ${p.tagline}`,
      ).join('\n'),
    };
  },

  get_restaurant_info(_args, ctx) {
    const lang = uiLang(ctx);
    if (lang === 'en') {
      return {
        ok: true,
        data: { working_hours: formatAvailabilityText('en'), timezone: config.booking.TIMEZONE },
        userMessage: [
          '*MUREEH* — a cloud platform for restaurants and cafés (QR menu, live kitchen screen, POS, analytics) plus custom digital services.',
          '💬 Sales & support on Telegram/WhatsApp: +972 599 891 559',
          `⏰ Activation-team hours: ${formatAvailabilityText('en')}`,
          '🤖 I reply 24/7; human follow-up is during working hours.',
        ].join('\n'),
      };
    }
    return {
      ok: true,
      data: { working_hours: formatAvailabilityText('ar'), timezone: config.booking.TIMEZONE },
      userMessage: [
        '*منصة مُريح* — نظام إدارة مطاعم ومقاهٍ سحابي (منيو QR، شاشة مطبخ حية، كاشير، تحليلات) + خدمات رقمية مخصصة.',
        '💬 المبيعات والدعم: +972 599 891 559 (تيليجرام/واتساب)',
        `⏰ ساعات عمل فريق الحجز والتفعيل: ${formatAvailabilityText('ar')}`,
        '🤖 أرد عليك 24/7، والمتابعة البشرية خلال ساعات العمل.',
      ].join('\n'),
    };
  },

  // ───────── ملف المطعم ومسار الإطلاق ─────────

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

    const profile = store.patchProfile(ctx.sessionKey, patch);
    store.patchLaunch(ctx.sessionKey, { status: 'collecting' });
    bridge.patchCustomer(ctx.sessionKey, {
      fullName: patch.full_name, restaurantName: patch.restaurant_name, city: patch.city,
      tables: patch.tables, branches: patch.branches, preferredPlan: patch.preferred_plan, notes: patch.notes,
    });
    const missing = missingRequired(profile);
    log.tool(`save_restaurant_profile → ناقص: ${missing.join(',') || 'لا شيء'}`);
    return { ok: true, data: { profile, missing, next_question: nextQuestion(profile), ready_for_blueprint: missing.length === 0 } };
  },

  build_launch_blueprint(_args, ctx) {
    const session = store.get(ctx.sessionKey);
    const profile = session.profile ?? {};
    if (!isProfileReady(profile)) {
      const missing = missingRequired(profile);
      return { ok: false, data: { missing, next_question: nextQuestion(profile) }, userMessage: '' };
    }
    const blueprint = buildBlueprintText(profile);
    store.patchLaunch(ctx.sessionKey, { status: 'awaiting_confirmation', blueprint });
    return {
      ok: true, data: { blueprint, ready: true },
      userMessage: `${blueprint}\n\nهذا تصور نسختك كاملًا 👆 راجعه، ولو تمام اضغط *تأكيد الطلب* — وأي تعديل اكتبه لي وأظبطه فورًا.`,
    };
  },

  async confirm_launch_order(args, ctx) {
    const session = store.get(ctx.sessionKey);
    const profile = { ...(session.profile ?? {}) };

    // دعم قيم تأكيد مرنة (boolean، نصوص، أو أرقام)
    const isConfirmed =
      args.confirmed === true ||
      args.confirmed === 'true' ||
      args.confirmed === 1 ||
      args.confirmed === '1' ||
      args.confirmed === 'نعم';
    if (!isConfirmed) return { ok: false, data: { error: 'لم يؤكد العميل بعد' } };

    // سد نقص الاسم إذا كان متوفراً في اسم الجلسة (تيليجرام/واتساب)
    if (!profile.full_name?.trim() && session.name?.trim()) {
      profile.full_name = session.name.trim();
      store.patchProfile(ctx.sessionKey, { full_name: profile.full_name });
    }
    // باقة افتراضية إذا لم تُحدد
    if (!profile.preferred_plan) {
      profile.preferred_plan = 'pro';
      store.patchProfile(ctx.sessionKey, { preferred_plan: 'pro' });
    }

    if (!isProfileReady(profile)) {
      return { ok: false, data: { error: 'الملف ناقص', missing: missingRequired(profile), next_question: nextQuestion(profile) } };
    }
    const finalProfile = store.get(ctx.sessionKey).profile ?? {};
    if (session.launch?.status === 'confirmed' && session.launch.orderRef) {
      const existingRef = session.launch.orderRef;
      const managerNote = managerOrderMessage(finalProfile, existingRef, ctx.sessionKey);
      return {
        ok: true,
        data: { order_ref: existingRef, duplicate: true },
        userMessage:
          `طلبك مسجل مسبقًا برقم *${existingRef}* ✅\n` +
          `ملفك الكامل وصل *مدير المنصة* ويتواصل معك لتجهيز نسختك في أقرب وقت 🚀\n` +
          `المحادثة الآن معه مباشرة، وأنا هنا لو احتجتني بعدين.`,
        sideEffect: { kind: 'notify_manager', payload: { note: managerNote, orderRef: existingRef } },
      };
    }
    if (typeof args.notes === 'string' && args.notes.trim()) {
      store.patchProfile(ctx.sessionKey, { notes: args.notes.trim().slice(0, 500) });
    }

    const proposedRef = `ORD-${uid('').slice(-6).toUpperCase()}`;
    const initialManagerNote = managerOrderMessage(finalProfile, proposedRef, ctx.sessionKey);

    const order = orderService.launchOrder({
      contactKey: ctx.sessionKey,
      ref: proposedRef,
      summary: orderSummaryLine(finalProfile, proposedRef),
      fullNote: initialManagerNote,
      payload: { ...finalProfile },
      serviceSlug: finalProfile.preferred_plan ?? undefined,
      totalAmount: getPlan((finalProfile.preferred_plan ?? 'pro') as 'starter' | 'pro' | 'enterprise').priceMonthly,
      language: uiLang(ctx),
    });

    const finalRef = order.ref;
    const summary = orderSummaryLine(finalProfile, finalRef);
    const managerNote = finalRef === proposedRef ? initialManagerNote : managerOrderMessage(finalProfile, finalRef, ctx.sessionKey);

    store.patchLaunch(ctx.sessionKey, { status: 'confirmed', orderRef: finalRef, confirmedAt: Date.now() });
    bridge.patchCustomer(ctx.sessionKey, {
      fullName: finalProfile.full_name, restaurantName: finalProfile.restaurant_name, city: finalProfile.city,
      tables: finalProfile.tables, branches: finalProfile.branches, preferredPlan: finalProfile.preferred_plan,
    });
    log.tool(`confirm_launch_order → ${finalRef}`);
    return {
      ok: true,
      data: { order_ref: finalRef, summary },
      userMessage:
        `تم تأكيد طلبك ✅ رقم الطلب: *${finalRef}*\n` +
        `ملفك الكامل وصل *مدير المنصة* ويتواصل معك لتجهيز نسختك خلال دقائق عادة، وبدون بطاقة للبدء 🚀\n` +
        `المحادثة الآن معه مباشرة، وأنا هنا لو احتجتني بعدين.`,
      sideEffect: { kind: 'notify_manager', payload: { note: managerNote, orderRef: finalRef } },
    };
  },

  // ───────── الحجوزات (عبر BookingService — منطق الأعمال هو المرجع) ─────────

  check_availability(args, ctx) {
    const date = typeof args.date === 'string' ? args.date.trim() : '';
    const lang = uiLang(ctx);
    if (date) {
      const res = bookingService.daySlots(date);
      if (!res.ok) return { ok: false, data: { date, reason: res.reason }, userMessage: `${res.reason}.` };
      if (typeof args.time === 'string' && args.time.trim()) {
        const s = bookingService.check(date, args.time.trim());
        if (!s.ok) return { ok: false, data: { date, time: args.time, reason: s.reason }, userMessage: s.reason! };
        return { ok: true, data: { date, time: args.time, available: true }, userMessage: lang === 'en' ? `Available ✅ ${date} at ${args.time}` : `متاح ✅ ${date} الساعة ${args.time}` };
      }
      const shown = res.slots.slice(0, 8);
      return {
        ok: true, data: { date, day: res.dayName, slots: res.slots },
        userMessage: [
          `مواعيد *${date}* (${res.dayName ?? ''}) المتاحة:`,
          shown.map((s) => `• ${s}`).join('\n'),
          res.slots.length > shown.length ? `وعندنا مواعيد ثانية — قل لي الوقت الأنسب.` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    const next = bookingService.nextDays(3);
    if (next.length === 0) {
      return { ok: false, data: { next: [] }, userMessage: 'لا توجد مواعيد متاحة ضمن المدى الحالي — بوصلك بالفريق يرتبونها معك مباشرة.' };
    }
    const lines = ['أقرب أيام متاحة للحجز:'];
    for (const d of next) lines.push(`• ${d.date} (${d.dayName}): ${d.slots.join('، ')}`);
    return { ok: true, data: { next }, userMessage: lines.join('\n') };
  },

  create_booking(args, ctx) {
    const lang = uiLang(ctx);
    const serviceRef = args.service_id ?? args.service;
    const idempotencyKey = `cb:${ctx.sessionKey}:${String(serviceRef ?? 'pro')}:${args.date}:${args.time}`;
    try {
      const { booking, service } = bookingService.create({
        contactKey: ctx.sessionKey,
        serviceRef: serviceRef ? String(serviceRef) : null,
        date: String(args.date),
        time: String(args.time),
        fullName: typeof args.full_name === 'string' && args.full_name.trim() ? args.full_name.trim() : undefined,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
        language: lang,
        idempotencyKey,
      });
      const patch: Partial<RestaurantProfile> = {};
      if (typeof args.full_name === 'string' && args.full_name.trim()) patch.full_name = args.full_name.trim().slice(0, 60);
      if (typeof args.restaurant_name === 'string' && args.restaurant_name.trim()) patch.restaurant_name = args.restaurant_name.trim().slice(0, 80);
      if (typeof args.city === 'string' && args.city.trim()) patch.city = args.city.trim().slice(0, 60);
      if (typeof args.tables === 'number' && args.tables > 0) patch.tables = Math.round(args.tables);
      if (Object.keys(patch).length) { store.patchProfile(ctx.sessionKey, patch); bridge.patchCustomer(ctx.sessionKey, patch as any); }
      const svcName = service ? (lang === 'en' && service.name_en ? service.name_en : service.name_ar) : planName(booking.plan_slug);
      log.tool(`create_booking → ${booking.ref}`);
      return {
        ok: true,
        data: { ref: booking.ref, date: booking.slot_date, time: booking.slot_time, service: booking.plan_slug ?? service?.slug },
        userMessage: lang === 'en'
          ? `Booking confirmed ✅\nRef: *${booking.ref}*\n📅 ${booking.slot_date} at ${booking.slot_time}\n📦 ${svcName}\n\n${formatAvailabilityText('en') ? 'Our team will contact you at the appointment.' : ''}`
          : `تم حجز موعدك ✅\nرقم الحجز: *${booking.ref}*\n📅 ${booking.slot_date} · الساعة ${booking.slot_time}\n📦 ${svcName}\n\nفريقنا يتواصل معك في الموعد، وتقدر تعدّل أو تلغي من «حجوزاتي».`,
      };
    } catch (err) {
      return toolError(err, 'ما أقدر أحجز هالموعد');
    }
  },

  update_booking(args, ctx) {
    try {
      const updated = bookingService.reschedule({
        contactKey: ctx.sessionKey,
        ref: typeof args.booking_ref === 'string' ? args.booking_ref : null,
        date: typeof args.date === 'string' && args.date.trim() ? args.date.trim() : undefined as unknown as string,
        time: typeof args.time === 'string' && args.time.trim() ? args.time.trim() : undefined as unknown as string,
        serviceRef: typeof args.service === 'string' ? args.service : null,
      });
      const svcName = planName(updated.plan_slug);
      log.tool(`update_booking → ${updated.ref}`);
      return {
        ok: true,
        data: { ref: updated.ref, date: updated.slot_date, time: updated.slot_time },
        userMessage: `ظبطت تعديلك ✅ الحجز *${updated.ref}* صار:\n📅 ${updated.slot_date} · الساعة ${updated.slot_time}\n📦 ${svcName}`,
      };
    } catch (err) {
      return toolError(err, 'ما أقدر أنقل الحجز لهالموعد');
    }
  },

  cancel_booking(args, ctx) {
    try {
      const cancelled = bookingService.cancel({
        contactKey: ctx.sessionKey,
        ref: typeof args.booking_ref === 'string' ? args.booking_ref : null,
        reason: typeof args.reason === 'string' ? args.reason : null,
      });
      log.tool(`cancel_booking → ${cancelled.ref}`);
      return {
        ok: true,
        data: { ref: cancelled.ref, status: cancelled.status, date: cancelled.slot_date, time: cancelled.slot_time },
        userMessage: `تم إلغاء الحجز *${cancelled.ref}* (${cancelled.slot_date} — ${cancelled.slot_time}).`,
      };
    } catch (err) {
      return toolError(err, 'تعذّر إلغاء الحجز');
    }
  },

  get_customer_bookings(_args, ctx) {
    const rows = bookingService.listFor(ctx.sessionKey);
    const active = rows.filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED');
    const lines = active.length
      ? ['حجوزاتك النشطة:', ...active.map((b) => `• ${b.ref} — ${b.slot_date} ${b.slot_time} — ${planName(b.plan_slug)} (${bookingStatusLabelAr(b.status)})`)]
      : ['لا توجد لديك حجوزات نشطة حاليًا.'];
    const past = rows.filter((b) => b.status === 'COMPLETED' || b.status === 'CANCELLED' || b.status === 'NO_SHOW').slice(0, 5);
    if (past.length) {
      lines.push('', 'السابقة:');
      for (const b of past) lines.push(`• ${b.ref} — ${b.slot_date} (${bookingStatusLabelAr(b.status)})`);
    }
    return {
      ok: true,
      data: { bookings: rows.map((b) => ({ ref: b.ref, date: b.slot_date, time: b.slot_time, status: b.status, service: b.plan_slug })) },
      userMessage: lines.join('\n'),
    };
  },

  get_order_status(args, ctx) {
    try {
      const order = orderService.byRef(String(args.order_ref).trim(), ctx.sessionKey);
      const label = {
        PENDING: 'قيد المراجعة', CONFIRMED: 'مؤكّد', IN_PROGRESS: 'قيد التنفيذ',
        COMPLETED: 'مكتمل', CANCELLED: 'ملغى',
      }[order.status] ?? order.status;
      return {
        ok: true,
        data: { ref: order.ref, status: order.status, summary: order.summary },
        userMessage: `طلبك *${order.ref}* حالته: *${label}*.\n${order.summary}`,
      };
    } catch (err) {
      return toolError(err, 'ما لقيت الطلب');
    }
  },

  get_customer(_args, ctx) {
    const session = store.get(ctx.sessionKey);
    const p = session.profile ?? {};
    const bookings = bookingService.listFor(ctx.sessionKey).filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED');
    const orders = orderService.listFor(ctx.sessionKey).slice(0, 5);
    const facts: string[] = [];
    if (p.full_name) facts.push(`الاسم: ${p.full_name}`);
    if (p.restaurant_name) facts.push(`المطعم: ${p.restaurant_name}`);
    if (p.city) facts.push(`المدينة: ${p.city}`);
    if (p.tables) facts.push(`الطاولات: ${p.tables}`);
    if (p.preferred_plan) facts.push(`الباقة: ${planName(p.preferred_plan)}`);
    const bLines = bookings.map((b) => `• ${b.ref} — ${b.slot_date} ${b.slot_time} — ${planName(b.plan_slug)}`);
    const oLines = orders.map((o) => `• ${o.ref} — ${o.status}`);
    return {
      ok: true,
      data: {
        profile: p,
        active_bookings: bookings.map((b) => ({ ref: b.ref, date: b.slot_date, time: b.slot_time, status: b.status })),
        orders: oLines,
      },
      userMessage: [
        facts.length ? `بياناتك:\n${facts.join('\n')}` : 'لا توجد تفاصيل كثيرة مسجلة بعد.',
        bookings.length ? `حجوزاتك النشطة:\n${bLines.join('\n')}` : 'لا حجوزات نشطة.',
        orders.length ? `طلباتك:\n${oLines.join('\n')}` : '',
      ].filter(Boolean).join('\n\n'),
    };
  },

  create_support_ticket(args, ctx) {
    try {
      const profile = store.get(ctx.sessionKey).profile;
      const ticket = ticketService.open({
        contactKey: ctx.sessionKey,
        issue: String(args.issue ?? ''),
        restaurantName: typeof args.restaurant_name === 'string' ? args.restaurant_name : profile?.restaurant_name,
        plan: args.plan ?? profile?.preferred_plan ?? null,
        priority: ['low', 'normal', 'high', 'urgent'].includes(args.priority) ? args.priority : 'normal',
        language: uiLang(ctx),
      });
      const prioAr: Record<string, string> = { urgent: 'عاجلة (الخدمة متوقفة)', high: 'عالية', normal: 'عادية', low: 'منخفضة' };
      log.tool(`create_support_ticket → ${ticket.ref}`);
      return {
        ok: true,
        data: { ref: ticket.ref, priority: ticket.priority, status: ticket.status },
        userMessage: `فتحت لك متابعة فورية برقم *${ticket.ref}* (أولوية: ${prioAr[ticket.priority]}).\nزميل من الدعم يكمل معك قريبًا، وأنا آسف على الإزعاج — بنحلّها.`,
        sideEffect: { kind: 'handoff', payload: { reason: `تذكرة دعم ${ticket.ref}` } },
      };
    } catch (err) {
      return toolError(err, 'تعذّر فتح التذكرة');
    }
  },

  handoff_to_human(args, ctx) {
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 300) : 'طلب العميل موظفًا بشريًا';
    const session = store.get(ctx.sessionKey);
    handoffService.request({
      contactKey: ctx.sessionKey,
      name: session.name,
      reason,
      summary: typeof args.summary === 'string' ? args.summary : session.summary,
      lastMessage: session.messages.filter((m) => m.dir === 'in').slice(-1)[0]?.body ?? '',
    });
    log.tool(`handoff_to_human → ${ctx.sessionKey} (${reason})`);
    return {
      ok: true,
      data: { handoff: true, reason },
      userMessage: uiLang(ctx) === 'en'
        ? 'Sure — connecting you with a teammate now 🙏 They’ll take over shortly.'
        : 'حاضر، بوصلك بأحد الزملاء الحين 🙋 يكملون معك بأقرب وقت.',
      sideEffect: { kind: 'handoff', payload: { reason } },
    };
  },

  send_notification(args) {
    const message = String(args.message ?? '').trim();
    const to = args.to === 'manager' ? 'manager' : 'human';
    const priority = ['low', 'normal', 'high', 'urgent'].includes(args.priority) ? String(args.priority) : 'normal';
    notifications.staffAlert(to, `🔔 [${priority}] ${message}`);
    log.tool(`send_notification → ${to} [${priority}]`);
    return { ok: true, data: { sent: true, to, priority } };
  },

  /** متوافق خلفي فقط — غير معروض للنموذج؛ يبقى لتسجيل ليد من تكاملات قديمة */
  async capture_subscription_lead(args, ctx) {
    const lead = {
      ref: `SUB-${uid('').slice(-6).toUpperCase()}`,
      full_name: String(args.full_name ?? 'غير مذكور'),
      restaurant_name: String(args.restaurant_name ?? 'غير مذكور'),
      city: String(args.city ?? 'غير مذكورة'),
      tables: args.tables ?? null,
      preferred_plan: String(args.preferred_plan ?? 'غير محددة'),
      sessionKey: ctx.sessionKey,
      created_at: new Date().toISOString(),
    };
    await appendJsonFile('leads', lead);
    store.patchProfile(ctx.sessionKey, {
      full_name: lead.full_name !== 'غير مذكور' ? lead.full_name : undefined,
      restaurant_name: lead.restaurant_name !== 'غير مذكور' ? lead.restaurant_name : undefined,
      city: lead.city !== 'غير مذكورة' ? lead.city : undefined,
      tables: typeof lead.tables === 'number' && lead.tables > 0 ? lead.tables : undefined,
      preferred_plan: ['starter', 'pro', 'enterprise'].includes(lead.preferred_plan) ? lead.preferred_plan as RestaurantProfile['preferred_plan'] : undefined,
    });
    const profile = store.get(ctx.sessionKey).profile ?? {};
    const managerNote = managerOrderMessage(profile, lead.ref, ctx.sessionKey);

    try {
      orderService.launchOrder({
        contactKey: ctx.sessionKey,
        ref: lead.ref,
        summary: orderSummaryLine(profile, lead.ref),
        fullNote: managerNote,
        payload: { ...profile, ...lead },
        serviceSlug: profile.preferred_plan ?? undefined,
        language: uiLang(ctx),
      });
    } catch (err) {
      log.warn(`capture_subscription_lead: فشل حفظ الطلب في SQLite: ${(err as Error).message}`);
    }

    store.patchLaunch(ctx.sessionKey, { status: 'confirmed', orderRef: lead.ref, confirmedAt: Date.now() });
    return {
      ok: true,
      data: lead,
      userMessage: `سجّلت طلبك ✅ الرقم: *${lead.ref}* — الفريق يتواصل معك الآن.`,
      sideEffect: { kind: 'notify_manager', payload: { note: managerNote, orderRef: lead.ref } },
    };
  },
};

/** تحويل موحّد لأخطاء الخدمات إلى ToolResult ودية */
function toolError(err: unknown, prefix: string): ToolResult {
  if (err instanceof ServiceError) {
    const suffix =
      err.code === 'unavailable' ? err.message
      : err.code === 'forbidden' ? 'لا تملك صلاحية على هذا العنصر.'
      : err.code === 'not_found' ? 'ما لقيت العنصر المطلوب.'
      : err.message;
    return { ok: false, data: { error: err.code, detail: err.message }, userMessage: `${prefix} — ${suffix}` };
  }
  const message = (err as Error).message ?? String(err);
  return { ok: false, data: { error: message }, userMessage: `${prefix} — صارت مشكلة مؤقتة، بوصلك بالفريق يظبطونها لك.` };
}

async function appendJsonFile(name: 'leads' | 'tickets' | 'orders', record: Record<string, unknown>): Promise<void> {
  const file = path.join(config.paths.DATA_DIR, `${name}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let all: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(parsed)) all = parsed;
  } catch { /* أول تسجيل */ }
  all.push(record);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** نقطة التنفيذ الموحّدة الآمنة (تستخدمها حلقة النموذج والسكربتات) */
export async function runTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  if (!config.bot.TOOLS_ENABLED) {
    return { ok: false, data: { error: 'الأدوات معطّلة في الإعدادات' } };
  }
  return executeTool(name, args, ctx, HANDLERS);
}

export const TOOL_HANDLERS = HANDLERS;
export { TOOL_SPECS };
export const TOOL_NAMES = Object.keys(HANDLERS);

// DAY_NAMES مستخدمة في اختبارات/سكربتات محتملة
export { DAY_NAMES };
