/**
 * Tool registry for restaurant intelligence — combines read + action tools.
 * Strongly typed, validated, permission-aware.
 */

import { readTools, type ToolDefinition } from './readTools.js';
import { actionTools } from './actionTools.js';
import type { MureehToolContext, ToolResult } from '../types.js';
import { recordTrace } from '../observability.js';

export const allMureehTools: ToolDefinition[] = [...readTools, ...actionTools];

const toolMap = new Map<string, ToolDefinition>();
for (const t of allMureehTools) {
  toolMap.set(t.name, t);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name);
}

export function listTools(): ToolDefinition[] {
  return allMureehTools;
}

export function listToolsForPrompt(): string {
  return allMureehTools
    .map((t) => `- ${t.name}: ${t.descriptionAr} — ${t.description} (permission: ${t.permission}${t.requiresApproval ? ', requires approval' : ''})`)
    .join('\n');
}

export interface ToolCallResult {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  latencyMs: number;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: MureehToolContext
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, error: `Tool not found: ${name}`, errorCode: 'NOT_FOUND', source: 'api' };
  }

  // Validate input schema
  const parsed = tool.inputSchema.parse(args);
  if (!parsed.success) {
    return { ok: false, error: parsed.error, errorCode: 'VALIDATION_ERROR', source: 'api' };
  }

  // Execute with timeout
  const timeoutMs = tool.timeoutMs;
  try {
    const result = await Promise.race([
      tool.execute(parsed.data || {}, context),
      new Promise<ToolResult>((_, reject) => setTimeout(() => reject(new Error(`Tool ${name} timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return result;
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), errorCode: 'TIMEOUT_OR_ERROR', source: 'api' };
  }
}

// Parallel execution for independent reads
export async function executeToolsParallel(
  calls: { name: string; args: Record<string, unknown> }[],
  context: MureehToolContext
): Promise<ToolCallResult[]> {
  const results = await Promise.all(
    calls.map(async (call) => {
      const start = Date.now();
      const result = await executeTool(call.name, call.args, context);
      return { tool: call.name, args: call.args, result, latencyMs: Date.now() - start };
    })
  );
  return results;
}

// Sequential execution for dependent writes
export async function executeToolsSequential(
  calls: { name: string; args: Record<string, unknown> }[],
  context: MureehToolContext
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const call of calls) {
    const start = Date.now();
    const result = await executeTool(call.name, call.args, context);
    results.push({ tool: call.name, args: call.args, result, latencyMs: Date.now() - start });
    if (!result.ok) {
      // Stop on first failure for sequential
      break;
    }
  }
  return results;
}

// Tool selection based on intent
export function selectToolsForIntent(
  intent: string,
  detail: string,
  entities: Record<string, unknown>
): { name: string; args: Record<string, unknown> }[] {
  const tools: { name: string; args: Record<string, unknown> }[] = [];

  switch (detail) {
    case 'menu_info':
      tools.push({ name: 'getMenu', args: {} });
      break;
    case 'product_info':
      tools.push({ name: 'getProduct', args: { productName: (entities as any).productName || '' } });
      break;
    case 'order_status':
      if ((entities as any).orderId) {
        tools.push({ name: 'getOrder', args: { orderId: (entities as any).orderId } });
      } else {
        tools.push({ name: 'getOrders', args: { status: 'PENDING', limit: 20 } });
        tools.push({ name: 'getOrders', args: { status: 'PREPARING', limit: 20 } });
        tools.push({ name: 'getOrders', args: { status: 'READY', limit: 20 } });
      }
      break;
    case 'table_status':
      tools.push({ name: 'getTableStatus', args: {} });
      if ((entities as any).tableNumber) {
        // Will filter in tool
      }
      break;
    case 'best_selling':
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: (entities as any).timeframe || 'today' } });
      tools.push({ name: 'getRestaurantStats', args: {} });
      break;
    case 'slow_products':
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: (entities as any).timeframe || 'week' } });
      break;
    case 'peak_times':
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: 'today' } });
      break;
    case 'revenue_summary':
      tools.push({ name: 'getRestaurantStats', args: {} });
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: 'today' } });
      break;
    case 'performance':
      tools.push({ name: 'getRestaurantStats', args: {} });
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: 'today' } });
      tools.push({ name: 'getOperationalAnalytics', args: {} });
      break;
    case 'pending_orders':
      tools.push({ name: 'getOrders', args: { status: 'PENDING', limit: 30 } });
      break;
    case 'delayed_orders':
      tools.push({ name: 'getOperationalAnalytics', args: {} });
      tools.push({ name: 'getOrders', args: { status: 'PREPARING', limit: 30 } });
      break;
    case 'occupied_tables':
      tools.push({ name: 'getTableStatus', args: { status: 'OCCUPIED' } });
      break;
    case 'waiter_requests':
      tools.push({ name: 'getWaiterRequests', args: { status: 'PENDING' } });
      break;
    case 'bill_requested':
      tools.push({ name: 'getTableStatus', args: { status: 'BILL_REQUESTED' } });
      break;
    case 'suggest_offer':
      tools.push({ name: 'getSalesAnalytics', args: { timeframe: 'week' } });
      tools.push({ name: 'getOffers', args: { activeOnly: true } });
      break;
    case 'update_order':
      tools.push({ name: 'getOrder', args: { orderId: (entities as any).orderId || '' } });
      break;
    default:
      // Default: try to get operational overview
      tools.push({ name: 'getOperationalAnalytics', args: {} });
      break;
  }

  // Remove empty args where required fields missing — will be caught in validation
  return tools.filter((t) => {
    if (t.name === 'getProduct' && !t.args.productName && !t.args.productId) return false;
    if (t.name === 'getOrder' && !t.args.orderId) return false;
    return true;
  });
}
