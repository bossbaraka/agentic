# AGENT OPERATIONS — Observability, Deployment, Cost, Runbook

## Observability (src/mureeh/observability.ts)

### Trace Structure

```ts
interface AgentTrace {
  requestId: string; // req_ + random
  userId?: string;
  restaurantId?: string;
  branchId?: string;
  contactKey: string; // whatsapp:... or telegram:...
  intent?: string; // INFORMATION, ANALYTICS, etc
  intentConfidence?: number;
  taskType?: string; // menu_info, best_selling, pending_orders...
  selectedTools: Array<{ name, args, latencyMs, ok, error }>;
  toolErrors: string[];
  executionDurationMs: number;
  modelUsed?: string;
  tokenUsage?: { input, output, total };
  finalResult?: string; // truncated response
  failureReason?: string;
  timestamp: number;
  grounded: boolean; // true if response based on tool data
  hallucinationDetected: boolean;
  crossTenantAttempt: boolean;
  approvalRequired: boolean;
  approvalGranted?: boolean;
}
```

### Recording

`recordTrace(trace)`:
- Sanitizes args via validateNoSecretsInLog
- Stores in-memory array max 500 (circular)
- Logs summary to console: `[TRACE] requestId intent taskType duration tools ok grounded`
- In production, forward to external observability (Datadog, etc) — future

### Querying

- `getRecentTraces(limit=20)`: last N traces
- `getTrace(requestId)`: specific trace
- `computeQualityMetrics()`: aggregates last 100 traces
- `observabilitySnapshot()`: returns recent traces + metrics + timestamp for dashboard

### Quality Metrics

```ts
interface QualityMetrics {
  totalTraces: number;
  groundedRate: number; // % grounded true
  hallucinationRate: number; // % hallucination true
  avgLatencyMs: number;
  toolSuccessRate: number; // % tool ok
  authViolationRate: number; // % FORBIDDEN
  crossTenantLeakageRate: number; // % crossTenantAttempt (should be 0 leakage, but attempts blocked)
  taskCompletionRate: number; // % finalResult ok and not failure
}
```

Targets:
- groundedRate >95%
- hallucinationRate <1%
- avgLatency <3s simple, <8s complex report
- toolSuccessRate >90%
- authViolationRate low (<5% — indicates RBAC working, not being bypassed)
- crossTenantLeakageRate 0% actual leakage, but attempts logged
- taskCompletionRate >85%

### Logging

- All tool executions logged via toolRegistry audit: tool name, args (sanitized), latency, ok, error, requestId, restaurantId
- All security denials logged with requestId, contactKey, tool, reason
- All approval requests logged with approvalId, tool, args, severity
- No secrets in logs (validateNoSecretsInLog)

## Deployment

### Environment Variables

```bash
# Mureeh Integration
MUREEH_API_URL=https://api.mureeh.com/api
MUREEH_SERVICE_TOKEN=service_jwt_token
MUREEH_TOOLS_ENABLED=true
MUREEH_DEMO_MODE=false
MUREEH_CONTACT_MAPPING={"whatsapp:970599123456":{"restaurantId":"rest_123","role":"MANAGER","branchId":"branch_1"}}

# Agent Config
AGENT_MAX_ITERATIONS=8
AGENT_TIMEOUT_MS=30000
AGENT_MAX_TOOL_CALLS=12
AGENT_MEMORY_TTL_MINUTES=45

# Existing
OPENAI_API_KEY=...
GEMINI_API_KEY=...
# etc from config.ts
```

### Demo Mode

For local dev without Mureeh backend:
```bash
MUREEH_DEMO_MODE=true
MUREEH_TOOLS_ENABLED=true
```
- Uses demoData.ts realistic data
- No API calls
- Action tools simulate success

### Build & Run

```bash
npm run build # tsc --noEmit check, then build
npm start # starts server.ts with orchestrator
```

### Health Check

- GET /health returns ok, uptime, version, mureeh integration status (demo vs api, tools enabled)

## Cost & Latency Controls

### Parallelization

- Independent reads parallel: getOrders PENDING + PREPARING + READY executed via Promise.all
- Performance report: 3 parallel calls (stats, sales, operational) not sequential
- Saves ~2-3s per complex query

### Selective Retrieval

- buildRelevantContext determines needed data: if query about orders, don't fetch menu
- Reduces tokens and API calls

### Context Compression

- compressToolResult truncates large arrays to first 5 + total count
- summarizeConversationHistory keeps last 6 messages raw, older summarized deterministically
- estimateTokens monitors budget, keeps relevant context block <4000 tokens

### Caching

- Demo data cached in memory
- Short-term memory recentToolResults acts as cache: if same product queried twice within session, reuse last result (future optimization)
- No external cache yet (Redis future)

### Model Routing (Future)

- FAST tier for intent classification (currently deterministic regex, no LLM cost)
- BALANCED for normal responses
- STRONG for complex reports (performance summary, anomaly analysis)
- Currently uses config.llm.PROVIDER (openai/gemini) with fallback chain

### Token Budget

- Relevant context block: max 4000 tokens
- Tool results compressed to 2000 chars each max
- Conversation history: last 6 messages raw (~1500 tokens) + summary (~200)
- Total prompt to LLM: target <6000 tokens for simple, <10000 for complex

### Latency Budget

- Intent classification: <10ms (regex)
- Context building: <5ms
- Tool execution: 8-15s worst case (3 parallel API calls 2s each + retry)
- LLM reasoning: 1-3s (if used, currently mureehAgent does not call LLM for deterministic intents, only for analytics summary)
- Total: <3s simple, <8s complex

## Runbook

### Issue: Agent returns "تعذر جلب البيانات"

- Check MUREEH_API_URL reachable: curl $MUREEH_API_URL/health
- Check MUREEH_SERVICE_TOKEN valid: decode JWT expiry
- Check logs for tool errors: toolErrors in trace
- Fallback to demo mode if API down: set MUREEH_DEMO_MODE=true temporarily

### Issue: Cross-tenant attempt logged

- Investigate contactKey, restaurantId, tool, args
- Verify MUREEH_CONTACT_MAPPING correct
- Check if user manipulated restaurantId param (should be blocked)
- If legitimate need for multi-restaurant access, add mapping for PLATFORM_ADMIN role

### Issue: High hallucinationRate

- Check if tools returning empty but agent fabricating → bug in grounded check
- Verify buildContextPrompt includes instruction "Only use tool data"
- Review recent traces finalResult vs tool outputs
- Add more explicit grounding in prompt

### Issue: High latency

- Check tool latencies in trace.selectedTools
- If Mureeh API slow, check backend DB, add index
- Enable parallel execution (already)
- Reduce tool calls via selective retrieval
- Check if LLM fallback chain causing delay (GEMINI_MODEL_FALLBACKS)

### Issue: Approval not working

- Check approval Map not cleared (in-memory, resets on restart — future: persistent)
- Verify checkExplicitApproval keywords include user's language
- Check expiry 5min not too short

### Issue: Pronoun resolution fails

- Check memory lastEntities populated
- Verify resolvePronounReference regex covers dialect used
- Add new pattern to regex

### Issue: Agent not routing to restaurant intelligence

- Check MUREEH_TOOLS_ENABLED=true
- Check isRestaurantOperationalQuery detects query — add keyword if missing
- Check resolveContactToTenant returns mapping or demo mode enabled
- Check logs for "restaurant intelligence" routing

## Monitoring Dashboard (Future)

- Endpoint GET /admin/observability returns observabilitySnapshot JSON
- Shows recent traces, quality metrics, tool success rates, latency histogram
- Protected by PLATFORM_ADMIN role

## Rollback

- Feature flag MUREEH_TOOLS_ENABLED=false disables restaurant intelligence, falls back to sales agent
- No DB migration required for rollback (memory Map in-memory)
- If new tools cause issues, set MUREEH_DEMO_MODE=true to isolate from API

## Scaling

- Current: single process, in-memory Maps for memory, traces, approvals (max 500 traces, 100 approvals, per-contact memory)
- For horizontal scaling: move Maps to Redis, traces to DB or external observability, approvals to DB
- Stateless design: toolContext contains all needed (restaurantId, role, branchId) — no server affinity required

## Security Operations

- Rotate MUREEH_SERVICE_TOKEN regularly
- Review crossTenantAttempt logs daily
- Review authViolation logs for brute force
- Ensure logs redacted (no secrets)
- Audit MUREEH_CONTACT_MAPPING for stale entries

## Cost Estimation

- Simple query (pending orders): 1-2 tool calls, no LLM, ~0 cost, <1s
- Analytics query (best selling): 1 tool call, no LLM, ~0 cost, <1s
- Performance report: 3 tool calls + analytics.ts calculations (no LLM) or optional LLM summary (~500 tokens), cost ~$0.001, <3s
- If LLM used for final formatting: ~1000 input + 500 output tokens, ~$0.002 per query (OpenAI gpt-4o-mini) or ~$0.001 (Gemini flash)

With 1000 queries/day, ~80% simple, 20% complex: ~$0.5/day LLM cost + Mureeh API cost negligible.
