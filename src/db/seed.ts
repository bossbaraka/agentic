/**
 * البيانات الأولية للنظام (Seed) — idempotent.
 *
 * ⚠️ الخدمات ديناميكية من قاعدة البيانات، وليست hardcoded في منطق البوت.
 * هذا الملف يزرع الكتالوج الافتتاحي فقط عند أول تشغيل؛ بعدها تُدار الخدمات
 * من أوامر الموظفين (/admin) أو لوحة التحكم دون لمس الكود.
 *
 * أسعار باقات الاشتراك تُقرأ من plans.ts (المصدر الوحيد للأرقام) حتى تبقى
 * متطابقة مع المنطق الحتمي للتوصية.
 */
import { run, get } from './client.js';
import { config } from '../config.js';
import { log } from '../lib/utils.js';
import { MUREEH_PLANS } from '../agent/plans.js';

interface CategorySeed {
  slug: string;
  name_ar: string;
  name_en: string;
  sort_order: number;
}

interface ServiceSeed {
  slug: string;
  category: string;
  name_ar: string;
  name_en: string;
  description_ar: string;
  description_en: string;
  price: number | null;
  billing_period: 'once' | 'monthly' | 'yearly' | 'hourly' | null;
  duration_minutes: number | null;
  is_bookable: boolean;
  availability_text: string;
  metadata: Record<string, unknown>;
  sort_order: number;
}

const CATEGORIES: CategorySeed[] = [
  { slug: 'subscriptions', name_ar: 'باقات الاشتراك', name_en: 'Subscription Plans', sort_order: 1 },
  { slug: 'digital-services', name_ar: 'خدمات رقمية', name_en: 'Digital Services', sort_order: 2 },
];

const DIGITAL: Omit<ServiceSeed, 'category'>[] = [
  {
    slug: 'website',
    name_ar: '🌐 إنشاء موقع إلكتروني',
    name_en: '🌐 Website Development',
    description_ar:
      'عميل يبحث عنك يلقى صفحة سريعة تأخذ رقمه إلى واتسابك. موقع احترافي متجاوب، مهيّأ لمحركات البحث، مع لوحة تعدّل منها المحتوى بدون مطوّر.',
    description_en:
      'A professional, responsive and SEO-ready website with a content dashboard and contact forms wired to your email or WhatsApp.',
    price: null,
    billing_period: 'once',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'مدة التنفيذ عادة 7–14 يوم عمل حسب المتطلبات.',
    metadata: {
      durationTextAr: '7–14 يوم عمل',
      durationTextEn: '7–14 business days',
      featuresAr: ['تصميم متجاوب للجوال والحاسوب', 'سرعة عالية وتهيئة SEO', 'لوحة تحكم للمحتوى', 'ربط النماذج بواتساب/البريد'],
      featuresEn: ['Responsive design', 'High performance & SEO', 'Content dashboard', 'WhatsApp/email form integration'],
    },
    sort_order: 10,
  },
  {
    slug: 'ai-agent',
    name_ar: '🤖 وكيل ذكاء اصطناعي',
    name_en: '🤖 AI Agent',
    description_ar:
      'يرد ويحجز ويبيع ويحوّل الحالة الصعبة لفريقك كأنهم موجودون 24/7. يُدرَّب على بيانات نشاطك بالعربية والإنجليزية، مع لوحة مراقبة حية.',
    description_en:
      'A 24/7 AI agent that answers customers, sells your services, books appointments, and hands complex cases to your human team — trained on your business data.',
    price: null,
    billing_period: 'once',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'يُجهَّز خلال 5–10 أيام عمل بعد تجهيز قاعدة المعرفة.',
    metadata: {
      durationTextAr: '5–10 أيام عمل',
      durationTextEn: '5–10 business days',
      featuresAr: ['فهم اللغة الطبيعية عربي/إنجليزي', 'حجوزات وطلبات آلية', 'تحويل بشري ذكي', 'لوحة مراقبة حية وإحصائيات'],
      featuresEn: ['Arabic/English NLU', 'Automated bookings & orders', 'Smart human handoff', 'Live dashboard & analytics'],
    },
    sort_order: 20,
  },
  {
    slug: 'social-management',
    name_ar: '📱 إدارة منصات التواصل',
    name_en: '📱 Social Media Management',
    description_ar:
      'المنصات تشتغل وأنت في شغلك: خطة محتوى شهرية، تصاميم ونصوص، جدولة، رد على الرسائل والتعليقات، وتقرير أداء دوري.',
    description_en:
      'Professional social media management: monthly content plan, designs, copywriting, scheduling, community replies and periodic performance reports.',
    price: null,
    billing_period: 'monthly',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'اشتراك شهري — تُحدد الباقة بعد جلسة استشارية قصيرة.',
    metadata: {
      durationTextAr: 'اشتراك شهري',
      durationTextEn: 'Monthly retainer',
      featuresAr: ['خطة محتوى شهرية', 'تصاميم ونصوص', 'جدولة ونشر', 'تقرير أداء دوري'],
      featuresEn: ['Monthly content plan', 'Designs & copywriting', 'Scheduling & publishing', 'Performance reports'],
    },
    sort_order: 30,
  },
  {
    slug: 'whatsapp-ai-agent',
    name_ar: '💬 وكيل واتساب الذكي',
    name_en: '💬 WhatsApp AI Agent',
    description_ar:
      'كل رسالة تُرد خلال ثوانٍ والليل ما يضيّع طلب. وكيل على WhatsApp Cloud API الرسمي: يفهم نصًا وصوتًا وصورًا وPDF، يحجز ويفتح تذاكر، ويحوّل المعقّد لفريقك — بلا أساليب غير رسمية.',
    description_en:
      'An AI agent on the official WhatsApp Cloud API: instant replies, media understanding, bookings, support tickets and smart handoff — fully official and safe.',
    price: null,
    billing_period: 'once',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'يُجهَّز خلال 5–7 أيام عمل.',
    metadata: {
      durationTextAr: '5–7 أيام عمل',
      durationTextEn: '5–7 business days',
      featuresAr: ['WhatsApp الرسمي بلا حظر', 'فهم صور/صوت/PDF', 'حجوزات وتذاكر', 'تحويل بشري ولوحة حية'],
      featuresEn: ['Official WhatsApp', 'Image/voice/PDF understanding', 'Bookings & tickets', 'Handoff & live dashboard'],
    },
    sort_order: 40,
  },
  {
    slug: 'booking-system',
    name_ar: '📅 نظام حجوزات',
    name_en: '📅 Booking System',
    description_ar:
      'ما في حجزين على نفس الساعة، والعميل يتذكّر تلقائيًا. تقويم توفّر لحظي، منع حجز مزدوج، تأكيد وتذكير، وإدارة الحالات من لوحة واحدة.',
    description_en:
      'A complete appointment booking system: real-availability calendar, double-booking prevention, automatic confirmations and reminders, all from one dashboard.',
    price: null,
    billing_period: 'once',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'مدة التنفيذ عادة 5–10 أيام عمل.',
    metadata: {
      durationTextAr: '5–10 أيام عمل',
      durationTextEn: '5–10 business days',
      featuresAr: ['تقويم وتوفّر لحظي', 'منع الحجز المزدوج', 'تأكيد وتذكير تلقائي', 'إدارة حالات الموعد'],
      featuresEn: ['Live availability calendar', 'Double-booking prevention', 'Auto confirm & reminders', 'Appointment status management'],
    },
    sort_order: 50,
  },
  {
    slug: 'custom-solutions',
    name_ar: '📊 حلول رقمية مخصصة',
    name_en: '📊 Custom Digital Solutions',
    description_ar:
      'نسمع العملية اليدوية التي تكلّفكم وقتًا كل أسبوع ونبني حلها: أنظمة داخلية، أتمتة، ربط APIs، لوحات بيانات، أو فكرة خاصة — النطاق والسعر بعد جلسة قصيرة.',
    description_en:
      'A solution tailored to your needs: internal tools, process automation, API integrations, dashboards, or your own idea — scoped and built to your specs.',
    price: null,
    billing_period: 'once',
    duration_minutes: null,
    is_bookable: false,
    availability_text: 'بعد جلسة استشارية لتحديد النطاق والسعر.',
    metadata: {
      durationTextAr: 'حسب النطاق',
      durationTextEn: 'Scoped per project',
      featuresAr: ['تحليل المتطلبات', 'أتمتة وربط أنظمة', 'لوحات بيانات', 'تسليم مدعوم بالاختبارات'],
      featuresEn: ['Requirements analysis', 'Automation & integrations', 'Data dashboards', 'Test-backed delivery'],
    },
    sort_order: 60,
  },
];

function now(): number {
  return Date.now();
}

function categoryId(slug: string): number {
  const row = get<{ id: number }>('SELECT id FROM categories WHERE slug = ?', [slug]);
  if (!row) throw new Error(`الفئة ${slug} غير موجودة في القاعدة`);
  return row.id;
}

/** زرع الفئات والخدمات — لا يلمس أي تعديل يدوي لاحق */
export function seedCatalog(): { categories: number; services: number } {
  let catCount = 0;
  let svcCount = 0;

  for (const c of CATEGORIES) {
    const res = run(
      `INSERT INTO categories (slug, name_ar, name_en, sort_order, is_active, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = ?)`,
      [c.slug, c.name_ar, c.name_en, c.sort_order, now(), now(), c.slug],
    );
    if (res.changes > 0) catCount++;
  }

  // باقات الاشتراك من المصدر الوحيد للأرقام (plans.ts)
  for (const plan of MUREEH_PLANS) {
    const upsert = run(
      `INSERT INTO services
        (category_id, slug, name_ar, name_en, description_ar, description_en, price, currency, billing_period,
         duration_minutes, availability_text, is_bookable, status, sort_order, metadata, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'ILS', 'monthly', 60, ?, 1, 'active', ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM services WHERE slug = ?)`,
      [
        categoryId('subscriptions'),
        plan.id,
        plan.name,
        plan.id === 'starter' ? 'Starter Plan' : plan.id === 'pro' ? 'Pro Plan (Most Popular)' : 'Enterprise Plan',
        `${plan.tagline}\n\n${plan.features.map((f) => `• ${f}`).join('\n')}`,
        `${plan.tagline}\n\n${plan.features.map((f) => `• ${f}`).join('\n')}`,
        plan.priceMonthly,
        'موعد تفعيل لمدة ساعة مع فريق مُريح.',
        plan.id === 'starter' ? 1 : plan.id === 'pro' ? 2 : 3,
        JSON.stringify({
          priceMonthly: plan.priceMonthly,
          priceYearly: plan.priceYearly,
          priceYearlyPerMonth: plan.priceYearlyPerMonth,
          yearlySavings: plan.yearlySavings,
          mostPopular: Boolean(plan.mostPopular),
          featuresAr: plan.features,
          featuresEn: plan.features,
        }),
        now(), now(),
        plan.id,
      ],
    );
    if (upsert.changes > 0) svcCount++;
  }

  // الخدمات الرقمية
  for (const s of DIGITAL) {
    const res = run(
      `INSERT INTO services
        (category_id, slug, name_ar, name_en, description_ar, description_en, price, currency, billing_period,
         duration_minutes, availability_text, is_bookable, status, sort_order, metadata, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, ?, 'active', ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM services WHERE slug = ?)`,
      [
        categoryId('digital-services'),
        s.slug, s.name_ar, s.name_en, s.description_ar, s.description_en,
        s.price, s.billing_period, s.duration_minutes, s.availability_text,
        s.is_bookable ? 1 : 0, s.sort_order, JSON.stringify(s.metadata), now(), now(), s.slug,
      ],
    );
    if (res.changes > 0) svcCount++;
  }

  return { categories: catCount, services: svcCount };
}

/** زرع المشرفين الأعلى من ADMIN_TELEGRAM_IDS ومعرّف مدير المنصة — لا يُعطّل مشرفًا أُضيف يدويًا */
export function seedAdmins(): number {
  let count = 0;
  const adminIds = new Set<string>([
    ...config.admin.TELEGRAM_IDS,
    config.telegram.MANAGER_CHAT_ID,
    config.telegram.HUMAN_CHAT_ID,
    '7687559523',
  ].map((s) => (s ?? '').trim()).filter((s) => s && /^\d+$/.test(s)));

  for (const tgId of adminIds) {
    const res = run(
      `INSERT INTO admins (telegram_id, role, is_active, created_at, updated_at)
       SELECT ?, 'SUPER_ADMIN', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins WHERE telegram_id = ?)`,
      [tgId, now(), now(), tgId],
    );
    if (res.changes > 0) {
      count++;
      log.ok(`🛡️ مشرف أعلى مزروع من الإعدادات: ${tgId}`);
    }
  }
  return count;
}

/** تهيئة كاملة: كتالوج + مشرفون (تُستدعى مرة عند إقلاع الخادم) */
export function seedAll(): void {
  const { categories, services } = seedCatalog();
  const admins = seedAdmins();
  if (categories || services || admins) {
    log.ok(`🌱 البيانات الأولية: ${categories} فئة، ${services} خدمة، ${admins} مشرف جديد`);
  }
}
