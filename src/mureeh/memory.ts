/**
 * Layered memory for restaurant intelligence agent.
 * SHORT-TERM: current restaurant, branch, task, recent tool results, unresolved clarification, user prefs within conversation.
 * LONG-TERM: preferred reporting style, language, operational prefs (no secrets).
 */

export interface ShortTermMemory {
  currentRestaurantId: string;
  currentBranchId?: string | null;
  currentTask?: string;
  recentToolResults: { tool: string; result: unknown; timestamp: number }[];
  unresolvedClarification?: { question: string; context: string; timestamp: number };
  userPreferences: {
    language: 'ar' | 'en';
    reportingStyle?: 'concise' | 'detailed' | 'structured';
    preferredTimeframe?: 'today' | 'week' | 'month';
  };
  conversationContext: {
    lastProductMentioned?: { id: string; name: string };
    lastTableMentioned?: { id: string; number: number };
    lastOrderMentioned?: { id: string };
    lastIntent?: string;
  };
  // For "وكم واحد انباع؟" referring to previous product
  lastEntities: {
    product?: { id: string; name: string };
    table?: { id: string; number: number };
    order?: { id: string };
    category?: { id: string; name: string };
  };
}

export interface LongTermMemory {
  preferredLanguage: 'ar' | 'en';
  preferredReportingStyle: 'concise' | 'detailed' | 'structured';
  operationalPreferences: {
    // e.g., manager prefers daily reports at 9pm, or wants proactive alerts for delayed orders
    dailyReportTime?: string;
    proactiveAlerts?: boolean;
    alertThresholds?: {
      delayedOrderMinutes?: number;
      kitchenOverloadOrders?: number;
    };
  };
  // Non-sensitive business prefs
  commonQueries?: string[];
  // No passwords, tokens, secrets, payment data
}

export interface ConversationMemory {
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
  history: { role: 'user' | 'assistant'; text: string; timestamp: number }[];
}

// In-memory store per contactKey (could be persisted to SQLite in production)
const memoryStore = new Map<string, ConversationMemory>();

function createDefaultShortTerm(restaurantId: string, language: 'ar' | 'en' = 'ar'): ShortTermMemory {
  return {
    currentRestaurantId: restaurantId,
    currentBranchId: null,
    currentTask: undefined,
    recentToolResults: [],
    unresolvedClarification: undefined,
    userPreferences: {
      language,
      reportingStyle: 'concise',
      preferredTimeframe: 'today',
    },
    conversationContext: {},
    lastEntities: {},
  };
}

function createDefaultLongTerm(language: 'ar' | 'en' = 'ar'): LongTermMemory {
  return {
    preferredLanguage: language,
    preferredReportingStyle: 'concise',
    operationalPreferences: {
      proactiveAlerts: true,
      alertThresholds: {
        delayedOrderMinutes: 25,
        kitchenOverloadOrders: 8,
      },
    },
    commonQueries: [],
  };
}

export function getMemory(contactKey: string, restaurantId: string, language: 'ar' | 'en' = 'ar'): ConversationMemory {
  let mem = memoryStore.get(contactKey);
  if (!mem) {
    mem = {
      shortTerm: createDefaultShortTerm(restaurantId, language),
      longTerm: createDefaultLongTerm(language),
      history: [],
    };
    memoryStore.set(contactKey, mem);
  }
  // Update restaurant if changed
  if (mem.shortTerm.currentRestaurantId !== restaurantId) {
    mem.shortTerm.currentRestaurantId = restaurantId;
  }
  return mem;
}

export function updateShortTerm(contactKey: string, patch: Partial<ShortTermMemory>): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  mem.shortTerm = { ...mem.shortTerm, ...patch, lastEntities: { ...mem.shortTerm.lastEntities, ...(patch.lastEntities || {}) } };
}

export function addToolResult(contactKey: string, tool: string, result: unknown): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  mem.shortTerm.recentToolResults.push({ tool, result, timestamp: Date.now() });
  // Keep only last 10
  if (mem.shortTerm.recentToolResults.length > 10) {
    mem.shortTerm.recentToolResults.shift();
  }
}

export function setLastEntity(
  contactKey: string,
  type: 'product' | 'table' | 'order' | 'category',
  entity: { id: string; name?: string; number?: number }
): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  if (type === 'product') {
    mem.shortTerm.lastEntities.product = { id: entity.id, name: entity.name || '' };
    mem.shortTerm.conversationContext.lastProductMentioned = { id: entity.id, name: entity.name || '' };
  } else if (type === 'table') {
    mem.shortTerm.lastEntities.table = { id: entity.id, number: entity.number || 0 };
    mem.shortTerm.conversationContext.lastTableMentioned = { id: entity.id, number: entity.number || 0 };
  } else if (type === 'order') {
    mem.shortTerm.lastEntities.order = { id: entity.id };
    mem.shortTerm.conversationContext.lastOrderMentioned = { id: entity.id };
  } else if (type === 'category') {
    mem.shortTerm.lastEntities.category = { id: entity.id, name: entity.name || '' };
  }
}

export function setUnresolvedClarification(contactKey: string, question: string, context: string): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  mem.shortTerm.unresolvedClarification = { question, context, timestamp: Date.now() };
}

export function clearUnresolvedClarification(contactKey: string): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  mem.shortTerm.unresolvedClarification = undefined;
}

export function addHistory(contactKey: string, role: 'user' | 'assistant', text: string): void {
  const mem = memoryStore.get(contactKey);
  if (!mem) return;
  mem.history.push({ role, text, timestamp: Date.now() });
  if (mem.history.length > 50) {
    mem.history.shift();
  }
}

export function resolvePronounReference(contactKey: string, text: string): { resolved: boolean; entityType?: string; entity?: any } {
  const mem = memoryStore.get(contactKey);
  if (!mem) return { resolved: false };

  const lower = text.toLowerCase();
  // Arabic pronouns: "وكم واحد انباع؟" "كم واحد" "هو" "هي" referring to last product
  const productRefPatterns = [
    /كم\s+واحد\s+انباع/,
    /كم\s+واحد/,
    /واحد\s+انباع/,
    /قديش\s+انباع/,
    /كم\s+انباع/,
    /how\s+many.*sold/i,
    /واحد/, // generic "one" after discussing product
  ];

  const isProductRef = productRefPatterns.some((p) => p.test(lower));
  if (isProductRef && mem.shortTerm.lastEntities.product) {
    return { resolved: true, entityType: 'product', entity: mem.shortTerm.lastEntities.product };
  }

  // Table reference: "كم طلب عندها؟" referring to last table
  const tableRefPatterns = [/كم\s+طلب\s+عندها/, /شو\s+وضعها/, /هل\s+طلبت\s+الحساب/];
  if (tableRefPatterns.some((p) => p.test(lower)) && mem.shortTerm.lastEntities.table) {
    return { resolved: true, entityType: 'table', entity: mem.shortTerm.lastEntities.table };
  }

  return { resolved: false };
}

export function getMemoryContextForPrompt(contactKey: string): string {
  const mem = memoryStore.get(contactKey);
  if (!mem) return '';

  const parts: string[] = [];
  parts.push(`[MEMORY] Restaurant: ${mem.shortTerm.currentRestaurantId}${mem.shortTerm.currentBranchId ? ` Branch: ${mem.shortTerm.currentBranchId}` : ''}`);
  if (mem.shortTerm.lastEntities.product) {
    parts.push(`Last product discussed: ${mem.shortTerm.lastEntities.product.name} (${mem.shortTerm.lastEntities.product.id})`);
  }
  if (mem.shortTerm.lastEntities.table) {
    parts.push(`Last table discussed: #${mem.shortTerm.lastEntities.table.number} (${mem.shortTerm.lastEntities.table.id})`);
  }
  if (mem.shortTerm.lastEntities.order) {
    parts.push(`Last order discussed: ${mem.shortTerm.lastEntities.order.id}`);
  }
  if (mem.shortTerm.unresolvedClarification) {
    parts.push(`Unresolved clarification: ${mem.shortTerm.unresolvedClarification.question} (context: ${mem.shortTerm.unresolvedClarification.context})`);
  }
  parts.push(`User language: ${mem.shortTerm.userPreferences.language}, reporting style: ${mem.shortTerm.userPreferences.reportingStyle}`);
  return parts.join('\n');
}
