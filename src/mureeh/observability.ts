/**
 * Observability — every agent execution traceable.
 * Never log passwords, JWTs, API keys, secrets, PII.
 */

import { log } from '../lib/utils.js';
import { validateNoSecretsInLog } from './security.js';

export interface AgentTrace {
  requestId: string;
  userId?: string;
  restaurantId: string;
  branchId?: string | null;
  contactKey?: string;
  intent?: string;
  intentConfidence?: string;
  taskType?: string;
  selectedTools: { name: string; args: Record<string, unknown>; latencyMs?: number; ok?: boolean; error?: string }[];
  toolErrors: { tool: string; error: string; retryable: boolean }[];
  executionDurationMs: number;
  modelUsed?: string;
  tokenUsage?: { promptTokens: number; completionTokens: number; total: number };
  finalResult?: string;
  failureReason?: string;
  timestamp: number;
  // quality
  grounded: boolean;
  hallucinationDetected: boolean;
  crossTenantAttempt: boolean;
  approvalRequired?: boolean;
  approvalGranted?: boolean;
}

const traces: AgentTrace[] = [];
const MAX_TRACES = 500;

export function recordTrace(trace: AgentTrace): void {
  // Sanitize before storing
  const sanitized = {
    ...trace,
    selectedTools: trace.selectedTools.map((t) => ({
      ...t,
      args: validateNoSecretsInLog(t.args) as Record<string, unknown>,
    })),
  } as AgentTrace;

  traces.push(sanitized);
  if (traces.length > MAX_TRACES) {
    traces.shift();
  }

  // Log summary (not full trace)
  log.info(
    `🔍 TRACE ${trace.requestId} | restaurant=${trace.restaurantId} | intent=${trace.intent || '?'} | tools=${trace.selectedTools.length} | duration=${trace.executionDurationMs}ms | grounded=${trace.grounded}`
  );

  if (trace.failureReason) {
    log.warn(`⚠️ TRACE FAILED ${trace.requestId}: ${trace.failureReason}`);
  }
  if (trace.crossTenantAttempt) {
    log.error(`🚨 CROSS-TENANT ATTEMPT ${trace.requestId} restaurant=${trace.restaurantId} user=${trace.userId}`);
  }
}

export function getRecentTraces(limit = 50): AgentTrace[] {
  return traces.slice(-limit).reverse();
}

export function getTrace(requestId: string): AgentTrace | undefined {
  return traces.find((t) => t.requestId === requestId);
}

export interface QualityMetrics {
  totalExecutions: number;
  groundedRate: number;
  hallucinationRate: number;
  avgLatencyMs: number;
  toolSuccessRate: number;
  authViolationRate: number;
  crossTenantLeakageRate: number;
  taskCompletionRate: number;
}

export function computeQualityMetrics(): QualityMetrics {
  if (traces.length === 0) {
    return {
      totalExecutions: 0,
      groundedRate: 0,
      hallucinationRate: 0,
      avgLatencyMs: 0,
      toolSuccessRate: 0,
      authViolationRate: 0,
      crossTenantLeakageRate: 0,
      taskCompletionRate: 0,
    };
  }

  const grounded = traces.filter((t) => t.grounded).length;
  const hallucinations = traces.filter((t) => t.hallucinationDetected).length;
  const totalLatency = traces.reduce((sum, t) => sum + t.executionDurationMs, 0);
  const toolCalls = traces.flatMap((t) => t.selectedTools);
  const toolSuccess = toolCalls.filter((t) => t.ok !== false).length;
  const authViolations = traces.filter((t) => t.failureReason?.includes('not allowed') || t.failureReason?.includes('Role')).length;
  const crossTenant = traces.filter((t) => t.crossTenantAttempt).length;
  const completed = traces.filter((t) => !t.failureReason).length;

  return {
    totalExecutions: traces.length,
    groundedRate: grounded / traces.length,
    hallucinationRate: hallucinations / traces.length,
    avgLatencyMs: totalLatency / traces.length,
    toolSuccessRate: toolCalls.length ? toolSuccess / toolCalls.length : 1,
    authViolationRate: authViolations / traces.length,
    crossTenantLeakageRate: crossTenant / traces.length,
    taskCompletionRate: completed / traces.length,
  };
}

// For dashboard
export function observabilitySnapshot() {
  return {
    recentTraces: getRecentTraces(20),
    metrics: computeQualityMetrics(),
  };
}
