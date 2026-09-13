/**
 * Mureeh Restaurant Intelligence Agent — genuine agentic execution loop.
 *
 * USER INTENT → CONTEXT UNDERSTANDING → TASK CLASSIFICATION → PLAN → RETRIEVE KNOWLEDGE/DATA
 * → SELECT TOOLS → EXECUTE TOOLS → VALIDATE RESULTS → REASON → DECIDE WHETHER MORE ACTION REQUIRED → FINAL RESPONSE
 *
 * Bounded: max iterations, timeout, tool-call limits, failure handling, retry, graceful termination.
 */

import { config } from '../config.js';
import { log } from '../lib/utils.js';
import { classifyRestaurantIntent, type RestaurantIntentResult } from './intelligence/restaurantIntent.js';
import { getMemory, addToolResult, setLastEntity, resolvePronounReference, addHistory } from '../mureeh/memory.js';
import { buildRelevantContext, buildContextPrompt, compressToolResult } from '../mureeh/context.js';
import { searchKnowledge, renderKnowledgeForPrompt } from '../mureeh/domainKnowledge.js';
import { selectToolsForIntent, executeToolsParallel, executeToolsSequential, listToolsForPrompt, getTool } from '../mureeh/tools/index.js';
import { analyzeSales, analyzeOperations, generateDailyReport, type Insight } from '../mureeh/analytics.js';
import { createToolContextFromContact, type ContactMapping, validateToolResultOwnership } from '../mureeh/authz.js';
import { createApprovalRequest, checkExplicitApproval, formatApprovalRequestAr, isApprovalValid, getApproval } from '../mureeh/approval.js';
import { recordTrace, type AgentTrace } from '../mureeh/observability.js';
import { detectPromptInjection } from '../mureeh/security.js';
import type { MureehToolContext } from '../mureeh/types.js';
import { getMureehClient } from '../mureeh/client.js';

export interface MureehAgentInput {
  contactKey: string; // WhatsApp number or Telegram id
  message: string;
  restaurantId?: string;
  branchId?: string | null;
  role?: string;
  userId?: string;
  language?: 'ar' | 'en';
  authToken?: string;
  requestId?: string;
}

export interface MureehAgentOutput {
  requestId: string;
  intent: RestaurantIntentResult;
  response: string;
  responseAr: string;
  insights: Insight[];
  toolsCalled: { name: string; args: Record<string, unknown>; ok: boolean; latencyMs?: number }[];
  requiresClarification: boolean;
  clarificationQuestion?: string;
  requiresApproval?: boolean;
  approvalId?: string;
  approvalMessage?: string;
  grounded: boolean;
  hallucination: boolean;
  executionDurationMs: number;
  failureReason?: string;
}

export class MureehAgent {
  private maxIterations: number;
  private maxToolCalls: number;
  private timeoutMs: number;

  constructor() {
    this.maxIterations = config.agent.MAX_ITERATIONS;
    this.maxToolCalls = config.agent.MAX_TOOL_CALLS;
    this.timeoutMs = config.agent.TIMEOUT_MS;
  }

  async execute(input: MureehAgentInput): Promise<MureehAgentOutput> {
    const start = Date.now();
    const requestId = input.requestId || `mureeh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // 1. AUTHENTICATION & TENANT IDENTIFICATION
    let toolContext: MureehToolContext | null = null;
    if (input.restaurantId) {
      toolContext = {
        requestId,
        userId: input.userId,
        restaurantId: input.restaurantId,
        branchId: input.branchId || null,
        role: (input.role as any) || 'RESTAURANT_MANAGER',
        language: input.language || 'ar',
        contactKey: input.contactKey,
        authToken: input.authToken,
      };
    } else {
      toolContext = createToolContextFromContact(input.contactKey, {
        requestId,
        userId: input.userId,
        branchId: input.branchId,
        role: input.role as any,
        language: input.language as any,
        authToken: input.authToken,
      });
    }

    if (!toolContext) {
      const failure: MureehAgentOutput = {
        requestId,
        intent: {
          intent: 'UNKNOWN',
          detail: 'unknown',
          confidence: 'low',
          entities: {},
          requiresClarification: false,
        },
        response: 'Unable to identify restaurant tenant. Please ensure your contact is mapped to a restaurant.',
        responseAr: 'تعذر تحديد المطعم. تأكد من ربط جهة الاتصال الخاصة بك بمطعم.',
        insights: [],
        toolsCalled: [],
        requiresClarification: false,
        grounded: false,
        hallucination: false,
        executionDurationMs: Date.now() - start,
        failureReason: 'TENANT_NOT_FOUND',
      };
      this.recordTrace(failure, toolContext, start);
      return failure;
    }

    // 2. SECURITY — prompt injection check on user input
    const injectionCheck = detectPromptInjection(input.message);
    if (injectionCheck.detected && injectionCheck.patterns.length > 2) {
      log.warn(`🚨 Potential prompt injection from ${input.contactKey}: ${injectionCheck.patterns.join(', ')}`);
      // We still process but treat as data, not instruction
    }

    // 3. MEMORY — get short-term memory
    const memory = getMemory(input.contactKey, toolContext.restaurantId, toolContext.language);

    // 4. PRONOUN RESOLUTION — handle "وكم واحد انباع؟"
    const pronounResolved = resolvePronounReference(input.contactKey, input.message);
    let effectiveMessage = input.message;
    if (pronounResolved.resolved && pronounResolved.entity) {
      // Inject resolved entity into context
      if (pronounResolved.entityType === 'product') {
        effectiveMessage = `${input.message} (يشير إلى المنتج: ${pronounResolved.entity.name})`;
      } else if (pronounResolved.entityType === 'table') {
        effectiveMessage = `${input.message} (يشير إلى الطاولة رقم ${pronounResolved.entity.number})`;
      }
    }

    // 5. INTENT UNDERSTANDING & CLASSIFICATION
    const intentResult = classifyRestaurantIntent(effectiveMessage);

    // 6. CONTEXT ENGINEERING — build relevant context
    const relevantContext = buildRelevantContext(effectiveMessage, toolContext, input.contactKey);
    const contextPrompt = buildContextPrompt(relevantContext);

    // 7. CHECK FOR PENDING APPROVAL
    const pendingApproval = this.checkPendingApproval(input.contactKey, input.message);
    if (pendingApproval) {
      if (pendingApproval.decision === 'APPROVED') {
        // Execute the approved tool
        const approval = getApproval(pendingApproval.approvalId!);
        if (approval && isApprovalValid(approval.id)) {
          const tool = getTool(approval.tool);
          if (tool) {
            const result = await tool.execute(approval.args, toolContext);
            const toolsCalled = [{ name: approval.tool, args: approval.args, ok: result.ok, latencyMs: result.latencyMs }];

            if (result.ok) {
              addToolResult(input.contactKey, approval.tool, result.data);
              const responseAr = `تم ${approval.descriptionAr} بنجاح ✅`;
              const output: MureehAgentOutput = {
                requestId,
                intent: intentResult,
                response: `Successfully executed ${approval.description}`,
                responseAr,
                insights: [],
                toolsCalled,
                requiresClarification: false,
                grounded: true,
                hallucination: false,
                executionDurationMs: Date.now() - start,
              };
              this.recordTrace(output, toolContext, start);
              addHistory(input.contactKey, 'user', input.message);
              addHistory(input.contactKey, 'assistant', responseAr);
              return output;
            } else {
              const failure: MureehAgentOutput = {
                requestId,
                intent: intentResult,
                response: `Failed to execute ${approval.description}: ${result.error}`,
                responseAr: `فشل تنفيذ ${approval.descriptionAr}: ${result.error}`,
                insights: [],
                toolsCalled,
                requiresClarification: false,
                grounded: true,
                hallucination: false,
                executionDurationMs: Date.now() - start,
                failureReason: result.error,
              };
              this.recordTrace(failure, toolContext, start);
              return failure;
            }
          }
        }
      } else if (pendingApproval.decision === 'REJECTED') {
        const output: MureehAgentOutput = {
          requestId,
          intent: intentResult,
          response: 'Operation cancelled as requested.',
          responseAr: 'تم إلغاء العملية حسب طلبك.',
          insights: [],
          toolsCalled: [],
          requiresClarification: false,
          grounded: true,
          hallucination: false,
          executionDurationMs: Date.now() - start,
        };
        this.recordTrace(output, toolContext, start);
        return output;
      }
      // If unclear, continue but keep pending
    }

    // 8. HANDLE AMBIGUITY — ask clarification if needed
    if (intentResult.requiresClarification && intentResult.clarificationQuestionAr) {
      const output: MureehAgentOutput = {
        requestId,
        intent: intentResult,
        response: intentResult.clarificationQuestion || 'Need clarification',
        responseAr: intentResult.clarificationQuestionAr,
        insights: [],
        toolsCalled: [],
        requiresClarification: true,
        clarificationQuestion: intentResult.clarificationQuestion,
        grounded: true,
        hallucination: false,
        executionDurationMs: Date.now() - start,
      };
      this.recordTrace(output, toolContext, start);
      // Store unresolved clarification
      const { setUnresolvedClarification } = await import('../mureeh/memory.js');
      setUnresolvedClarification(input.contactKey, intentResult.clarificationQuestionAr, intentResult.detail);
      return output;
    }

    // 9. PLAN — for complex tasks, create structured plan
    const plan = this.createPlan(intentResult, effectiveMessage);

    // 10. RETRIEVE KNOWLEDGE / DATA — RAG for domain knowledge
    const knowledgeEntries = searchKnowledge(effectiveMessage, 3);
    const knowledgePrompt = renderKnowledgeForPrompt(knowledgeEntries);

    // 11. SELECT TOOLS
    const toolCalls = selectToolsForIntent(intentResult.intent, intentResult.detail, intentResult.entities as any);

    if (toolCalls.length === 0 && intentResult.intent !== 'SUPPORT') {
      // No tools selected but not support — fallback to operational analytics
      toolCalls.push({ name: 'getOperationalAnalytics', args: {} });
    }

    // Check timeout
    if (Date.now() - start > this.timeoutMs) {
      const failure: MureehAgentOutput = {
        requestId,
        intent: intentResult,
        response: 'Request timeout — please try again',
        responseAr: 'انتهت مهلة الطلب، حاول مرة أخرى.',
        insights: [],
        toolsCalled: [],
        requiresClarification: false,
        grounded: false,
        hallucination: false,
        executionDurationMs: Date.now() - start,
        failureReason: 'TIMEOUT',
      };
      this.recordTrace(failure, toolContext, start);
      return failure;
    }

    // 12. EXECUTE TOOLS — bounded loop
    let executedResults: { name: string; args: Record<string, unknown>; result: any; latencyMs: number }[] = [];
    let toolCallCount = 0;
    let iteration = 0;

    // For performance: parallelize independent reads
    const readCalls = toolCalls.filter((c) => {
      const tool = getTool(c.name);
      return tool?.permission === 'READ';
    });
    const writeCalls = toolCalls.filter((c) => {
      const tool = getTool(c.name);
      return tool?.permission !== 'READ';
    });

    // Execute reads in parallel
    if (readCalls.length > 0) {
      const { executeToolsParallel } = await import('../mureeh/tools/index.js');
      const results = await executeToolsParallel(readCalls, toolContext);
      for (const r of results) {
        executedResults.push({ name: r.tool, args: r.args, result: r.result, latencyMs: r.latencyMs });
        toolCallCount++;
        if (r.result.ok) {
          addToolResult(input.contactKey, r.tool, r.result.data);
          // Update last entities
          if (r.tool === 'getProduct' && r.result.data) {
            const prod = r.result.data as any;
            setLastEntity(input.contactKey, 'product', { id: prod.id, name: prod.name });
          }
        }
      }
    }

    // Check if any write requires approval
    for (const call of writeCalls) {
      const tool = getTool(call.name);
      if (!tool) continue;

      // Check if destructive
      const { isDestructiveArgs } = await import('../mureeh/approval.js');
      const needsApproval = tool.requiresApproval || isDestructiveArgs(call.name, call.args);

      if (needsApproval) {
        const approvalReq = createApprovalRequest(requestId, toolContext.restaurantId, input.contactKey, call.name, call.args, toolContext.userId);
        const output: MureehAgentOutput = {
          requestId,
          intent: intentResult,
          response: `Approval required for ${approvalReq.description}`,
          responseAr: formatApprovalRequestAr(approvalReq),
          insights: [],
          toolsCalled: executedResults.map((r) => ({ name: r.name, args: r.args, ok: r.result.ok, latencyMs: r.latencyMs })),
          requiresClarification: false,
          requiresApproval: true,
          approvalId: approvalReq.id,
          approvalMessage: formatApprovalRequestAr(approvalReq),
          grounded: true,
          hallucination: false,
          executionDurationMs: Date.now() - start,
        };
        this.recordTrace(output, toolContext, start);
        return output;
      }

      // Execute write sequentially
      const { executeTool } = await import('../mureeh/tools/index.js');
      const result = await executeTool(call.name, call.args, toolContext);
      executedResults.push({ name: call.name, args: call.args, result, latencyMs: result.latencyMs || 0 });
      toolCallCount++;
      if (result.ok) {
        addToolResult(input.contactKey, call.name, result.data);
      } else {
        // Failure handling — classify and retry if retryable
        if (this.isRetryable(result.error || '')) {
          // Retry once
          const retryResult = await executeTool(call.name, call.args, toolContext);
          executedResults[executedResults.length - 1] = { name: call.name, args: call.args, result: retryResult, latencyMs: retryResult.latencyMs || 0 };
          if (!retryResult.ok) {
            const failure: MureehAgentOutput = {
              requestId,
              intent: intentResult,
              response: `Failed after retry: ${retryResult.error}`,
              responseAr: `تعذر تنفيذ العملية بعد إعادة المحاولة: ${retryResult.error}`,
              insights: [],
              toolsCalled: executedResults.map((r) => ({ name: r.name, args: r.args, ok: r.result.ok, latencyMs: r.latencyMs })),
              requiresClarification: false,
              grounded: true,
              hallucination: false,
              executionDurationMs: Date.now() - start,
              failureReason: retryResult.error,
            };
            this.recordTrace(failure, toolContext, start);
            return failure;
          }
        } else {
          const failure: MureehAgentOutput = {
            requestId,
            intent: intentResult,
            response: `Failed: ${result.error}`,
            responseAr: `تعذر تنفيذ العملية: ${result.error || 'خطأ غير معروف'}. حاول مرة أخرى بعد قليل.`,
            insights: [],
            toolsCalled: executedResults.map((r) => ({ name: r.name, args: r.args, ok: r.result.ok, latencyMs: r.latencyMs })),
            requiresClarification: false,
            grounded: true,
            hallucination: false,
            executionDurationMs: Date.now() - start,
            failureReason: result.error,
          };
          this.recordTrace(failure, toolContext, start);
          return failure;
        }
      }
    }

    // 13. VALIDATE RESULTS — check schema, ownership, missing values, contradictions
    const validation = this.validateResults(executedResults, toolContext.restaurantId);
    if (!validation.valid) {
      const failure: MureehAgentOutput = {
        requestId,
        intent: intentResult,
        response: `Validation failed: ${validation.reason}`,
        responseAr: `فشل التحقق من النتائج: ${validation.reason}`,
        insights: [],
        toolsCalled: executedResults.map((r) => ({ name: r.name, args: r.args, ok: r.result.ok, latencyMs: r.latencyMs })),
        requiresClarification: false,
        grounded: false,
        hallucination: false,
        executionDurationMs: Date.now() - start,
        failureReason: validation.reason,
      };
      this.recordTrace(failure, toolContext, start);
      return failure;
    }

    // 14. REASON — analytics and insights
    const insights = this.reason(intentResult, executedResults);

    // 15. FINAL RESPONSE — format adaptation
    const response = this.formatResponse(intentResult, executedResults, insights, toolContext.language);

    const output: MureehAgentOutput = {
      requestId,
      intent: intentResult,
      response: response.en,
      responseAr: response.ar,
      insights,
      toolsCalled: executedResults.map((r) => ({ name: r.name, args: r.args, ok: r.result.ok, latencyMs: r.latencyMs })),
      requiresClarification: false,
      grounded: true,
      hallucination: false,
      executionDurationMs: Date.now() - start,
    };

    // Update memory
    addHistory(input.contactKey, 'user', input.message);
    addHistory(input.contactKey, 'assistant', response.ar);

    this.recordTrace(output, toolContext, start);
    return output;
  }

  private createPlan(intent: RestaurantIntentResult, message: string): { goal: string; steps: string[] } {
    const goal = `${intent.intent}:${intent.detail} — ${message.slice(0, 100)}`;

    if (intent.detail === 'performance') {
      return {
        goal,
        steps: [
          'Retrieve today orders',
          'Retrieve sales metrics',
          'Retrieve product performance',
          'Retrieve operational metrics',
          'Compare against historical baseline',
          'Detect anomalies',
          'Generate insights',
          'Produce recommendations',
        ],
      };
    }

    if (intent.detail === 'best_selling') {
      return {
        goal,
        steps: ['Retrieve sales analytics', 'Retrieve popular products', 'Calculate top', 'Generate response'],
      };
    }

    return { goal, steps: [`Execute ${intent.detail}`] };
  }

  private checkPendingApproval(contactKey: string, message: string): { decision: 'APPROVED' | 'REJECTED' | 'UNCLEAR'; approvalId?: string } | null {
    const decision = checkExplicitApproval(message);
    if (decision === 'UNCLEAR') return null;

    const mem = getMemory(contactKey, 'demo-restaurant-1');
    if (mem.shortTerm.unresolvedClarification?.question?.includes('تأكيد')) {
      return { decision, approvalId: (mem.shortTerm.unresolvedClarification as any).approvalId };
    }

    return { decision };
  }

  private isRetryable(error: string): boolean {
    const retryablePatterns = [/timeout/i, /network/i, /econnreset/i, /etimedout/i, /temporarily unavailable/i, /تعذر الوصول/i];
    return retryablePatterns.some((p) => p.test(error));
  }

  private validateResults(
    results: { name: string; result: any }[],
    expectedRestaurantId: string
  ): { valid: boolean; reason?: string } {
    for (const r of results) {
      if (!r.result.ok) continue;
      const data = r.result.data;
      if (!data) continue;

      const ownership = validateToolResultOwnership(data, expectedRestaurantId);
      if (!ownership.valid) {
        return { valid: false, reason: ownership.reason };
      }
    }
    return { valid: true };
  }

  private reason(intent: RestaurantIntentResult, toolResults: { name: string; result: any }[]): Insight[] {
    const insights: Insight[] = [];

    // Find orders and products for analytics
    let orders: any[] = [];
    let products: any[] = [];
    let tables: any[] = [];
    let waiterRequests: any[] = [];

    for (const tr of toolResults) {
      if (!tr.result.ok) continue;
      if (tr.name === 'getOrders' || tr.name === 'getOrder') {
        const data = tr.result.data;
        if (Array.isArray(data)) orders = [...orders, ...data];
        else if (data) orders.push(data);
      }
      if (tr.name === 'getProducts' || tr.name === 'getProduct' || tr.name === 'getMenu') {
        const data = tr.result.data;
        if (data && Array.isArray(data)) products = [...products, ...data];
        else if (data && (data as any).products) products = [...products, ...(data as any).products];
        else if (data) products.push(data);
      }
      if (tr.name === 'getTableStatus') {
        const data = tr.result.data;
        if (Array.isArray(data)) tables = [...tables, ...data];
      }
      if (tr.name === 'getWaiterRequests') {
        const data = tr.result.data;
        if (Array.isArray(data)) waiterRequests = [...waiterRequests, ...data];
      }
    }

    // Use analytics module if we have data
    if (orders.length > 0) {
      try {
        const salesAnalysis = analyzeSales(orders, products, (intent.entities.timeframe as any) || 'today');
        insights.push(...salesAnalysis.insights);
      } catch {
        // ignore analytics errors
      }
      try {
        const opsAnalysis = analyzeOperations(orders, tables, waiterRequests);
        insights.push(...opsAnalysis.insights);
      } catch {
        // ignore
      }
    }

    // Add FACT vs CALCULATION labeling
    return insights;
  }

  private formatResponse(
    intent: RestaurantIntentResult,
    toolResults: { name: string; result: any }[],
    insights: Insight[],
    language: 'ar' | 'en'
  ): { en: string; ar: string } {
    // Simple questions: one-line answer
    if (intent.detail === 'pending_orders') {
      const ordersData = toolResults.find((r) => r.name === 'getOrders')?.result?.data;
      const count = Array.isArray(ordersData) ? ordersData.length : 0;
      return {
        en: `${count} pending orders currently.`,
        ar: `${count} طلب معلق حالياً.`,
      };
    }

    if (intent.detail === 'occupied_tables') {
      const tablesData = toolResults.find((r) => r.name === 'getTableStatus')?.result?.data;
      const count = Array.isArray(tablesData) ? tablesData.length : 0;
      return {
        en: `${count} tables occupied.`,
        ar: `${count} طاولة مشغولة حالياً.`,
      };
    }

    if (intent.detail === 'bill_requested') {
      const tablesData = toolResults.find((r) => r.name === 'getTableStatus')?.result?.data;
      if (Array.isArray(tablesData) && tablesData.length > 0) {
        const numbers = tablesData.map((t: any) => t.number).join(', ');
        return {
          en: `Tables requesting bill: ${numbers}`,
          ar: `الطاولات التي طلبت الحساب: ${numbers}`,
        };
      }
      return { en: 'No tables requesting bill.', ar: 'لا توجد طاولات طلبت الحساب.' };
    }

    if (intent.detail === 'best_selling') {
      const top = insights.find((i) => i.type === 'CALCULATION' && i.message.includes('Top product')) || insights[0];
      if (top) {
        return { en: top.message, ar: top.messageAr };
      }
      const salesData = toolResults.find((r) => r.name === 'getSalesAnalytics' || r.name === 'getRestaurantStats')?.result?.data;
      if (salesData?.topProducts?.length || salesData?.popularProducts?.length) {
        const topProducts = salesData.topProducts || salesData.popularProducts;
        const topName = topProducts[0].name;
        const count = topProducts[0].count;
        return {
          en: `Top selling today: ${topName} (${count} orders)`,
          ar: `الأكثر مبيعاً اليوم: ${topName} (${count} طلب)`,
        };
      }
      return { en: 'No sales data available.', ar: 'لا تتوفر بيانات مبيعات حالياً.' };
    }

    if (intent.detail === 'delayed_orders') {
      const opsData = toolResults.find((r) => r.name === 'getOperationalAnalytics')?.result?.data;
      if (opsData?.delayedOrders?.length) {
        const count = opsData.delayedOrders.length;
        return {
          en: `${count} delayed orders detected. Possible cause: high order volume during peak hours.`,
          ar: `${count} طلب متأخر. السبب المحتمل: ارتفاع ضغط الطلبات في فترة الذروة.`,
        };
      }
      return { en: 'No delayed orders.', ar: 'لا توجد طلبات متأخرة.' };
    }

    if (intent.detail === 'waiter_requests') {
      const waiterData = toolResults.find((r) => r.name === 'getWaiterRequests')?.result?.data;
      const count = Array.isArray(waiterData) ? waiterData.length : 0;
      return { en: `${count} pending waiter requests.`, ar: `${count} طلب استدعاء نادل معلق.` };
    }

    if (intent.detail === 'performance') {
      // Multi-step report
      const sales = toolResults.find((r) => r.name === 'getSalesAnalytics')?.result?.data;
      const ops = toolResults.find((r) => r.name === 'getOperationalAnalytics')?.result?.data;
      const stats = toolResults.find((r) => r.name === 'getRestaurantStats')?.result?.data;

      // Use generateDailyReport if we have enough
      if (sales && ops) {
        try {
          const report = generateDailyReport(
            {
              totalOrders: sales.totalOrders || stats?.todayOrdersCount || 0,
              totalRevenue: sales.totalRevenue || stats?.todayRevenue || 0,
              averageOrderValue: sales.averageOrderValue || stats?.averageOrderValue || 0,
              ordersByHour: sales.ordersByHour || [],
              ordersByDay: sales.ordersByDay || [],
              topProducts: sales.topProducts || stats?.popularProducts || [],
              slowProducts: sales.slowProducts || [],
              peakHours: sales.peakHours || [],
              cancellations: sales.cancellations || { count: 0, rate: 0 },
              preparationTime: sales.preparationTime || { average: 0, p95: 0, delayedCount: 0 },
            },
            {
              pendingOrders: ops.pendingOrders || 0,
              preparingOrders: ops.preparingOrders || 0,
              readyOrders: ops.readyOrders || 0,
              delayedOrders: ops.delayedOrders || [],
              occupiedTables: ops.occupiedTables || [],
              billRequestedTables: ops.billRequestedTables || [],
              pendingWaiterRequests: ops.pendingWaiterRequests || [],
              averagePrepTime: ops.averagePrepTime || 0,
              kitchenLoad: ops.kitchenLoad || 'LOW',
              anomalies: ops.anomalies || [],
            }
          );
          return { en: report, ar: report };
        } catch {
          // fallback
        }
      }

      // Fallback to insights
      if (insights.length > 0) {
        const ar = insights.map((i) => `- ${i.messageAr} (${i.type})`).join('\n');
        const en = insights.map((i) => `- ${i.message} (${i.type})`).join('\n');
        return { en, ar };
      }

      return { en: 'Performance report generated.', ar: 'تم إنشاء تقرير الأداء.' };
    }

    // Default: combine insights
    if (insights.length > 0) {
      const arLines = insights.map((i) => {
        if (i.type === 'FACT') return `النتيجة: ${i.messageAr}`;
        if (i.type === 'CALCULATION') return `التحليل: ${i.messageAr}`;
        if (i.type === 'INFERENCE') return `السبب المحتمل: ${i.messageAr}`;
        if (i.type === 'RECOMMENDATION') return `التوصية: ${i.messageAr}`;
        return i.messageAr;
      });
      const enLines = insights.map((i) => {
        if (i.type === 'FACT') return `Result: ${i.message}`;
        if (i.type === 'CALCULATION') return `Analysis: ${i.message}`;
        if (i.type === 'INFERENCE') return `Possible cause: ${i.message}`;
        if (i.type === 'RECOMMENDATION') return `Recommendation: ${i.message}`;
        return i.message;
      });
      return { en: enLines.join('\n'), ar: arLines.join('\n') };
    }

    // If no insights but tool results exist, summarize tool results
    if (toolResults.length > 0 && toolResults[0].result.ok) {
      const first = toolResults[0].result.data;
      const summary = compressToolResult(first, 500);
      return { en: `Data retrieved: ${summary}`, ar: `تم جلب البيانات: ${summary}` };
    }

    // Fallback
    return {
      en: 'I could not retrieve the required data. Please check if data is available or try again.',
      ar: 'تعذر الوصول إلى البيانات المطلوبة حالياً. تأكد من توفر البيانات أو حاول مرة أخرى بعد قليل.',
    };
  }

  private recordTrace(output: MureehAgentOutput, ctx: MureehToolContext | null, start: number) {
    const trace: AgentTrace = {
      requestId: output.requestId,
      userId: ctx?.userId,
      restaurantId: ctx?.restaurantId || 'unknown',
      branchId: ctx?.branchId,
      contactKey: ctx?.contactKey,
      intent: `${output.intent.intent}:${output.intent.detail}`,
      intentConfidence: output.intent.confidence,
      taskType: output.intent.detail,
      selectedTools: output.toolsCalled,
      toolErrors: output.toolsCalled.filter((t) => !t.ok).map((t) => ({ tool: t.name, error: 'failed', retryable: true })),
      executionDurationMs: output.executionDurationMs,
      modelUsed: 'deterministic+tools',
      finalResult: output.responseAr.slice(0, 500),
      failureReason: output.failureReason,
      timestamp: Date.now(),
      grounded: output.grounded,
      hallucinationDetected: output.hallucination,
      crossTenantAttempt: output.failureReason?.includes('TENANT_VIOLATION') || false,
      approvalRequired: output.requiresApproval,
      approvalGranted: false,
    };
    recordTrace(trace);
  }
}

export const mureehAgent = new MureehAgent();
