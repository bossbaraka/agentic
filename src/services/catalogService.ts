/** خدمة الكتالوج — الكتالوج ديناميكي بالكامل من قاعدة البيانات */
import {
  listCategories,
  listServices,
  getService,
  setServiceStatus,
  setServicePrice,
  type ServiceMeta,
  serviceMeta,
  createService,
} from '../db/repos/catalog.js';
import { audit } from '../db/repos/system.js';
import type { CategoryRow, ServiceRow, ServiceStatus } from '../db/types.js';

export interface ServiceView {
  id: number;
  slug: string;
  categorySlug: string;
  name: string;
  description: string;
  price: number | null;
  billingPeriod: ServiceRow['billing_period'];
  durationText?: string;
  availabilityText: string;
  isBookable: boolean;
  features: string[];
  meta: ServiceMeta;
}

export const catalogService = {
  categories(activeOnly = true): CategoryRow[] {
    return listCategories(activeOnly);
  },

  /** خدمات نشطة مصنّفة (للقوائم والأدوات) */
  byCategory(lang: 'ar' | 'en' = 'ar'): { category: CategoryRow; services: ServiceView[] }[] {
    const services = listServices({ activeOnly: true });
    const views = services.map((s) => this.view(s, lang));
    return listCategories(true).map((category) => ({
      category,
      services: views.filter((v) => {
        const row = services.find((r) => r.id === v.id);
        return row?.category_id === category.id;
      }),
    })).filter((g) => g.services.length > 0);
  },

  /** صفحة خدمات مسطّحة مع ترقيم (Pagination) */
  paginated(page = 0, pageSize = 6, lang: 'ar' | 'en' = 'ar'): { items: ServiceView[]; page: number; pages: number; total: number } {
    const all = listServices({ activeOnly: true }).map((s) => this.view(s, lang));
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    return {
      items: all.slice(safePage * pageSize, safePage * pageSize + pageSize),
      page: safePage,
      pages,
      total: all.length,
    };
  },

  byCategorySlug(slug: string, lang: 'ar' | 'en' = 'ar'): { category: CategoryRow; services: ServiceView[] } | undefined {
    const category = listCategories(true).find((c) => c.slug === slug);
    if (!category) return undefined;
    return {
      category,
      services: listServices({ categorySlug: slug, activeOnly: true }).map((s) => this.view(s, lang)),
    };
  },

  view(s: ServiceRow, lang: 'ar' | 'en' = 'ar'): ServiceView {
    const meta = serviceMeta(s);
    const features = lang === 'en'
      ? (meta.featuresEn as string[] | undefined) ?? meta.featuresAr ?? []
      : (meta.featuresAr as string[] | undefined) ?? [];
    const durationText = lang === 'en'
      ? (meta.durationTextEn as string | undefined) ?? (meta.durationTextAr as string)
      : (meta.durationTextAr as string | undefined) ?? (meta.durationTextEn as string);
    return {
      id: s.id,
      slug: s.slug,
      categorySlug: '',
      name: lang === 'en' && s.name_en ? s.name_en : s.name_ar,
      description: lang === 'en' && s.description_en ? s.description_en : s.description_ar,
      price: s.price,
      billingPeriod: s.billing_period,
      durationText,
      availabilityText: s.availability_text,
      isBookable: s.is_bookable === 1,
      features,
      meta,
    };
  },

  details(idOrSlug: string | number, lang: 'ar' | 'en' = 'ar'): ServiceView | undefined {
    const row = getService(idOrSlug);
    if (!row) return undefined;
    const view = this.view(row, lang);
    const cat = listCategories().find((c) => c.id === row.category_id);
    view.categorySlug = cat?.slug ?? '';
    return view;
  },

  // ───────── إدارية ─────────

  adminList(): ServiceRow[] {
    return listServices({ activeOnly: false });
  },

  setStatus(adminId: number, idOrSlug: string, status: ServiceStatus): ServiceRow {
    const row = getService(idOrSlug);
    if (!row) throw new Error('الخدمة غير موجودة');
    setServiceStatus(row.id, status);
    audit({ actorType: 'admin', actorId: String(adminId), action: 'service.setStatus', entity: 'service', entityId: row.slug, meta: { status } });
    return { ...row, status };
  },

  setPrice(adminId: number, idOrSlug: string, price: number | null): ServiceRow {
    const row = getService(idOrSlug);
    if (!row) throw new Error('الخدمة غير موجودة');
    setServicePrice(row.id, price);
    audit({ actorType: 'admin', actorId: String(adminId), action: 'service.setPrice', entity: 'service', entityId: row.slug, meta: { price } });
    return { ...row, price };
  },

  create(adminId: number, input: Parameters<typeof createService>[0]): number {
    const id = createService(input);
    audit({ actorType: 'admin', actorId: String(adminId), action: 'service.create', entity: 'service', entityId: String(id) });
    return id;
  },
};
