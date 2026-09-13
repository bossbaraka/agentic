# AGENT TOOLS — Typed Tool System

## Principles
- Strongly typed, validated, permission-aware
- Unique name, description EN+AR, strict input schema, validation, auth requirements, timeout, error handling, structured output
- No direct DB access, no SQL, no env access
- LLM never decides authorization — enforced server-side
- Trust boundaries: SYSTEM INSTRUCTIONS vs USER INPUT vs RETRIEVED DATA vs TOOL OUTPUT

## Tool Result Contract
```ts
interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: 'FORBIDDEN' | 'TENANT_VIOLATION' | 'VALIDATION_ERROR' | 'API_ERROR' | 'EXECUTION_ERROR' | 'TIMEOUT_OR_ERROR' | 'NOT_FOUND';
  userMessage?: string; // safe, localized
  latencyMs?: number;
  source: 'api' | 'cache' | 'demo' | 'calculation';
}
```

## READ Tools (auto-executable)

### getRestaurant
- **Description**: Get restaurant information by restaurantId. Returns name, slug, logo, currency, timezone, business type.
- **AR**: جلب معلومات المطعم
- **Input**: {} (restaurantId from context)
- **Permission**: READ, allowed: MANAGER, STAFF, WAITER, KITCHEN, CASHIER, PLATFORM_ADMIN, SUPER_ADMIN
- **Timeout**: 10s
- **Implementation**: MureehClient.getRestaurant → GET /manager/restaurant?restaurantId
- **Demo**: demoRestaurant

### getMenu
- **Description**: Get full menu: categories and products. Use for menu information queries.
- **AR**: جلب المنيو الكامل
- **Input**: {}
- **Permission**: READ, all staff + platform
- **Timeout**: 10s
- **Implementation**: parallel getCategories + getProducts
- **Demo**: { categories: demoCategories, products: demoProducts }

### getCategories
- **Description**: Get categories for restaurant. Returns id, name, sortOrder, status.
- **AR**: جلب تصنيفات المطعم
- **Input**: {}
- **Permission**: READ
- **Timeout**: 8s
- **Endpoint**: GET /manager/menu/categories?restaurantId

### getProducts
- **Description**: Get products for restaurant. Optional filters: categoryId, available boolean.
- **AR**: جلب منتجات المطعم مع تصفية
- **Input**: { categoryId?: string, available?: boolean }
- **Permission**: READ
- **Timeout**: 10s
- **Endpoint**: GET /manager/menu/products?restaurantId, filtered in tool
- **Demo**: demoProducts

### getProduct
- **Description**: Get single product by productId or productName. Returns price, category, options, addons, prep time.
- **AR**: جلب منتج واحد بالتفصيل
- **Input**: { productId?: string, productName?: string } (one required)
- **Permission**: READ
- **Timeout**: 8s
- **Logic**: fetch all products, find by id or name
- **Demo**: finds in demoProducts

### getOrders
- **Description**: Get orders for restaurant. Filters: status PENDING/PREPARING/READY/SERVED/CANCELLED, from, to, limit. Returns orders with items, table, prep time, delayed flag.
- **AR**: جلب الطلبات مع تصفية
- **Input**: { status?: enum, from?: string, to?: string, limit?: number 1-100 }
- **Permission**: READ, all operational roles
- **Timeout**: 12s
- **Endpoint**: GET /manager/orders?restaurantId&status&...
- **Enrichment**: elapsedMinutes = (now - createdAt)/60000, isDelayed = elapsed>25 && status in PENDING/PREPARING
- **Demo**: demoOrders

### getOrder
- **Description**: Get single order by orderId (id or numericId). Returns full order with items.
- **AR**: جلب طلب واحد
- **Input**: { orderId: string required }
- **Permission**: READ
- **Timeout**: 8s
- **Logic**: demo or fetch all and find, validates ownership
- **Demo**: demoOrders find

### getTableStatus
- **Description**: Get tables status. Returns number, zone, status AVAILABLE/OCCUPIED/BILL_REQUESTED/RESERVED/MAINTENANCE, capacity.
- **AR**: جلب حالة الطاولات
- **Input**: { zone?: enum MAIN_HALL/TERRACE/VIP_LOUNGE/GARDEN, status?: enum }
- **Permission**: READ
- **Timeout**: 8s
- **Endpoint**: GET /manager/tables?restaurantId
- **Demo**: demoTables

### getWaiterRequests
- **Description**: Get waiter requests. Filters: status PENDING/ACKNOWLEDGED/RESOLVED/CANCELLED. Returns table, reason, elapsed minutes.
- **AR**: جلب طلبات استدعاء النادل
- **Input**: { status?: enum }
- **Permission**: READ
- **Timeout**: 8s
- **Endpoint**: GET /manager/waiter-requests?restaurantId
- **Demo**: demoWaiterRequests

### getOffers
- **Description**: Get offers/promotions. Returns title, discount, isActive.
- **AR**: جلب العروض الترويجية
- **Input**: { activeOnly?: boolean }
- **Permission**: READ, MANAGER, STAFF, PLATFORM
- **Timeout**: 8s
- **Endpoint**: GET /manager/offers?restaurantId
- **Demo**: demoOffers

### getBranches
- **Description**: Get branches. Returns id, name, address, isActive.
- **AR**: جلب الفروع
- **Input**: {}
- **Permission**: READ, MANAGER, STAFF, PLATFORM
- **Timeout**: 8s
- **Endpoint**: GET /manager/branches?restaurantId
- **Demo**: demoBranches

### getPayments (bonus)
- **Description**: Read payments ledger
- **Input**: { from, to, limit }
- **Permission**: READ, MANAGER, CASHIER, PLATFORM
- **Endpoint**: GET /manager/payments

### getRestaurantStats
- **Description**: Get dashboard stats: revenue, orders count, active tables, pending orders, preparing, ready, pending waiters, avg order value, popular products. Requires analytics entitlement CAN_USE_ANALYTICS.
- **AR**: جلب إحصائيات لوحة التحكم
- **Input**: {}
- **Permission**: READ, MANAGER, PLATFORM, entitlement CAN_USE_ANALYTICS
- **Timeout**: 12s
- **Endpoint**: GET /manager/dashboard/stats?restaurantId
- **Demo**: demoStats

### getSalesAnalytics
- **Description**: Get sales analytics: total orders, revenue, avg order value, orders by hour/day, top products, slow products, peak hours, cancellations, prep time. Timeframe today/week/month.
- **AR**: جلب تحليلات المبيعات
- **Input**: { timeframe?: enum today/week/month }
- **Permission**: READ, MANAGER, PLATFORM, entitlement CAN_USE_ANALYTICS
- **Timeout**: 15s
- **Implementation**: demo or aggregate from orders (simplified)
- **Demo**: calculated from demoOrders

### getOperationalAnalytics
- **Description**: Get operational analytics: pending/preparing/ready orders, delayed orders, occupied tables, bill requested tables, pending waiter requests, avg prep time, kitchen load, anomalies.
- **AR**: جلب التحليلات التشغيلية
- **Input**: {}
- **Permission**: READ, MANAGER, STAFF, KITCHEN, CASHIER, PLATFORM
- **Timeout**: 15s
- **Implementation**: parallel getOrders (50) + getTables + getWaiterRequests, compute kitchenLoad LOW/MEDIUM/HIGH/OVERLOADED based on pending+preparing count, delayed = elapsed>25
- **Demo**: from demo data

## ACTION Tools (may require approval)

### updateOrderStatus
- **Description**: Update order status: PENDING→PREPARING→READY→SERVED→COMPLETED or CANCELLED. Requires orderId and status. CANCELLING requires approval.
- **AR**: تحديث حالة الطلب
- **Input**: { orderId: string required, status: enum PENDING/PREPARING/READY/SERVED/CANCELLED required }
- **Permission**: WRITE, allowed: MANAGER, KITCHEN, CASHIER, WAITER, STAFF, PLATFORM
- **RequiresApproval**: false normally, but CANCELLED flagged as destructive in approval layer
- **Timeout**: 10s
- **Endpoint**: PUT /manager/orders/:orderId/status { status, restaurantId }
- **Receipt**: "تم تحديث حالة الطلب #1042 إلى جاهز."

### createProduct
- **Description**: Create new product. Requires name, categoryId, price, description. Optional: imageUrl, available, preparationTimeMinutes, calories.
- **AR**: إنشاء منتج جديد
- **Input**: { name: string 2-100 required, categoryId: string required, price: number required, description?: string max 500, imageUrl?: string, available?: boolean, preparationTimeMinutes?: number }
- **Permission**: WRITE, MANAGER, PLATFORM
- **RequiresApproval**: true
- **Timeout**: 12s
- **Endpoint**: POST /manager/menu/products { restaurantId, ... }

### updateProduct
- **Description**: Update existing product. Requires productId. Optional: name, price, available, description, categoryId, preparationTimeMinutes.
- **AR**: تعديل منتج موجود
- **Input**: { productId: string required, name?: string 2-100, price?: number, available?: boolean, description?: string max 500, categoryId?: string, preparationTimeMinutes?: number }
- **Permission**: WRITE, MANAGER, PLATFORM
- **RequiresApproval**: true (price change sensitive)
- **Timeout**: 12s
- **Endpoint**: PUT /manager/menu/products/:productId

### deleteProduct
- **Description**: Delete product by productId. Destructive — requires explicit approval.
- **AR**: حذف منتج — عملية حساسة تتطلب تأكيداً
- **Input**: { productId: string required }
- **Permission**: DESTRUCTIVE, MANAGER, PLATFORM
- **RequiresApproval**: true
- **Timeout**: 10s
- **Endpoint**: DELETE /manager/menu/products/:productId { restaurantId }

### createCategory
- **Description**: Create new category. Requires name. Optional: nameEn, description.
- **AR**: إنشاء تصنيف جديد
- **Input**: { name: string 2-50 required, nameEn?: string max 50, description?: string max 200 }
- **Permission**: WRITE, MANAGER, PLATFORM
- **RequiresApproval**: true
- **Timeout**: 10s
- **Endpoint**: POST /manager/menu/categories

### updateCategory
- **Description**: Update category. Requires categoryId. Optional: name, nameEn, sortOrder.
- **AR**: تعديل تصنيف
- **Input**: { categoryId: string required, name?: string 2-50, nameEn?: string max 50, sortOrder?: number }
- **Permission**: WRITE, MANAGER, PLATFORM
- **RequiresApproval**: true
- **Timeout**: 10s
- **Endpoint**: PUT /manager/menu/categories/:categoryId

### createOffer
- **Description**: Create new offer/promotion. Requires title. Optional: description, originalPrice, discountedPrice, discountPercentage, image, code, isActive.
- **AR**: إنشاء عرض ترويجي
- **Input**: { title: string 3-100 required, description?: string max 500, originalPrice?: number, discountedPrice?: number, discountPercentage?: number, code?: string max 20, isActive?: boolean }
- **Permission**: WRITE, MANAGER, PLATFORM
- **RequiresApproval**: true
- **Timeout**: 10s
- **Endpoint**: POST /manager/offers

### updateTableStatus
- **Description**: Update table status. Requires tableId and status AVAILABLE/OCCUPIED/BILL_REQUESTED/RESERVED/MAINTENANCE.
- **AR**: تحديث حالة الطاولة
- **Input**: { tableId: string required, status: enum required }
- **Permission**: WRITE, MANAGER, CASHIER, WAITER, STAFF, PLATFORM
- **RequiresApproval**: false
- **Timeout**: 8s
- **Endpoint**: PUT /manager/tables/:tableId { restaurantId, status }

### updateWaiterRequestStatus
- **Description**: Update waiter request status. Requires requestId and status ACKNOWLEDGED/RESOLVED/CANCELLED.
- **AR**: تحديث حالة طلب النادل
- **Input**: { requestId: string required, status: enum ACKNOWLEDGED/RESOLVED/CANCELLED required }
- **Permission**: WRITE, MANAGER, WAITER, STAFF, CASHIER, PLATFORM
- **RequiresApproval**: false
- **Timeout**: 8s
- **Endpoint**: PUT /manager/waiter-requests/:requestId/status

## Tool Execution Flow
```
USER
 ↓
AUTHENTICATION (resolveContactToTenant → toolContext)
 ↓
TENANT IDENTIFICATION (restaurantId from context)
 ↓
ROLE CHECK (TOOL_POLICIES[tool].allowedRoles includes context.role)
 ↓
TOOL POLICY (permission, requiresApproval, entitlement)
 ↓
VALIDATED INPUT (schema parse + sanitizeToolInput + cross-tenant check args.restaurantId vs context.restaurantId)
 ↓
EXECUTION (MureehClient.request with timeout, retry, demo fallback)
 ↓
VALIDATE RESULT (validateToolResultOwnership + schema + missing values + contradictions)
```

## Demo Mode
When MUREEH_API_URL empty or MUREEH_DEMO_MODE=true, getDemoDataForTool returns realistic data for all read tools, and action tools return simulated success with message "Demo: would execute..."

## Security
- No SQL, no env, no JWT modification
- Input sanitization: ID fields alphanumeric + dash + underscore only
- Output sanitization: strip control chars, limit length, flag injection
- Ownership validation prevents cross-tenant leakage
- All security-critical controls outside model

## Tool Selection
selectToolsForIntent(intent, detail, entities) maps intent detail to tool calls:
- menu_info → getMenu
- product_info → getProduct
- order_status → getOrder if orderId else getOrders pending+preparing+ready parallel
- table_status → getTableStatus
- best_selling → getSalesAnalytics + getRestaurantStats parallel
- slow_products → getSalesAnalytics week
- peak_times → getSalesAnalytics today
- revenue_summary → getRestaurantStats + getSalesAnalytics
- performance → getRestaurantStats + getSalesAnalytics + getOperationalAnalytics (3 parallel)
- pending_orders → getOrders PENDING
- delayed_orders → getOperationalAnalytics + getOrders PREPARING
- etc.

Independent reads executed in parallel via executeToolsParallel, writes sequential via executeToolsSequential.
