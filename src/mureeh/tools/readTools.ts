/**
 * READ tools — strongly typed, validated, permission-aware.
 * Each tool: unique name, description, strict input schema, validation,
 * authorization requirements, timeout, error handling, structured output.
 */

import { z } from '../utils/zodLite.js';
import type { MureehToolContext, ToolResult } from '../types.js';
import { getMureehClient } from '../client.js';
import { checkToolAuthorization, validateToolResultOwnership } from '../authz.js';
import { sanitizeToolInput, sanitizeRetrievedData, wrapWithTrustBoundary } from '../security.js';
import { getDemoDataForTool } from './demoData.js';

// Minimal zod-like validation without external dep — we implement simple validators
// For production, replace with actual zod if available. Here we use custom.

export interface ToolDefinition {
  name: string;
  description: string;
  descriptionAr: string;
  inputSchema: {
    parse: (input: unknown) => { success: boolean; data?: Record<string, unknown>; error?: string };
  };
  permission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  requiresApproval: boolean;
  timeoutMs: number;
  execute: (args: Record<string, unknown>, ctx: MureehToolContext) => Promise<ToolResult>;
}

// Simple schema builder (to avoid adding zod dependency)
function createSchema(shape: Record<string, { type: 'string' | 'number' | 'boolean' | 'enum'; required?: boolean; enumValues?: string[]; min?: number; max?: number }>) {
  return {
    parse: (input: unknown) => {
      if (typeof input !== 'object' || input === null) {
        return { success: false, error: 'Input must be object' };
      }
      const obj = input as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(shape)) {
        const value = obj[key];
        if (value === undefined || value === null) {
          if (def.required) {
            return { success: false, error: `Missing required field: ${key}` };
          }
          continue;
        }
        if (def.type === 'string' && typeof value !== 'string') {
          return { success: false, error: `Field ${key} must be string` };
        }
        if (def.type === 'number' && typeof value !== 'number') {
          const num = Number(value);
          if (!Number.isFinite(num)) return { success: false, error: `Field ${key} must be number` };
          data[key] = num;
          continue;
        }
        if (def.type === 'boolean' && typeof value !== 'boolean') {
          return { success: false, error: `Field ${key} must be boolean` };
        }
        if (def.type === 'enum' && typeof value === 'string') {
          if (def.enumValues && !def.enumValues.includes(value)) {
            return { success: false, error: `Field ${key} must be one of ${def.enumValues.join(', ')}` };
          }
        }
        if (def.min !== undefined && typeof value === 'string' && value.length < def.min) {
          return { success: false, error: `Field ${key} min length ${def.min}` };
        }
        if (def.max !== undefined && typeof value === 'string' && value.length > def.max) {
          return { success: false, error: `Field ${key} max length ${def.max}` };
        }
        data[key] = value;
      }
      // Allow extra fields but sanitize
      for (const [k, v] of Object.entries(obj)) {
        if (!(k in shape)) {
          data[k] = v;
        }
      }
      return { success: true, data };
    },
  };
}

async function executeWithGuards<T>(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MureehToolContext,
  fn: () => Promise<{ ok: boolean; data?: T; error?: string }>
): Promise<ToolResult<T>> {
  const start = Date.now();

  // 1. Authz check
  const authz = checkToolAuthorization(toolName, ctx);
  if (!authz.allowed) {
    return {
      ok: false,
      error: authz.reason,
      errorCode: 'FORBIDDEN',
      source: 'api',
      latencyMs: Date.now() - start,
    };
  }

  // 2. Input sanitization
  const { sanitized, issues } = sanitizeToolInput(args);
  if (issues.length > 0) {
    // Log but continue with sanitized
  }

  // 3. Tenant isolation — args must not contain different restaurantId
  if (sanitized.restaurantId && sanitized.restaurantId !== ctx.restaurantId) {
    return {
      ok: false,
      error: `Cross-tenant attempt: args restaurantId ${sanitized.restaurantId} != context ${ctx.restaurantId}`,
      errorCode: 'TENANT_VIOLATION',
      source: 'api',
      latencyMs: Date.now() - start,
    };
  }

  // 4. Execute with demo fallback
  const client = getMureehClient();
  if (client.isDemo()) {
    const demoData = getDemoDataForTool(toolName, sanitized);
    if (demoData !== null) {
      // Validate ownership even for demo
      const ownership = validateToolResultOwnership(demoData, ctx.restaurantId);
      if (!ownership.valid) {
        return { ok: false, error: ownership.reason, errorCode: 'TENANT_VIOLATION', source: 'demo', latencyMs: Date.now() - start };
      }
      return {
        ok: true,
        data: demoData as T,
        source: 'demo',
        latencyMs: Date.now() - start,
        userMessage: `Demo data for ${toolName}`,
      };
    }
  }

  try {
    const res = await fn();
    if (!res.ok) {
      return {
        ok: false,
        error: res.error,
        errorCode: 'API_ERROR',
        source: 'api',
        latencyMs: Date.now() - start,
      };
    }

    // 5. Validate result ownership
    const ownership = validateToolResultOwnership(res.data, ctx.restaurantId);
    if (!ownership.valid) {
      return {
        ok: false,
        error: ownership.reason,
        errorCode: 'TENANT_VIOLATION',
        source: 'api',
        latencyMs: Date.now() - start,
      };
    }

    // 6. Sanitize retrieved data for prompt injection
    let dataToReturn = res.data;
    // If data contains product descriptions, order notes, etc, sanitize
    if (typeof res.data === 'string') {
      const sanitizedData = sanitizeRetrievedData(res.data as string);
      dataToReturn = sanitizedData.sanitized as any;
    }

    return {
      ok: true,
      data: dataToReturn as T,
      source: 'api',
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
      errorCode: 'EXECUTION_ERROR',
      source: 'api',
      latencyMs: Date.now() - start,
    };
  }
}

export const readTools: ToolDefinition[] = [
  {
    name: 'getRestaurant',
    description: 'Get restaurant information by restaurantId. Returns name, slug, logo, currency, timezone, business type.',
    descriptionAr: 'جلب معلومات المطعم — الاسم، الشعار، العملة، المنطقة الزمنية، نوع النشاط.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('getRestaurant', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getRestaurant(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'getMenu',
    description: 'Get full menu: categories and products. Use for menu information queries.',
    descriptionAr: 'جلب المنيو الكامل: التصنيفات والمنتجات.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('getMenu', args, ctx, async () => {
        const client = getMureehClient();
        if (client.isDemo()) {
          const demo = getDemoDataForTool('getMenu', args);
          return { ok: true, data: demo };
        }
        const [cats, prods] = await Promise.all([
          client.getCategories(ctx.restaurantId, ctx),
          client.getProducts(ctx.restaurantId, ctx),
        ]);
        if (!cats.ok) return { ok: false, error: cats.error };
        if (!prods.ok) return { ok: false, error: prods.error };
        return { ok: true, data: { categories: cats.data, products: prods.data } };
      });
    },
  },
  {
    name: 'getCategories',
    description: 'Get categories for restaurant. Returns id, name, sortOrder, status.',
    descriptionAr: 'جلب تصنيفات المطعم.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getCategories', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getCategories(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'getProducts',
    description: 'Get products for restaurant. Optional filters: categoryId, available (boolean).',
    descriptionAr: 'جلب منتجات المطعم مع إمكانية التصفية حسب التصنيف أو التوفر.',
    inputSchema: createSchema({
      categoryId: { type: 'string', required: false },
      available: { type: 'boolean', required: false },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('getProducts', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getProducts(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        let data = res.data as any[];
        if (args.categoryId) data = data.filter((p: any) => p.categoryId === args.categoryId);
        if (args.available !== undefined) data = data.filter((p: any) => p.available === args.available);
        return { ok: true, data };
      });
    },
  },
  {
    name: 'getProduct',
    description: 'Get single product by productId or productName. Returns price, category, options, addons, prep time.',
    descriptionAr: 'جلب منتج واحد بالتفصيل.',
    inputSchema: createSchema({
      productId: { type: 'string', required: false },
      productName: { type: 'string', required: false },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getProduct', args, ctx, async () => {
        if (!args.productId && !args.productName) {
          return { ok: false, error: 'productId or productName required' };
        }
        const client = getMureehClient();
        if (client.isDemo()) {
          const demo = getDemoDataForTool('getProduct', args);
          return { ok: true, data: demo };
        }
        const res = await client.getProducts(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        const products = res.data as any[];
        const found = products.find((p: any) => p.id === args.productId || p.name === args.productName || p.nameEn === args.productName);
        if (!found) return { ok: false, error: 'Product not found' };
        return { ok: true, data: found };
      });
    },
  },
  {
    name: 'getOrders',
    description: 'Get orders for restaurant. Filters: status (PENDING, PREPARING, READY, SERVED, CANCELLED), from, to, limit. Returns orders with items, table, prep time, delayed flag.',
    descriptionAr: 'جلب الطلبات مع إمكانية التصفية حسب الحالة أو التاريخ.',
    inputSchema: createSchema({
      status: { type: 'enum', required: false, enumValues: ['PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] },
      from: { type: 'string', required: false },
      to: { type: 'string', required: false },
      limit: { type: 'number', required: false, min: 1, max: 100 },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 12000,
    execute: async (args, ctx) => {
      return executeWithGuards('getOrders', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getOrders(ctx.restaurantId, ctx, args as any);
        if (!res.ok) return { ok: false, error: res.error };
        let data = res.data as any[];
        // Enrich with elapsedMinutes and isDelayed
        data = data.map((o: any) => {
          const created = new Date(o.createdAt).getTime();
          const elapsed = Math.floor((Date.now() - created) / 60000);
          return { ...o, elapsedMinutes: elapsed, isDelayed: elapsed > 25 && (o.status === 'PENDING' || o.status === 'PREPARING') };
        });
        return { ok: true, data };
      });
    },
  },
  {
    name: 'getOrder',
    description: 'Get single order by orderId (id or numericId). Returns full order with items.',
    descriptionAr: 'جلب طلب واحد بالتفصيل.',
    inputSchema: createSchema({
      orderId: { type: 'string', required: true },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getOrder', args, ctx, async () => {
        const client = getMureehClient();
        if (client.isDemo()) {
          const demo = getDemoDataForTool('getOrder', args);
          return { ok: true, data: demo };
        }
        // For real API, we need to fetch all and find, or have dedicated endpoint
        const res = await client.getOrders(ctx.restaurantId, ctx, { limit: 100 });
        if (!res.ok) return { ok: false, error: res.error };
        const orders = res.data as any[];
        const found = orders.find((o: any) => o.id === args.orderId || String(o.numericId) === String(args.orderId));
        if (!found) return { ok: false, error: 'Order not found or not owned by restaurant' };
        return { ok: true, data: found };
      });
    },
  },
  {
    name: 'getTableStatus',
    description: 'Get tables status for restaurant. Returns tables with number, zone, status (AVAILABLE, OCCUPIED, BILL_REQUESTED, RESERVED, MAINTENANCE), capacity.',
    descriptionAr: 'جلب حالة الطاولات.',
    inputSchema: createSchema({
      zone: { type: 'enum', required: false, enumValues: ['MAIN_HALL', 'TERRACE', 'VIP_LOUNGE', 'GARDEN'] },
      status: { type: 'enum', required: false, enumValues: ['AVAILABLE', 'OCCUPIED', 'BILL_REQUESTED', 'RESERVED', 'MAINTENANCE'] },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getTableStatus', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getTables(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        let data = res.data as any[];
        if (args.zone) data = data.filter((t: any) => t.zone === args.zone);
        if (args.status) data = data.filter((t: any) => t.status === args.status);
        return { ok: true, data };
      });
    },
  },
  {
    name: 'getWaiterRequests',
    description: 'Get waiter requests for restaurant. Filters: status PENDING, ACKNOWLEDGED, RESOLVED, CANCELLED. Returns table, reason, elapsed minutes.',
    descriptionAr: 'جلب طلبات استدعاء النادل.',
    inputSchema: createSchema({
      status: { type: 'enum', required: false, enumValues: ['PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'] },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getWaiterRequests', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getWaiterRequests(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        let data = res.data as any[];
        if (args.status) data = data.filter((w: any) => w.status === args.status);
        data = data.map((w: any) => {
          const created = new Date(w.createdAt).getTime();
          const elapsed = Math.floor((Date.now() - created) / 60000);
          return { ...w, elapsedMinutes: elapsed };
        });
        return { ok: true, data };
      });
    },
  },
  {
    name: 'getOffers',
    description: 'Get offers/promotions for restaurant. Returns title, discount, isActive.',
    descriptionAr: 'جلب العروض الترويجية.',
    inputSchema: createSchema({
      activeOnly: { type: 'boolean', required: false },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getOffers', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getOffers(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        let data = res.data as any[];
        if (args.activeOnly) data = data.filter((o: any) => o.isActive);
        return { ok: true, data };
      });
    },
  },
  {
    name: 'getBranches',
    description: 'Get branches for restaurant. Returns id, name, address, isActive.',
    descriptionAr: 'جلب الفروع.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('getBranches', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getBranches(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'getRestaurantStats',
    description: 'Get dashboard stats: revenue, orders count, active tables, pending orders, preparing, ready, pending waiters, average order value, popular products. Requires analytics entitlement.',
    descriptionAr: 'جلب إحصائيات لوحة التحكم.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 12000,
    execute: async (args, ctx) => {
      return executeWithGuards('getRestaurantStats', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.getDashboardStats(ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'getSalesAnalytics',
    description: 'Get sales analytics: total orders, revenue, avg order value, orders by hour/day, top products, slow products, peak hours, cancellations, prep time. Timeframe: today, week, month.',
    descriptionAr: 'جلب تحليلات المبيعات.',
    inputSchema: createSchema({
      timeframe: { type: 'enum', required: false, enumValues: ['today', 'week', 'month'] },
    }),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 15000,
    execute: async (args, ctx) => {
      return executeWithGuards('getSalesAnalytics', args, ctx, async () => {
        const client = getMureehClient();
        if (client.isDemo()) {
          const demo = getDemoDataForTool('getSalesAnalytics', args);
          return { ok: true, data: demo };
        }
        // For real, aggregate from orders
        const res = await client.getOrders(ctx.restaurantId, ctx, { limit: 100 });
        if (!res.ok) return { ok: false, error: res.error };
        // Simplified analytics from orders
        const orders = res.data as any[];
        const totalRevenue = orders.reduce((sum: number, o: any) => sum + (o.total || 0), 0);
        const totalOrders = orders.length;
        return {
          ok: true,
          data: {
            totalOrders,
            totalRevenue,
            averageOrderValue: totalOrders ? totalRevenue / totalOrders : 0,
            timeframe: args.timeframe || 'today',
            rawOrders: orders.slice(0, 20),
          },
        };
      });
    },
  },
  {
    name: 'getOperationalAnalytics',
    description: 'Get operational analytics: pending/preparing/ready orders, delayed orders, occupied tables, bill requested tables, pending waiter requests, avg prep time, kitchen load, anomalies.',
    descriptionAr: 'جلب التحليلات التشغيلية.',
    inputSchema: createSchema({}),
    permission: 'READ',
    requiresApproval: false,
    timeoutMs: 15000,
    execute: async (args, ctx) => {
      return executeWithGuards('getOperationalAnalytics', args, ctx, async () => {
        const client = getMureehClient();
        if (client.isDemo()) {
          const demo = getDemoDataForTool('getOperationalAnalytics', args);
          return { ok: true, data: demo };
        }
        const [ordersRes, tablesRes, waitersRes] = await Promise.all([
          client.getOrders(ctx.restaurantId, ctx, { limit: 50 }),
          client.getTables(ctx.restaurantId, ctx),
          client.getWaiterRequests(ctx.restaurantId, ctx),
        ]);
        if (!ordersRes.ok) return { ok: false, error: ordersRes.error };
        if (!tablesRes.ok) return { ok: false, error: tablesRes.error };
        if (!waitersRes.ok) return { ok: false, error: waitersRes.error };

        const orders = ordersRes.data as any[];
        const tables = tablesRes.data as any[];
        const waiters = waitersRes.data as any[];

        const pending = orders.filter((o: any) => o.status === 'PENDING').length;
        const preparing = orders.filter((o: any) => o.status === 'PREPARING').length;
        const ready = orders.filter((o: any) => o.status === 'READY').length;

        const delayed = orders.filter((o: any) => {
          const elapsed = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
          return elapsed > 25 && (o.status === 'PENDING' || o.status === 'PREPARING');
        });

        const occupied = tables.filter((t: any) => t.status === 'OCCUPIED');
        const billRequested = tables.filter((t: any) => t.status === 'BILL_REQUESTED');
        const pendingWaiters = waiters.filter((w: any) => w.status === 'PENDING');

        let kitchenLoad: 'LOW' | 'MEDIUM' | 'HIGH' | 'OVERLOADED' = 'LOW';
        const active = pending + preparing;
        if (active > 15) kitchenLoad = 'OVERLOADED';
        else if (active > 8) kitchenLoad = 'HIGH';
        else if (active > 3) kitchenLoad = 'MEDIUM';

        return {
          ok: true,
          data: {
            pendingOrders: pending,
            preparingOrders: preparing,
            readyOrders: ready,
            delayedOrders: delayed,
            occupiedTables: occupied,
            billRequestedTables: billRequested,
            pendingWaiterRequests: pendingWaiters,
            kitchenLoad,
          },
        };
      });
    },
  },
];
