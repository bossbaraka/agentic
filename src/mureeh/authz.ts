/**
 * Permission-aware tool execution — authorization enforced server-side.
 * LLM never decides authorization.
 *
 * Flow: USER → AUTHENTICATION → TENANT IDENTIFICATION → ROLE CHECK → TOOL POLICY → VALIDATED INPUT → EXECUTION
 */

import type { MureehToolContext, TenantRole } from './types.js';

export type ToolPermission = 'READ' | 'WRITE' | 'DESTRUCTIVE';

export interface ToolPolicy {
  name: string;
  permission: ToolPermission;
  allowedRoles: TenantRole[];
  requiresApproval: boolean;
  description: string;
  requiresEntitlement?: string; // e.g., CAN_USE_ANALYTICS
}

// Define policies for each restaurant tool
export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // READ tools — normally auto-executable
  getRestaurant: { name: 'getRestaurant', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read restaurant info' },
  getMenu: { name: 'getMenu', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read full menu' },
  getCategories: { name: 'getCategories', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read categories' },
  getProducts: { name: 'getProducts', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read products' },
  getProduct: { name: 'getProduct', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read single product' },
  getOrders: { name: 'getOrders', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read orders' },
  getOrder: { name: 'getOrder', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read single order' },
  getTableStatus: { name: 'getTableStatus', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read table status' },
  getWaiterRequests: { name: 'getWaiterRequests', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'WAITER', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read waiter requests' },
  getOffers: { name: 'getOffers', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read offers' },
  getBranches: { name: 'getBranches', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read branches' },
  getPayments: { name: 'getPayments', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read payments' },
  getRestaurantStats: { name: 'getRestaurantStats', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read dashboard stats', requiresEntitlement: 'CAN_USE_ANALYTICS' },
  getSalesAnalytics: { name: 'getSalesAnalytics', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read sales analytics', requiresEntitlement: 'CAN_USE_ANALYTICS' },
  getOperationalAnalytics: { name: 'getOperationalAnalytics', permission: 'READ', allowedRoles: ['RESTAURANT_MANAGER', 'STAFF', 'KITCHEN', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Read operational analytics' },

  // ACTION tools — may require approval
  updateOrderStatus: { name: 'updateOrderStatus', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'KITCHEN', 'CASHIER', 'WAITER', 'STAFF', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Update order status' },
  createProduct: { name: 'createProduct', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Create product' },
  updateProduct: { name: 'updateProduct', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Update product' },
  deleteProduct: { name: 'deleteProduct', permission: 'DESTRUCTIVE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Delete product' },
  createCategory: { name: 'createCategory', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Create category' },
  updateCategory: { name: 'updateCategory', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Update category' },
  deleteCategory: { name: 'deleteCategory', permission: 'DESTRUCTIVE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Delete category' },
  createOffer: { name: 'createOffer', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Create offer' },
  updateOffer: { name: 'updateOffer', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Update offer' },
  deleteOffer: { name: 'deleteOffer', permission: 'DESTRUCTIVE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Delete offer' },
  updateRestaurantSettings: { name: 'updateRestaurantSettings', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Update restaurant settings' },
  updateTableStatus: { name: 'updateTableStatus', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'CASHIER', 'WAITER', 'STAFF', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Update table status' },
  createBranch: { name: 'createBranch', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Create branch' },
  updateBranch: { name: 'updateBranch', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: true, description: 'Update branch' },
  updateWaiterRequestStatus: { name: 'updateWaiterRequestStatus', permission: 'WRITE', allowedRoles: ['RESTAURANT_MANAGER', 'WAITER', 'STAFF', 'CASHIER', 'PLATFORM_ADMIN', 'SUPER_ADMIN'], requiresApproval: false, description: 'Update waiter request' },
};

export interface AuthzResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  policy?: ToolPolicy;
}

export function checkToolAuthorization(
  toolName: string,
  context: MureehToolContext
): AuthzResult {
  const policy = TOOL_POLICIES[toolName];
  if (!policy) {
    return { allowed: false, reason: `Unknown tool: ${toolName}` };
  }

  // Tenant check — must have restaurantId
  if (!context.restaurantId) {
    return { allowed: false, reason: 'Missing restaurantId in context — tenant isolation violation', policy };
  }

  // Role check
  if (!policy.allowedRoles.includes(context.role)) {
    return {
      allowed: false,
      reason: `Role ${context.role} not allowed for tool ${toolName}. Allowed: ${policy.allowedRoles.join(', ')}`,
      policy,
    };
  }

  // Platform admin bypasses most checks but still needs tenantId for data tools
  const isPlatform = context.role === 'PLATFORM_ADMIN' || context.role === 'SUPER_ADMIN';

  // For non-platform, ensure role is valid tenant role
  if (!isPlatform && !context.restaurantId) {
    return { allowed: false, reason: 'Tenant users must have restaurantId', policy };
  }

  return {
    allowed: true,
    requiresApproval: policy.requiresApproval,
    policy,
  };
}

// Tenant isolation validation for tool results
export function validateToolResultOwnership(
  result: any,
  expectedRestaurantId: string
): { valid: boolean; reason?: string } {
  if (!result) return { valid: true };

  // If result is array, check each item
  if (Array.isArray(result)) {
    for (const item of result) {
      const check = validateToolResultOwnership(item, expectedRestaurantId);
      if (!check.valid) return check;
    }
    return { valid: true };
  }

  if (typeof result === 'object') {
    // Check restaurantId field if present
    if ('restaurantId' in result && result.restaurantId) {
      if (result.restaurantId !== expectedRestaurantId) {
        return {
          valid: false,
          reason: `Result restaurantId ${result.restaurantId} does not match expected ${expectedRestaurantId} — cross-tenant leakage`,
        };
      }
    }
    // Check nested data
    if ('data' in result && result.data) {
      return validateToolResultOwnership(result.data, expectedRestaurantId);
    }
    // Check common wrappers
    for (const key of ['restaurant', 'order', 'table', 'product', 'category', 'offer', 'branch']) {
      if (key in result && result[key] && typeof result[key] === 'object') {
        const nested = result[key] as any;
        if ('restaurantId' in nested && nested.restaurantId && nested.restaurantId !== expectedRestaurantId) {
          return {
            valid: false,
            reason: `Nested ${key} restaurantId mismatch: ${nested.restaurantId} vs ${expectedRestaurantId}`,
          };
        }
      }
    }
  }

  return { valid: true };
}

// Map contactKey (WhatsApp number / Telegram id) to restaurant context
// In production, this would query a mapping table. For now, we support:
// - Explicit mapping via env MUREEH_CONTACT_MAPPING (JSON)
// - Demo mapping for testing
export interface ContactMapping {
  contactKey: string;
  restaurantId: string;
  branchId?: string;
  role: TenantRole;
  userId?: string;
}

const demoMappings: ContactMapping[] = [
  // Demo data for evaluation — these IDs match seed data in restaurantsMureeh if needed
  { contactKey: 'demo-manager', restaurantId: 'demo-restaurant-1', role: 'RESTAURANT_MANAGER', userId: 'demo-user-1' },
  { contactKey: 'wa:+970599000001', restaurantId: 'demo-restaurant-1', role: 'RESTAURANT_MANAGER' },
];

export function resolveContactToTenant(contactKey: string): ContactMapping | null {
  // Check env mapping first
  const envMapping = process.env.MUREEH_CONTACT_MAPPING;
  if (envMapping) {
    try {
      const mappings: ContactMapping[] = JSON.parse(envMapping);
      const found = mappings.find((m) => m.contactKey === contactKey);
      if (found) return found;
    } catch {
      // ignore parse error
    }
  }

  // Demo fallback
  const demo = demoMappings.find((m) => m.contactKey === contactKey);
  if (demo) return demo;

  // For any contactKey in demo mode, return a demo restaurant
  // In production, this should return null and require explicit mapping
  if (process.env.MUREEH_DEMO_MODE !== 'false') {
    return {
      contactKey,
      restaurantId: 'demo-restaurant-1',
      role: 'RESTAURANT_MANAGER',
    };
  }

  return null;
}

export function createToolContextFromContact(
  contactKey: string,
  opts: Partial<MureehToolContext> = {}
): MureehToolContext | null {
  const mapping = resolveContactToTenant(contactKey);
  if (!mapping) return null;

  return {
    requestId: opts.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: opts.userId || mapping.userId,
    restaurantId: opts.restaurantId || mapping.restaurantId,
    branchId: opts.branchId || mapping.branchId || null,
    role: opts.role || mapping.role,
    language: opts.language || 'ar',
    contactKey,
    authToken: opts.authToken,
  };
}
