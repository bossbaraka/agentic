/**
 * ACTION tools — require permission checks and human approval for sensitive ops.
 */

import type { ToolDefinition } from './readTools.js';
import type { MureehToolContext, ToolResult } from '../types.js';
import { getMureehClient } from '../client.js';
import { checkToolAuthorization, validateToolResultOwnership } from '../authz.js';
import { sanitizeToolInput } from '../security.js';
import { getDemoDataForTool } from './demoData.js';

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

  const authz = checkToolAuthorization(toolName, ctx);
  if (!authz.allowed) {
    return { ok: false, error: authz.reason, errorCode: 'FORBIDDEN', source: 'api', latencyMs: Date.now() - start };
  }

  const { sanitized } = sanitizeToolInput(args);

  if (sanitized.restaurantId && sanitized.restaurantId !== ctx.restaurantId) {
    return {
      ok: false,
      error: `Cross-tenant attempt: args restaurantId ${sanitized.restaurantId} != context ${ctx.restaurantId}`,
      errorCode: 'TENANT_VIOLATION',
      source: 'api',
      latencyMs: Date.now() - start,
    };
  }

  const client = getMureehClient();
  if (client.isDemo()) {
    // In demo, simulate success for write operations
    return {
      ok: true,
      data: { message: `Demo: ${toolName} would execute with ${JSON.stringify(sanitized).slice(0, 200)}`, simulated: true, args: sanitized } as any,
      source: 'demo',
      latencyMs: Date.now() - start,
      userMessage: `تم تنفيذ ${toolName} في وضع التجربة (محاكاة).`,
    };
  }

  try {
    const res = await fn();
    if (!res.ok) {
      return { ok: false, error: res.error, errorCode: 'API_ERROR', source: 'api', latencyMs: Date.now() - start };
    }

    const ownership = validateToolResultOwnership(res.data, ctx.restaurantId);
    if (!ownership.valid) {
      return { ok: false, error: ownership.reason, errorCode: 'TENANT_VIOLATION', source: 'api', latencyMs: Date.now() - start };
    }

    return { ok: true, data: res.data as T, source: 'api', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), errorCode: 'EXECUTION_ERROR', source: 'api', latencyMs: Date.now() - start };
  }
}

export const actionTools: ToolDefinition[] = [
  {
    name: 'updateOrderStatus',
    description: 'Update order status: PENDING→PREPARING→READY→SERVED→COMPLETED or CANCELLED. Requires orderId and status. CANCELLING requires approval.',
    descriptionAr: 'تحديث حالة الطلب.',
    inputSchema: createSchema({
      orderId: { type: 'string', required: true },
      status: { type: 'enum', required: true, enumValues: ['PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] },
    }),
    permission: 'WRITE',
    requiresApproval: false, // but CANCELLED will be flagged as needing approval in approval layer
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('updateOrderStatus', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.updateOrderStatus(String(args.orderId), String(args.status), ctx.restaurantId, ctx);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'createProduct',
    description: 'Create new product. Requires name, categoryId, price, description. Optional: imageUrl, available, preparationTimeMinutes, calories.',
    descriptionAr: 'إنشاء منتج جديد.',
    inputSchema: createSchema({
      name: { type: 'string', required: true, min: 2, max: 100 },
      categoryId: { type: 'string', required: true },
      price: { type: 'number', required: true },
      description: { type: 'string', required: false, max: 500 },
      imageUrl: { type: 'string', required: false },
      available: { type: 'boolean', required: false },
      preparationTimeMinutes: { type: 'number', required: false },
    }),
    permission: 'WRITE',
    requiresApproval: true,
    timeoutMs: 12000,
    execute: async (args, ctx) => {
      return executeWithGuards('createProduct', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'POST',
          path: `/manager/menu/products`,
          body: { restaurantId: ctx.restaurantId, ...args },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'updateProduct',
    description: 'Update existing product. Requires productId. Optional: name, price, available, description, categoryId, preparationTimeMinutes.',
    descriptionAr: 'تعديل منتج موجود.',
    inputSchema: createSchema({
      productId: { type: 'string', required: true },
      name: { type: 'string', required: false, min: 2, max: 100 },
      price: { type: 'number', required: false },
      available: { type: 'boolean', required: false },
      description: { type: 'string', required: false, max: 500 },
      categoryId: { type: 'string', required: false },
      preparationTimeMinutes: { type: 'number', required: false },
    }),
    permission: 'WRITE',
    requiresApproval: true,
    timeoutMs: 12000,
    execute: async (args, ctx) => {
      return executeWithGuards('updateProduct', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'PUT',
          path: `/manager/menu/products/${encodeURIComponent(String(args.productId))}`,
          body: { restaurantId: ctx.restaurantId, ...args },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'deleteProduct',
    description: 'Delete product by productId. Destructive — requires explicit approval.',
    descriptionAr: 'حذف منتج — عملية حساسة تتطلب تأكيداً.',
    inputSchema: createSchema({
      productId: { type: 'string', required: true },
    }),
    permission: 'DESTRUCTIVE',
    requiresApproval: true,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('deleteProduct', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'DELETE',
          path: `/manager/menu/products/${encodeURIComponent(String(args.productId))}`,
          body: { restaurantId: ctx.restaurantId },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'createCategory',
    description: 'Create new category. Requires name. Optional: nameEn, description.',
    descriptionAr: 'إنشاء تصنيف جديد.',
    inputSchema: createSchema({
      name: { type: 'string', required: true, min: 2, max: 50 },
      nameEn: { type: 'string', required: false, max: 50 },
      description: { type: 'string', required: false, max: 200 },
    }),
    permission: 'WRITE',
    requiresApproval: true,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('createCategory', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'POST',
          path: `/manager/menu/categories`,
          body: { restaurantId: ctx.restaurantId, ...args },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'updateCategory',
    description: 'Update category. Requires categoryId. Optional: name, nameEn, sortOrder.',
    descriptionAr: 'تعديل تصنيف.',
    inputSchema: createSchema({
      categoryId: { type: 'string', required: true },
      name: { type: 'string', required: false, min: 2, max: 50 },
      nameEn: { type: 'string', required: false, max: 50 },
      sortOrder: { type: 'number', required: false },
    }),
    permission: 'WRITE',
    requiresApproval: true,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('updateCategory', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'PUT',
          path: `/manager/menu/categories/${encodeURIComponent(String(args.categoryId))}`,
          body: { restaurantId: ctx.restaurantId, ...args },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'createOffer',
    description: 'Create new offer/promotion. Requires title. Optional: description, originalPrice, discountedPrice, discountPercentage, image, code, isActive.',
    descriptionAr: 'إنشاء عرض ترويجي.',
    inputSchema: createSchema({
      title: { type: 'string', required: true, min: 3, max: 100 },
      description: { type: 'string', required: false, max: 500 },
      originalPrice: { type: 'number', required: false },
      discountedPrice: { type: 'number', required: false },
      discountPercentage: { type: 'number', required: false },
      code: { type: 'string', required: false, max: 20 },
      isActive: { type: 'boolean', required: false },
    }),
    permission: 'WRITE',
    requiresApproval: true,
    timeoutMs: 10000,
    execute: async (args, ctx) => {
      return executeWithGuards('createOffer', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'POST',
          path: `/manager/offers`,
          body: { restaurantId: ctx.restaurantId, ...args },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'updateTableStatus',
    description: 'Update table status. Requires tableId and status (AVAILABLE, OCCUPIED, BILL_REQUESTED, RESERVED, MAINTENANCE).',
    descriptionAr: 'تحديث حالة الطاولة.',
    inputSchema: createSchema({
      tableId: { type: 'string', required: true },
      status: { type: 'enum', required: true, enumValues: ['AVAILABLE', 'OCCUPIED', 'BILL_REQUESTED', 'RESERVED', 'MAINTENANCE'] },
    }),
    permission: 'WRITE',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('updateTableStatus', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'PUT',
          path: `/manager/tables/${encodeURIComponent(String(args.tableId))}`,
          body: { restaurantId: ctx.restaurantId, status: args.status },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
  {
    name: 'updateWaiterRequestStatus',
    description: 'Update waiter request status. Requires requestId and status ACKNOWLEDGED, RESOLVED, CANCELLED.',
    descriptionAr: 'تحديث حالة طلب النادل.',
    inputSchema: createSchema({
      requestId: { type: 'string', required: true },
      status: { type: 'enum', required: true, enumValues: ['ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'] },
    }),
    permission: 'WRITE',
    requiresApproval: false,
    timeoutMs: 8000,
    execute: async (args, ctx) => {
      return executeWithGuards('updateWaiterRequestStatus', args, ctx, async () => {
        const client = getMureehClient();
        const res = await client.request({
          method: 'PUT',
          path: `/manager/waiter-requests/${encodeURIComponent(String(args.requestId))}/status`,
          body: { restaurantId: ctx.restaurantId, status: args.status },
          context: ctx,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: res.data as any };
      });
    },
  },
];
