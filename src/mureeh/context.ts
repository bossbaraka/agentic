/**
 * Context Engineering — dynamic context construction, token budgeting,
 * relevant entity retrieval, conversation summarization, stale-context prevention.
 */

import type { MureehToolContext } from './types.js';
import { getMemory } from './memory.js';

export interface ContextBudget {
  maxTokens: number;
  reservedForTools: number;
  reservedForResponse: number;
  used: number;
}

export interface RelevantContext {
  restaurantId: string;
  branchId?: string | null;
  currentTime: string;
  timezone: string;
  relevantEntities: {
    products?: { id: string; name: string }[];
    tables?: { id: string; number: number }[];
    orders?: { id: string; status: string }[];
  };
  recentToolResultsSummary?: string;
  conversationSummary?: string;
  memoryContext: string;
  // Only include what's relevant for the query
  includeMenu: boolean;
  includeOrders: boolean;
  includeTables: boolean;
  includeAnalytics: boolean;
  includeOffers: boolean;
}

export function estimateTokens(text: string): number {
  // Rough estimate: 1 token ~ 4 chars for English, ~2-3 chars for Arabic
  // Use conservative estimate
  return Math.ceil(text.length / 3);
}

export function buildRelevantContext(
  query: string,
  toolContext: MureehToolContext,
  contactKey: string,
  opts: { conversationSummary?: string; recentToolResults?: string } = {}
): RelevantContext {
  const lower = query.toLowerCase();

  // Determine what's relevant based on query keywords
  const menuKeywords = ['منيو', 'قائمة', 'صنف', 'منتج', 'وجبة', 'سعر', 'category', 'product', 'menu', 'price', 'addon'];
  const orderKeywords = ['طلب', 'طلبات', 'order', 'preparing', 'pending', 'جاهز', 'متأخر', 'تأخر'];
  const tableKeywords = ['طاولة', 'طاولات', 'table', 'جلسة', 'session', 'حساب', 'فاتورة'];
  const analyticsKeywords = ['مبيعات', 'أكثر', 'أفضل', 'تحليل', 'تقرير', 'أداء', 'إحصائيات', 'sales', 'analytics', 'report', 'best', 'top'];
  const offerKeywords = ['عرض', 'عروض', 'خصم', 'offer', 'discount', 'promo'];
  const waiterKeywords = ['نادل', 'waiter', 'استدعاء', 'خدمة'];

  const includeMenu = menuKeywords.some((k) => lower.includes(k));
  const includeOrders = orderKeywords.some((k) => lower.includes(k)) || analyticsKeywords.some((k) => lower.includes(k));
  const includeTables = tableKeywords.some((k) => lower.includes(k)) || waiterKeywords.some((k) => lower.includes(k));
  const includeAnalytics = analyticsKeywords.some((k) => lower.includes(k));
  const includeOffers = offerKeywords.some((k) => lower.includes(k));

  // If query is very generic like "كم طلب عندنا الآن؟", include orders + tables
  const isOperationalQuery = /كم\s+طلب|عدد\s+الطلبات|طلبات\s+الآن|orders\s+now|pending\s+orders/i.test(query);
  const finalIncludeOrders = includeOrders || isOperationalQuery;
  const finalIncludeTables = includeTables || isOperationalQuery || /طاولة|table/i.test(query);

  const mem = getMemory(contactKey, toolContext.restaurantId, toolContext.language);

  return {
    restaurantId: toolContext.restaurantId,
    branchId: toolContext.branchId,
    currentTime: new Date().toISOString(),
    timezone: 'Asia/Jerusalem',
    relevantEntities: {
      products: mem.shortTerm.lastEntities.product ? [mem.shortTerm.lastEntities.product as any] : undefined,
      tables: mem.shortTerm.lastEntities.table ? [mem.shortTerm.lastEntities.table as any] : undefined,
      orders: mem.shortTerm.lastEntities.order ? [{ id: mem.shortTerm.lastEntities.order.id, status: 'unknown' }] : undefined,
    },
    recentToolResultsSummary: opts.recentToolResults,
    conversationSummary: opts.conversationSummary,
    memoryContext: `Language: ${mem.shortTerm.userPreferences.language}, Reporting: ${mem.shortTerm.userPreferences.reportingStyle}, Last product: ${mem.shortTerm.lastEntities.product?.name || 'none'}, Last table: ${mem.shortTerm.lastEntities.table?.number || 'none'}`,
    includeMenu,
    includeOrders: finalIncludeOrders,
    includeTables: finalIncludeTables,
    includeAnalytics,
    includeOffers,
  };
}

export function buildContextPrompt(relevant: RelevantContext): string {
  const lines: string[] = [];

  lines.push(`[CONTEXT] Restaurant: ${relevant.restaurantId}`);
  if (relevant.branchId) lines.push(`Branch: ${relevant.branchId}`);
  lines.push(`Current time: ${relevant.currentTime} (${relevant.timezone})`);
  lines.push(`Memory: ${relevant.memoryContext}`);

  if (relevant.conversationSummary) {
    lines.push(`Conversation summary: ${relevant.conversationSummary}`);
  }

  if (relevant.recentToolResultsSummary) {
    lines.push(`Recent tool results: ${relevant.recentToolResultsSummary}`);
  }

  // Hint for what to retrieve
  const needed: string[] = [];
  if (relevant.includeMenu) needed.push('menu/products/categories');
  if (relevant.includeOrders) needed.push('orders (pending/preparing/ready)');
  if (relevant.includeTables) needed.push('tables/sessions/waiter requests');
  if (relevant.includeAnalytics) needed.push('sales analytics / operational analytics');
  if (relevant.includeOffers) needed.push('offers');

  if (needed.length) {
    lines.push(`Relevant data needed: ${needed.join(', ')}`);
  }

  // Token budgeting hint
  lines.push(`Instruction: Only retrieve what is relevant. Do NOT fetch entire menu if question is about orders. Use parallel reads where independent.`);

  return lines.join('\n');
}

export function compressToolResult(result: unknown, maxChars = 2000): string {
  const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (str.length <= maxChars) return str;
  // Truncate intelligently: keep start and end
  const half = Math.floor(maxChars / 2);
  return str.slice(0, half) + '\n...[truncated]...\n' + str.slice(-half);
}

export function summarizeConversationHistory(messages: { role: string; text: string }[], maxTokens = 500): string {
  if (messages.length === 0) return '';
  // Simple summarization: keep last 3 exchanges + summarize older
  const recent = messages.slice(-6);
  const older = messages.slice(0, -6);

  let summary = '';
  if (older.length > 0) {
    summary += `Earlier: ${older.map((m) => `${m.role}: ${m.text.slice(0, 100)}`).join(' | ').slice(0, 300)}... `;
  }
  summary += `Recent: ${recent.map((m) => `${m.role}: ${m.text.slice(0, 150)}`).join(' | ')}`;
  return summary.slice(0, maxTokens * 3); // rough char limit
}
