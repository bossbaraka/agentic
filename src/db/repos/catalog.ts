/** مستودع كتالوج الفئات والخدمات (ديناميكي من قاعدة البيانات) */
import { all, get, run, parseJson } from '../client.js';
import type { CategoryRow, ServiceRow, ServiceStatus } from '../types.js';

export interface ServiceMeta {
  priceMonthly?: number;
  priceYearly?: number;
  priceYearlyPerMonth?: number;
  yearlySavings?: number;
  mostPopular?: boolean;
  featuresAr?: string[];
  featuresEn?: string[];
  durationTextAr?: string;
  durationTextEn?: string;
  [k: string]: unknown;
}

export function listCategories(activeOnly = true): CategoryRow[] {
  return all<CategoryRow>(
    `SELECT * FROM categories ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, id`,
  );
}

export function listServices(opts: { categorySlug?: string; activeOnly?: boolean } = {}): (ServiceRow & { category_slug: string; category_name_ar: string; category_name_en: string })[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.activeOnly !== false) where.push("s.status = 'active'");
  if (opts.categorySlug) {
    where.push('c.slug = ?');
    params.push(opts.categorySlug);
  }
  return all(`
    SELECT s.*, c.slug AS category_slug, c.name_ar AS category_name_ar, c.name_en AS category_name_en
    FROM services s JOIN categories c ON c.id = s.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.sort_order, s.sort_order, s.id`, params);
}

export function getService(idOrSlug: string | number): ServiceRow | undefined {
  if (typeof idOrSlug === 'number' || /^\d+$/.test(String(idOrSlug))) {
    return get<ServiceRow>('SELECT * FROM services WHERE id = ?', [Number(idOrSlug)]);
  }
  return get<ServiceRow>('SELECT * FROM services WHERE slug = ?', [String(idOrSlug)]);
}

/** يُرجع خدمة الاشتراك بسلغ الباقة (starter/pro/enterprise) — للتوافق الخلفي مع الحجوزات */
export function getServiceBySlug(slug: string): ServiceRow | undefined {
  return get<ServiceRow>('SELECT * FROM services WHERE slug = ?', [slug]);
}

export function serviceMeta(s: ServiceRow): ServiceMeta {
  return parseJson<ServiceMeta>(s.metadata, {});
}

export function serviceName(s: ServiceRow, lang: 'ar' | 'en'): string {
  return lang === 'en' && s.name_en ? s.name_en : s.name_ar;
}

export function serviceDescription(s: ServiceRow, lang: 'ar' | 'en'): string {
  return lang === 'en' && s.description_en ? s.description_en : s.description_ar;
}

export interface ServiceInput {
  categoryId: number;
  slug: string;
  nameAr: string;
  nameEn?: string;
  descriptionAr?: string;
  descriptionEn?: string;
  price?: number | null;
  billingPeriod?: ServiceRow['billing_period'];
  durationMinutes?: number | null;
  availabilityText?: string;
  isBookable?: boolean;
  status?: ServiceStatus;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export function createService(input: ServiceInput): number {
  const now = Date.now();
  const r = run(
    `INSERT INTO services
      (category_id, slug, name_ar, name_en, description_ar, description_en, price, billing_period,
       duration_minutes, availability_text, is_bookable, status, sort_order, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.categoryId, input.slug, input.nameAr, input.nameEn ?? '', input.descriptionAr ?? '',
      input.descriptionEn ?? '', input.price ?? null, input.billingPeriod ?? null,
      input.durationMinutes ?? null, input.availabilityText ?? '', input.isBookable === false ? 0 : 1,
      input.status ?? 'active', input.sortOrder ?? 0, JSON.stringify(input.metadata ?? {}), now, now,
    ],
  );
  return r.lastInsertRowid;
}

export function setServiceStatus(id: number, status: ServiceStatus): void {
  run('UPDATE services SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
}

export function setServicePrice(id: number, price: number | null, billingPeriod?: ServiceRow['billing_period']): void {
  run('UPDATE services SET price = ?, billing_period = COALESCE(?, billing_period), updated_at = ? WHERE id = ?',
    [price, billingPeriod ?? null, Date.now(), id]);
}
