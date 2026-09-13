# AGENT MEMORY — Short-term, Long-term, Pronoun Resolution, Context Engineering

## Memory Architecture

```
MEMORY
 ├─ SHORT-TERM (per session, ephemeral, 45min TTL, cleared on /مسح)
 │   ├─ currentRestaurantId
 │   ├─ currentBranchId
 │   ├─ currentTask
 │   ├─ recentToolResults (last 10)
 │   ├─ unresolvedClarification { question, options, intent, expiresAt }
 │   ├─ userPreferences (in-session overrides)
 │   ├─ conversationContext { lastProductMentioned, lastTableMentioned, lastOrderMentioned, lastIntent, lastIntentDetail }
 │   ├─ lastEntities { product: {id,name}, table: {id,number}, order: {id,numericId}, category: {id,name} }
 │   └─ conversationSummary + messages (from store.ts)
 │
 └─ LONG-TERM (persistent, no secrets, stored in-memory Map + optional file/SQLite)
     ├─ preferredLanguage (ar/en)
     ├─ preferredReportingStyle (concise/detailed/structured)
     ├─ operationalPreferences { dailyReportTime, proactiveAlerts, alertThresholds { delayedOrderMinutes, kitchenOverloadOrders } }
     └─ commonQueries (frequency map, future personalization)
```

## Short-term Memory (src/mureeh/memory.ts)

- **Storage**: Map<string, MureehMemoryState> keyed by contactKey (whatsapp:..., telegram:...)
- **Init**: getMemory(contactKey) returns default if missing
- **Update**: updateShortTerm(contactKey, partial) merges into shortTerm
- **Tool Results**: addToolResult(contactKey, toolName, result) pushes to recentToolResults, max 10, stores { toolName, result, timestamp, truncated? }
- **Entities**: setLastEntity(contactKey, type, entity) updates lastEntities + conversationContext
- **Clarification**: setUnresolvedClarification(contactKey, { question, options, intent, timestamp }) stores with 5min expiry, clearUnresolvedClarification removes
- **History**: addHistory(contactKey, role, content) delegates to store.ts addHistory (JSON file + SQLite bridge)
- **No secrets**: validateNoSecretsInLog enforced before storage

### Pronoun Resolution (Critical for Arabic)

`resolvePronounReference(message, memory)` handles:

Arabic pronouns:
- "هو", "هي", "هم", "نفسه", "نفسها" → resolve to lastProductMentioned if product-related, else lastOrderMentioned, else lastTableMentioned
- "هذا المنتج", "هذا الصنف", "هذا الطلب", "هذه الطاولة" → explicit type
- "وكم واحد انباع؟" after product mentioned → lastProductMentioned
- "وش وضعه؟" after order mentioned → lastOrderMentioned
- "كم سعرها؟" after product feminine → lastProductMentioned
- "أين هي؟" after table → lastTableMentioned

English:
- "it", "this product", "this order", "this table", "how many sold", "what's its price"

Implementation:
1. Check if message contains pronoun pattern regex
2. Look at lastEntities to resolve
3. Return { resolved: true, entityType, entity, originalPronoun }
4. If not resolved, return { resolved: false }

Used in mureehAgent before intent classification to enrich context.

Example:
```
User: "شو سعر الشاورما؟"
Agent: "سعر شاورما الدجاج 35 شيكل"
User: "وكم واحد انباع منها اليوم؟"
resolvePronounReference → { resolved: true, entityType: 'product', entity: {id: 'prod_1', name: 'شاورما دجاج'} }
→ intent becomes product_performance for prod_1, not generic
```

### Contextual Memory for Multi-turn

```
Turn 1: "كم طلب عندنا الآن؟" → getOrders PENDING → stores lastIntent=OPERATIONS, lastIntentDetail=pending_orders
Turn 2: "واللي قيد التحضير؟" → pronoun "اللي" + lastIntent → understands PREPARING
Turn 3: "وش أطول واحد فيهم متأخر؟" → resolves to last orders list, finds max elapsed
```

## Long-term Memory (Future Persistent)

Currently in-memory, will migrate to:
- store.patchProfile equivalent for Mureeh
- SQLite users table extra columns
- File store JSON

Stores:
- preferredLanguage: detected from user messages, default ar
- preferredReportingStyle: inferred from feedback "اختصر" → concise, "فصل" → detailed, default concise
- operationalPreferences: learned from "ذكرني كل يوم الساعة 8" → dailyReportTime 08:00
- commonQueries: frequency of intents for proactive suggestions

Never stores:
- API keys, tokens, passwords, personal IDs, payment info

## Context Engineering (src/mureeh/context.ts)

### Relevant Context Determination

`buildRelevantContext(query, toolContext, contactKey)`:
- Keyword scan: "منيو/قائمة" → includeMenu true, "طلب/أوردر" → includeOrders, "طاولة" → includeTables, "مبيعات/أداء/تحليل/أكثر مبيعاً" → includeAnalytics, "عرض/خصم" → includeOffers
- Memory: if recentToolResults contain product info, include last product context
- Branch awareness: if toolContext.branchId present, scope queries to branch

### Context Prompt Building

`buildContextPrompt(relevant)`:
```
[CONTEXT]
Restaurant: {restaurantId} Branch: {branchId}
Current Time: {Asia/Jerusalem formatted}
Memory: {lastProduct, lastTable, lastOrder, lastIntent, unresolvedClarification}
Conversation Summary: {summary}
Recent Tool Results: {last 3 summarized}
User Preferences: {language, style}
Needed: {menu/orders/tables/analytics/offers}
Instruction: Only retrieve what is relevant to the user request. Keep responses concise, grounded.
```

### Token Budgeting

- estimateTokens(text): ~ text.length / 4 (rough Arabic+English)
- compressToolResult(result, maxChars=2000): if JSON string > max, truncate array to first 5 items + "... (truncated, total N)"
- summarizeConversationHistory(messages): keep last 6 raw, summarize older via "Previous conversation: [topics]..." — not LLM, deterministic truncation
- Total context budget: 4000 tokens max for relevant context block (configurable)

### Why This Matters

Without token budgeting, daily report with 50 orders + 30 products + 10 tables = ~15k tokens, expensive and slow. With selective retrieval + compression, same report ~2k tokens.

## Memory Lifecycle

```
Inbound message
 ↓
getMemory(contactKey)
 ↓
resolvePronounReference(message, memory) → enriched message
 ↓
check unresolvedClarification (if exists and not expired, treat current message as answer to clarification)
 ↓
classifyRestaurantIntent(enrichedMessage)
 ↓
buildRelevantContext(query, toolContext, contactKey)
 ↓
buildContextPrompt(relevant)
 ↓
execute tools
 ↓
updateShortTerm with recentToolResults, lastEntities, conversationContext
 ↓
addHistory(role=user, content) + addHistory(role=assistant, content=response)
 ↓
if performance intent, store in long-term commonQueries frequency
```

## Persistence

- store.ts: JSON file per contactKey at data/sessions/<key>.json — atomic write via temp+rename, contains profile, launch, summary, messages, stats, mureehMemory (future)
- SQLite bridge: src/db/ (if enabled) syncs conversations, messages, users
- Memory Map: in-memory for speed, restored from file on startup (future: load from file)

## Clear / Reset

- /مسح command in agent.ts clears store and memory Map for contactKey
- clearUnresolvedClarification after answered or expired (5min)

## Security

- No secrets in memory: validateNoSecretsInLog before addToolResult
- Cross-tenant isolation: memory keyed by contactKey, but tool results validated against expected restaurantId
- Prompt injection in history: sanitizeRetrievedData applied when building context prompt
