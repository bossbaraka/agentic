/**
 * Domain Knowledge layer — restaurant operations knowledge.
 * RAG for Mureeh documentation, operational rules, product/menu knowledge, business policies.
 * Grounded, never hallucinate.
 */

export interface KnowledgeEntry {
  id: string;
  category: 'ORDER_LIFECYCLE' | 'TABLE' | 'PRODUCT' | 'RESTAURANT' | 'OFFERS' | 'BRANCH' | 'PAYMENT' | 'STAFF' | 'SUBSCRIPTION' | 'OPERATIONAL_RULES' | 'FEATURE_DOCS';
  title: string;
  titleAr: string;
  content: string;
  contentAr: string;
  keywords: string[];
  source: string;
}

export const DOMAIN_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'order_lifecycle',
    category: 'ORDER_LIFECYCLE',
    title: 'Order Lifecycle',
    titleAr: 'دورة حياة الطلب',
    content: 'PENDING → PREPARING → READY → SERVED → COMPLETED (or CANCELLED). Each transition has business rules: cannot go back, cancellation only from PENDING/PREPARING, etc.',
    contentAr: 'الطلب يمر: قيد الانتظار PENDING → قيد التحضير PREPARING → جاهز READY → تم التقديم SERVED → مكتمل COMPLETED. الإلغاء ممكن فقط من PENDING أو PREPARING. لا يمكن الرجوع للخلف. الطلب المتأخر هو الذي تجاوز 25 دقيقة في PREPARING.',
    keywords: ['طلب', 'order', 'pending', 'preparing', 'ready', 'served', 'cancelled', 'lifecycle'],
    source: 'prisma schema + manager.ts',
  },
  {
    id: 'table_status',
    category: 'TABLE',
    title: 'Table Status',
    titleAr: 'حالات الطاولة',
    content: 'AVAILABLE (free), OCCUPIED (guests seated, active session), BILL_REQUESTED (guests asked for bill), RESERVED (booked), MAINTENANCE (out of service). Zones: MAIN_HALL, TERRACE, VIP_LOUNGE, GARDEN.',
    contentAr: 'حالات الطاولة: متاحة AVAILABLE، مشغولة OCCUPIED (يوجد جلسة نشطة)، طلبت الحساب BILL_REQUESTED، محجوزة RESERVED، صيانة MAINTENANCE. المناطق: الصالة الرئيسية، التراس، صالة VIP، الحديقة.',
    keywords: ['طاولة', 'table', 'available', 'occupied', 'bill', 'reserved', 'zone'],
    source: 'prisma schema',
  },
  {
    id: 'product_model',
    category: 'PRODUCT',
    title: 'Product Model',
    titleAr: 'نموذج المنتج',
    content: 'Product: id, restaurantId, categoryId, name, nameEn, description, price, imageUrl, available boolean, isFeatured, badge, preparationTimeMinutes default 15, calories, allergens[], ingredients[], removableIngredients[], options (size/variants with priceModifier), addOns (extra with price).',
    contentAr: 'المنتج: اسم، سعر، وصف، صورة، متاح/غير متاح، مميز، شارة، وقت تحضير افتراضي 15 دقيقة، سعرات، مسببات حساسية، مكونات، مكونات قابلة للإزالة، خيارات (حجم/نوع مع تعديل سعر)، إضافات (سعر إضافي).',
    keywords: ['منتج', 'product', 'صنف', 'category', 'addon', 'option', 'price', 'preparation'],
    source: 'prisma schema',
  },
  {
    id: 'waiter_requests',
    category: 'OPERATIONAL_RULES',
    title: 'Waiter Requests',
    titleAr: 'طلبات النادل',
    content: 'WaiterRequest: tableId, sessionId, reason ASSISTANCE/BILL/etc, status PENDING/ACKNOWLEDGED/RESOLVED/CANCELLED. High pending requests indicates staff overload.',
    contentAr: 'طلب النادل: مرتبط بطاولة وجلسة، السبب مساعدة أو حساب أو غيره، الحالات معلق/تم التأكيد/تم الحل/ملغى. كثرة الطلبات المعلقة تشير لضغط على الطاقم.',
    keywords: ['نادل', 'waiter', 'استدعاء', 'request', 'assistance', 'bill'],
    source: 'prisma schema',
  },
  {
    id: 'branch_management',
    category: 'BRANCH',
    title: 'Branch Management',
    titleAr: 'إدارة الفروع',
    content: 'Branch: id, restaurantId, name, address, phone, color, isActive. Tables can belong to branch. Enterprise plan allows up to 10 branches.',
    contentAr: 'الفرع: اسم، عنوان، هاتف، لون، نشط. الطاولات يمكن أن تنتمي لفرع. باقة المؤسسات تسمح حتى 10 فروع.',
    keywords: ['فرع', 'branch', 'multi-branch', 'enterprise'],
    source: 'prisma schema + plans.ts',
  },
  {
    id: 'offers',
    category: 'OFFERS',
    title: 'Offers Management',
    titleAr: 'إدارة العروض',
    content: 'Offer: title, subtitle, description, image, originalPrice, discountedPrice, discountPercentage, badge default عرض خاص, isActive, code. Used for promotions.',
    contentAr: 'العرض: عنوان، وصف، صورة، سعر أصلي، سعر بعد الخصم، نسبة خصم، شارة، نشط، كود. يستخدم للترويج.',
    keywords: ['عرض', 'offer', 'discount', 'promo', 'خصم'],
    source: 'prisma schema',
  },
  {
    id: 'payment_ledger',
    category: 'PAYMENT',
    title: 'Payment Ledger',
    titleAr: 'سجل المدفوعات',
    content: 'Payment: receiptNumber unique per restaurant, tableId (or __WALKIN__), tableLabel, orderIds[], itemsSummary, method CASH/CARD/MOBILE/SPLIT, subtotal, tax, total, cashReceived, changeDue, tip, cashierName.',
    contentAr: 'الدفع: رقم إيصال فريد لكل مطعم، طاولة أو مبيعات كاونتر، ملخص أصناف، طريقة دفع نقدي/بطاقة/جوال/مقسّم، إجمالي، مستلم، باقي، إكرامية، اسم الكاشير.',
    keywords: ['دفع', 'payment', 'receipt', 'cashier', 'pos', 'فاتورة'],
    source: 'prisma schema',
  },
  {
    id: 'subscription_entitlements',
    category: 'SUBSCRIPTION',
    title: 'Subscription & Entitlements',
    titleAr: 'الاشتراكات والصلاحيات',
    content: 'Plans: starter (300₪/month, 8 tables, 3 categories, 15 products), pro (550₪, KDS, POS, analytics, branding, offers), enterprise (850₪, 10 branches, 200 tables, 500 products, custom domain). Entitlement CAN_USE_ANALYTICS gates dashboard stats.',
    contentAr: 'الباقات: أساسية 300₪ (8 طاولات، 3 تصنيفات، 15 منتج)، احترافية 550₪ (شاشة مطبخ، POS، تحليلات، هوية، عروض)، مؤسسات 850₪ (10 فروع، 200 طاولة، 500 صنف، نطاق خاص). التحليلات تتطلب صلاحية CAN_USE_ANALYTICS.',
    keywords: ['باقة', 'plan', 'subscription', 'analytics', 'starter', 'pro', 'enterprise'],
    source: 'server/services/plans.ts',
  },
  {
    id: 'operational_anomalies',
    category: 'OPERATIONAL_RULES',
    title: 'Operational Anomalies',
    titleAr: 'الشذوذ التشغيلي',
    content: 'Detect: slow orders (>25min avg), sales drop, product high views low orders, overloaded kitchen (>8 active), high waiter requests (>5 pending), declining product, high cancellation rate (>15%).',
    contentAr: 'كشف الشذوذ: طلبات بطيئة (>25 دقيقة)، انخفاض مبيعات، منتج مشاهدات عالية طلبات قليلة، مطبخ مضغوط (>8 نشط)، طلبات نادل كثيرة (>5 معلق)، منتج متراجع، إلغاء مرتفع (>15%).',
    keywords: ['شذوذ', 'anomaly', 'slow', 'overload', 'cancellation', 'delayed'],
    source: 'analytics.ts',
  },
  {
    id: 'role_permissions',
    category: 'STAFF',
    title: 'Staff Roles & Permissions',
    titleAr: 'أدوار الطاقم وصلاحياته',
    content: 'RESTAURANT_MANAGER: full access. CASHIER: POS, payments, orders. KITCHEN: update order status to PREPARING/READY. WAITER: update waiter requests, table status. STAFF: limited. PLATFORM_ADMIN/SUPER_ADMIN: cross-tenant admin.',
    contentAr: 'مدير المطعم: كامل الصلاحيات. كاشير: POS ومدفوعات وطلبات. مطبخ: تحديث حالة الطلب لتحضير/جاهز. نادل: تحديث طلبات النادل وحالة الطاولة. موظف: محدود. ادمن المنصة: إدارة عبر المستأجرين.',
    keywords: ['دور', 'role', 'manager', 'cashier', 'kitchen', 'waiter', 'staff', 'صلاحية'],
    source: 'middleware/auth.ts',
  },
];

export function searchKnowledge(query: string, limit = 5): KnowledgeEntry[] {
  const lower = query.toLowerCase();
  const scored = DOMAIN_KNOWLEDGE.map((entry) => {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) score += 2;
    }
    if (lower.includes(entry.category.toLowerCase())) score += 1;
    // Arabic matching
    if (entry.contentAr && lower.includes(entry.titleAr.toLowerCase().slice(0, 5))) score += 1;
    return { entry, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);

  return scored;
}

export function getKnowledgeByCategory(category: KnowledgeEntry['category']): KnowledgeEntry[] {
  return DOMAIN_KNOWLEDGE.filter((k) => k.category === category);
}

export function renderKnowledgeForPrompt(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => `## ${e.titleAr} (${e.category})\n${e.contentAr}\nSource: ${e.source}`)
    .join('\n\n');
}
