/** أنواع صفوف قاعدة البيانات — تطابق مخطط الهجرة 1:1 */

export type Lang = 'ar' | 'en' | 'he';
export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type ServiceStatus = 'active' | 'inactive' | 'hidden';

export interface UserRow {
  id: number;
  channel: 'tg' | 'wa';
  channel_user_id: string;
  username: string | null;
  display_name: string | null;
  phone: string | null;
  language: Lang;
  is_blocked: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}

export interface CustomerRow {
  id: number;
  user_id: number;
  code: string | null;
  full_name: string | null;
  restaurant_name: string | null;
  city: string | null;
  tables: number | null;
  branches: number | null;
  preferred_plan: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminRow {
  id: number;
  telegram_id: string | null;
  user_id: number | null;
  username: string | null;
  display_name: string | null;
  role: Role;
  is_active: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface CategoryRow {
  id: number;
  slug: string;
  name_ar: string;
  name_en: string;
  sort_order: number;
  is_active: number;
}

export interface ServiceRow {
  id: number;
  category_id: number;
  slug: string;
  name_ar: string;
  name_en: string;
  description_ar: string;
  description_en: string;
  price: number | null;
  currency: string;
  billing_period: 'once' | 'monthly' | 'yearly' | 'hourly' | null;
  duration_minutes: number | null;
  availability_text: string;
  is_bookable: number;
  status: ServiceStatus;
  sort_order: number;
  metadata: string;
}

export interface BookingRow {
  id: number;
  ref: string;
  idempotency_key: string | null;
  customer_id: number | null;
  user_id: number | null;
  service_id: number | null;
  plan_slug: string | null;
  contact_key: string;
  full_name: string | null;
  slot_date: string;
  slot_time: string;
  slot_epoch_ms: number;
  duration_minutes: number;
  status: BookingStatus;
  notes: string | null;
  cancellation_reason: string | null;
  reminded_hours: string;
  created_by_admin_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface OrderRow {
  id: number;
  ref: string;
  idempotency_key: string | null;
  kind: 'launch' | 'service_inquiry' | 'custom';
  customer_id: number | null;
  user_id: number | null;
  service_id: number | null;
  contact_key: string;
  summary: string;
  status: 'PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  total_amount: number | null;
  currency: string;
  payload: string;
  assigned_admin_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface TicketRow {
  id: number;
  ref: string;
  customer_id: number | null;
  user_id: number | null;
  conversation_id: number | null;
  contact_key: string;
  restaurant_name: string | null;
  plan: string | null;
  issue: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  assigned_admin_id: number | null;
  resolution: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationRow {
  id: number;
  user_id: number | null;
  channel: 'tg' | 'wa';
  contact_key: string;
  display_name: string;
  state: 'bot' | 'human' | 'paused';
  summary: string;
  handoff_reason: string | null;
  assigned_admin_id: number | null;
  last_inbound_at: number;
  last_outbound_at: number;
  created_at: number;
  updated_at: number;
}

export interface NotificationRow {
  id: number;
  kind: string;
  channel: string | null;
  target_key: string | null;
  subject: string;
  payload: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attempts: number;
  max_attempts: number;
  run_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
