/**
 * Demo data for Mureeh tools — used when MUREEH_API_URL not configured
 * or MUREEH_DEMO_MODE=true. Provides realistic restaurant data for testing
 * and evaluation without requiring live API.
 */

import type { Order, Product, Category, Table, WaiterRequest, Offer, Branch, DashboardStats, Restaurant } from '../types.js';

export const demoRestaurant: Restaurant = {
  id: 'demo-restaurant-1',
  name: 'مطعم الشام الأصيل',
  nameEn: 'Al-Sham Authentic',
  slug: 'al-sham-authentic',
  logoUrl: '',
  currency: '₪',
  language: 'ar',
  timezone: 'Asia/Jerusalem',
  status: 'ACTIVE',
  businessType: 'RESTAURANT',
  primaryColor: '#D4AF37',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const demoCategories: Category[] = [
  { id: 'cat-1', restaurantId: 'demo-restaurant-1', name: 'المقبلات', nameEn: 'Appetizers', sortOrder: 0, status: 'ACTIVE' },
  { id: 'cat-2', restaurantId: 'demo-restaurant-1', name: 'الوجبات الرئيسية', nameEn: 'Main Courses', sortOrder: 1, status: 'ACTIVE' },
  { id: 'cat-3', restaurantId: 'demo-restaurant-1', name: 'المشروبات', nameEn: 'Drinks', sortOrder: 2, status: 'ACTIVE' },
  { id: 'cat-4', restaurantId: 'demo-restaurant-1', name: 'الحلويات', nameEn: 'Desserts', sortOrder: 3, status: 'ACTIVE' },
];

export const demoProducts: Product[] = [
  { id: 'prod-1', restaurantId: 'demo-restaurant-1', categoryId: 'cat-2', categoryName: 'الوجبات الرئيسية', name: 'برغر الدجاج', nameEn: 'Chicken Burger', description: 'برغر دجاج فاخر مع صوص خاص', price: 45, imageUrl: '', available: true, isFeatured: true, preparationTimeMinutes: 12, sortOrder: 0 },
  { id: 'prod-2', restaurantId: 'demo-restaurant-1', categoryId: 'cat-2', categoryName: 'الوجبات الرئيسية', name: 'شاورما لحم', nameEn: 'Meat Shawarma', description: 'شاورما لحم مع خضار', price: 38, imageUrl: '', available: true, isFeatured: true, preparationTimeMinutes: 10, sortOrder: 1 },
  { id: 'prod-3', restaurantId: 'demo-restaurant-1', categoryId: 'cat-1', categoryName: 'المقبلات', name: 'حمص', nameEn: 'Hummus', description: 'حمص بلدي', price: 18, imageUrl: '', available: true, isFeatured: false, preparationTimeMinutes: 5, sortOrder: 2 },
  { id: 'prod-4', restaurantId: 'demo-restaurant-1', categoryId: 'cat-2', categoryName: 'الوجبات الرئيسية', name: 'كباب', nameEn: 'Kebab', description: 'كباب مشوي', price: 55, imageUrl: '', available: true, isFeatured: false, preparationTimeMinutes: 20, sortOrder: 3 },
  { id: 'prod-5', restaurantId: 'demo-restaurant-1', categoryId: 'cat-3', categoryName: 'المشروبات', name: 'عصير برتقال', nameEn: 'Orange Juice', description: 'عصير طازج', price: 12, imageUrl: '', available: true, isFeatured: false, preparationTimeMinutes: 3, sortOrder: 4 },
  { id: 'prod-6', restaurantId: 'demo-restaurant-1', categoryId: 'cat-4', categoryName: 'الحلويات', name: 'كنافة', nameEn: 'Kunafa', description: 'كنافة نابلسية', price: 22, imageUrl: '', available: false, isFeatured: false, preparationTimeMinutes: 15, sortOrder: 5 },
];

export const demoTables: Table[] = [
  { id: 'table-1', restaurantId: 'demo-restaurant-1', branchId: null, number: 1, zone: 'MAIN_HALL', status: 'OCCUPIED', capacity: 4 },
  { id: 'table-2', restaurantId: 'demo-restaurant-1', branchId: null, number: 2, zone: 'MAIN_HALL', status: 'AVAILABLE', capacity: 2 },
  { id: 'table-3', restaurantId: 'demo-restaurant-1', branchId: null, number: 3, zone: 'TERRACE', status: 'BILL_REQUESTED', capacity: 6 },
  { id: 'table-4', restaurantId: 'demo-restaurant-1', branchId: null, number: 4, zone: 'MAIN_HALL', status: 'OCCUPIED', capacity: 4 },
  { id: 'table-5', restaurantId: 'demo-restaurant-1', branchId: null, number: 5, zone: 'VIP_LOUNGE', status: 'RESERVED', capacity: 8 },
  { id: 'table-6', restaurantId: 'demo-restaurant-1', branchId: null, number: 6, zone: 'MAIN_HALL', status: 'OCCUPIED', capacity: 4 },
];

export const demoOrders: Order[] = [
  {
    id: 'order-1',
    numericId: 1042,
    restaurantId: 'demo-restaurant-1',
    tableId: 'table-1',
    tableNumber: 1,
    status: 'PREPARING',
    paymentMethod: 'PAY AT CASHIER',
    paymentStatus: 'UNPAID',
    subtotal: 83,
    tax: 0,
    total: 83,
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    estimatedPrepMinutes: 12,
    elapsedMinutes: 10,
    isDelayed: false,
    items: [
      { id: 'oi-1', orderId: 'order-1', productId: 'prod-1', productNameSnapshot: 'برغر الدجاج', priceSnapshot: 45, quantity: 1, selectedAddOns: [], removedIngredients: [], totalPrice: 45 },
      { id: 'oi-2', orderId: 'order-1', productId: 'prod-3', productNameSnapshot: 'حمص', priceSnapshot: 18, quantity: 1, selectedAddOns: [], removedIngredients: [], totalPrice: 18 },
      { id: 'oi-3', orderId: 'order-1', productId: 'prod-5', productNameSnapshot: 'عصير برتقال', priceSnapshot: 12, quantity: 1, selectedAddOns: [], removedIngredients: [], totalPrice: 12 },
    ],
  },
  {
    id: 'order-2',
    numericId: 1043,
    restaurantId: 'demo-restaurant-1',
    tableId: 'table-4',
    tableNumber: 4,
    status: 'PENDING',
    paymentMethod: 'PAY AT CASHIER',
    paymentStatus: 'UNPAID',
    subtotal: 93,
    tax: 0,
    total: 93,
    createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    estimatedPrepMinutes: 15,
    elapsedMinutes: 3,
    isDelayed: false,
    items: [
      { id: 'oi-4', orderId: 'order-2', productId: 'prod-2', productNameSnapshot: 'شاورما لحم', priceSnapshot: 38, quantity: 2, selectedAddOns: [], removedIngredients: [], totalPrice: 76 },
      { id: 'oi-5', orderId: 'order-2', productId: 'prod-5', productNameSnapshot: 'عصير برتقال', priceSnapshot: 12, quantity: 1, selectedAddOns: [], removedIngredients: [], totalPrice: 12 },
    ],
  },
  {
    id: 'order-3',
    numericId: 1044,
    restaurantId: 'demo-restaurant-1',
    tableId: 'table-6',
    tableNumber: 6,
    status: 'READY',
    paymentMethod: 'PAY AT CASHIER',
    paymentStatus: 'UNPAID',
    subtotal: 55,
    tax: 0,
    total: 55,
    createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    estimatedPrepMinutes: 20,
    elapsedMinutes: 25,
    isDelayed: true,
    items: [
      { id: 'oi-6', orderId: 'order-3', productId: 'prod-4', productNameSnapshot: 'كباب', priceSnapshot: 55, quantity: 1, selectedAddOns: [], removedIngredients: [], totalPrice: 55 },
    ],
  },
  {
    id: 'order-4',
    numericId: 1045,
    restaurantId: 'demo-restaurant-1',
    tableId: 'table-3',
    tableNumber: 3,
    status: 'SERVED',
    paymentMethod: 'PAY AT CASHIER',
    paymentStatus: 'UNPAID',
    subtotal: 120,
    tax: 0,
    total: 120,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    estimatedPrepMinutes: 15,
    elapsedMinutes: 50,
    isDelayed: false,
    items: [
      { id: 'oi-7', orderId: 'order-4', productId: 'prod-1', productNameSnapshot: 'برغر الدجاج', priceSnapshot: 45, quantity: 2, selectedAddOns: [], removedIngredients: [], totalPrice: 90 },
    ],
  },
];

export const demoWaiterRequests: WaiterRequest[] = [
  { id: 'wr-1', restaurantId: 'demo-restaurant-1', tableId: 'table-1', tableNumber: 1, reason: 'ASSISTANCE', status: 'PENDING', createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), elapsedMinutes: 5 },
  { id: 'wr-2', restaurantId: 'demo-restaurant-1', tableId: 'table-3', tableNumber: 3, reason: 'BILL', reasonText: 'طلب الحساب', status: 'PENDING', createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), elapsedMinutes: 2 },
];

export const demoOffers: Offer[] = [
  { id: 'offer-1', restaurantId: 'demo-restaurant-1', title: 'عرض الغداء', titleEn: 'Lunch Offer', description: 'برغر + عصير بـ 50₪', originalPrice: 57, discountedPrice: 50, discountPercentage: 12, isActive: true, createdAt: new Date().toISOString() },
];

export const demoBranches: Branch[] = [
  { id: 'branch-1', restaurantId: 'demo-restaurant-1', name: 'الفرع الرئيسي', address: 'رام الله', isActive: true, createdAt: new Date().toISOString() },
];

export const demoStats: DashboardStats = {
  restaurant: demoRestaurant,
  subscription: { status: 'ACTIVE', planId: 'pro', planName: 'الاحترافية' },
  plan: { id: 'pro', name: 'الاحترافية', maxTables: 50, maxProducts: 150 },
  totalRevenue: 12500,
  todayRevenue: 351,
  todayOrdersCount: 4,
  activeTablesCount: 3,
  totalTablesCount: 6,
  pendingOrdersCount: 1,
  preparingOrdersCount: 1,
  readyOrdersCount: 1,
  pendingWaitersCount: 2,
  averageOrderValue: 87,
  popularProducts: [
    { name: 'برغر الدجاج', count: 12, revenue: 540 },
    { name: 'شاورما لحم', count: 8, revenue: 304 },
    { name: 'حمص', count: 6, revenue: 108 },
  ],
};

export function getDemoDataForTool(toolName: string, args: Record<string, unknown>): any {
  switch (toolName) {
    case 'getRestaurant':
      return demoRestaurant;
    case 'getMenu':
      return { categories: demoCategories, products: demoProducts };
    case 'getCategories':
      return demoCategories;
    case 'getProducts':
      return demoProducts;
    case 'getProduct':
      return demoProducts.find((p) => p.id === args.productId || p.name === args.productName) || demoProducts[0];
    case 'getOrders':
      return demoOrders;
    case 'getOrder':
      return demoOrders.find((o) => o.id === args.orderId || String(o.numericId) === String(args.orderId)) || demoOrders[0];
    case 'getTableStatus':
      return demoTables;
    case 'getWaiterRequests':
      return demoWaiterRequests;
    case 'getOffers':
      return demoOffers;
    case 'getBranches':
      return demoBranches;
    case 'getRestaurantStats':
      return demoStats;
    case 'getSalesAnalytics':
      return {
        totalOrders: 4,
        totalRevenue: 351,
        averageOrderValue: 87,
        ordersByHour: [{ hour: 19, count: 2 }, { hour: 20, count: 2 }],
        ordersByDay: [{ date: new Date().toISOString().split('T')[0], count: 4, revenue: 351 }],
        topProducts: demoStats.popularProducts.map((p, i) => ({ productId: `prod-${i+1}`, name: p.name, count: p.count, revenue: p.revenue })),
        slowProducts: [{ productId: 'prod-6', name: 'كنافة', count: 0 }],
        peakHours: [{ hour: 19, count: 2 }, { hour: 20, count: 2 }],
        cancellations: { count: 0, rate: 0 },
        preparationTime: { average: 15, p95: 25, delayedCount: 1 },
      };
    case 'getOperationalAnalytics':
      return {
        pendingOrders: 1,
        preparingOrders: 1,
        readyOrders: 1,
        delayedOrders: demoOrders.filter((o) => o.isDelayed),
        occupiedTables: demoTables.filter((t) => t.status === 'OCCUPIED'),
        billRequestedTables: demoTables.filter((t) => t.status === 'BILL_REQUESTED'),
        pendingWaiterRequests: demoWaiterRequests.filter((w) => w.status === 'PENDING'),
        averagePrepTime: 15,
        kitchenLoad: 'MEDIUM',
        anomalies: [
          { type: 'SLOW_ORDERS', severity: 'MEDIUM', message: '1 order delayed', messageAr: 'طلب واحد متأخر', hypothesisAr: 'ضغط مطبخ' },
        ],
      };
    default:
      return null;
  }
}
