/**
 * Restaurant domain types — mirrors restaurantsMureeh Prisma schema
 * but simplified for agent consumption. No direct DB access, only
 * via Mureeh API.
 */

export type TenantRole =
  | 'PLATFORM_ADMIN'
  | 'SUPER_ADMIN'
  | 'RESTAURANT_MANAGER'
  | 'STAFF'
  | 'WAITER'
  | 'KITCHEN'
  | 'CASHIER';

export type OrderStatus = 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
export type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'BILL_REQUESTED' | 'RESERVED' | 'MAINTENANCE';
export type TableZone = 'MAIN_HALL' | 'TERRACE' | 'VIP_LOUNGE' | 'GARDEN';
export type WaiterRequestStatus = 'PENDING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CANCELLED';
export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED' | 'SUSPENDED';

export interface Restaurant {
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
  logoUrl?: string;
  coverImageUrl?: string;
  description?: string;
  phone?: string;
  address?: string;
  currency: string;
  language: string;
  timezone: string;
  status: string;
  businessType: 'RESTAURANT' | 'CAFE' | 'BAKERY';
  primaryColor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Branch {
  id: string;
  restaurantId: string;
  name: string;
  address?: string;
  phone?: string;
  color?: string;
  isActive: boolean;
  createdAt: string;
}

export interface Category {
  id: string;
  restaurantId: string;
  name: string;
  nameEn?: string;
  description?: string;
  image?: string;
  sortOrder: number;
  status: string;
}

export interface Product {
  id: string;
  restaurantId: string;
  categoryId: string;
  categoryName?: string;
  name: string;
  nameEn?: string;
  description?: string;
  price: number;
  imageUrl?: string;
  available: boolean;
  isFeatured: boolean;
  badge?: string;
  preparationTimeMinutes?: number;
  calories?: number;
  allergens?: string[];
  ingredients?: string[];
  removableIngredients?: string[];
  sortOrder: number;
  createdAt?: string;
  options?: ProductOption[];
  addOns?: AddOn[];
}

export interface ProductOption {
  id: string;
  productId: string;
  name: string;
  nameEn?: string;
  price: number;
  priceModifier?: number;
  required: boolean;
}

export interface AddOn {
  id: string;
  productId: string;
  name: string;
  nameEn?: string;
  price: number;
  isAvailable: boolean;
}

export interface Table {
  id: string;
  restaurantId: string;
  branchId?: string | null;
  number: number;
  zone: TableZone;
  status: TableStatus;
  capacity?: number;
  qrToken?: string;
  createdAt?: string;
}

export interface TableSession {
  id: string;
  restaurantId: string;
  tableId: string;
  tableNumber?: number;
  sessionToken: string;
  status: 'ACTIVE' | 'CLOSED';
  startedAt: string;
  endedAt?: string | null;
  expiresAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId?: string | null;
  productNameSnapshot: string;
  productNameEnSnapshot?: string | null;
  priceSnapshot: number;
  quantity: number;
  selectedSize?: string | null;
  selectedAddOns: string[];
  removedIngredients: string[];
  specialInstructions?: string | null;
  notes?: string | null;
  totalPrice: number;
}

export interface Order {
  id: string;
  numericId?: number;
  restaurantId: string;
  tableId: string;
  tableNumber?: number;
  sessionId?: string | null;
  clientRequestId?: string;
  status: OrderStatus;
  paymentMethod: string;
  paymentStatus: string;
  settledAt?: string | null;
  cashierId?: string | null;
  branchId?: string | null;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string | null;
  estimatedPrepMinutes?: number | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  // computed
  elapsedMinutes?: number;
  isDelayed?: boolean;
}

export interface WaiterRequest {
  id: string;
  restaurantId: string;
  tableId: string;
  tableNumber?: number;
  sessionId?: string | null;
  reason: string;
  reasonText?: string | null;
  status: WaiterRequestStatus;
  createdAt: string;
  resolvedAt?: string | null;
  elapsedMinutes?: number;
}

export interface Offer {
  id: string;
  restaurantId: string;
  title: string;
  titleEn?: string | null;
  subtitle?: string | null;
  description?: string | null;
  image?: string | null;
  originalPrice?: number | null;
  discountedPrice?: number | null;
  discountPercentage?: number | null;
  badge?: string | null;
  isActive: boolean;
  code?: string | null;
  createdAt: string;
}

export interface DashboardStats {
  restaurant: Restaurant;
  subscription: {
    status: SubscriptionStatus;
    planId?: string;
    planName?: string;
  } | null;
  plan: {
    id: string;
    name: string;
    maxTables: number;
    maxProducts: number;
  } | null;
  totalRevenue: number;
  todayRevenue: number;
  todayOrdersCount: number;
  activeTablesCount: number;
  totalTablesCount: number;
  pendingOrdersCount: number;
  preparingOrdersCount: number;
  readyOrdersCount: number;
  pendingWaitersCount: number;
  averageOrderValue: number;
  popularProducts: { name: string; count: number; revenue: number }[];
}

export interface SalesAnalytics {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  ordersByHour: { hour: number; count: number }[];
  ordersByDay: { date: string; count: number; revenue: number }[];
  topProducts: { productId: string; name: string; count: number; revenue: number }[];
  slowProducts: { productId: string; name: string; count: number }[];
  peakHours: { hour: number; count: number }[];
  cancellations: { count: number; rate: number };
  preparationTime: { average: number; p95: number; delayedCount: number };
}

export interface OperationalAnalytics {
  pendingOrders: number;
  preparingOrders: number;
  readyOrders: number;
  delayedOrders: Order[];
  occupiedTables: Table[];
  billRequestedTables: Table[];
  pendingWaiterRequests: WaiterRequest[];
  averagePrepTime: number;
  kitchenLoad: 'LOW' | 'MEDIUM' | 'HIGH' | 'OVERLOADED';
  anomalies: OperationalAnomaly[];
}

export interface OperationalAnomaly {
  type: 'SLOW_ORDERS' | 'SALES_DROP' | 'LOW_VIEWS_HIGH_ORDERS' | 'KITCHEN_OVERLOAD' | 'HIGH_WAITER_REQUESTS' | 'DECLINING_PRODUCT' | 'HIGH_CANCELLATION' | 'LONG_PREP_TIME';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  message: string;
  messageAr: string;
  data?: Record<string, unknown>;
  hypothesis?: string;
  hypothesisAr?: string;
}

// Tool execution context with auth
export interface MureehToolContext {
  requestId: string;
  userId?: string;
  restaurantId: string;
  branchId?: string | null;
  role: TenantRole;
  language: 'ar' | 'en';
  // original contact key from agentic (WhatsApp number, Telegram id)
  contactKey?: string;
  // JWT for forwarding to Mureeh API
  authToken?: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  // user-facing message (already localized, safe to show)
  userMessage?: string;
  // for observability
  latencyMs?: number;
  source: 'api' | 'cache' | 'demo' | 'calculation';
}

// For planning
export interface TaskPlan {
  goal: string;
  steps: TaskStep[];
  estimatedTools: number;
}

export interface TaskStep {
  id: string;
  description: string;
  descriptionAr: string;
  tool?: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  parallelizable: boolean;
  required: boolean;
}
