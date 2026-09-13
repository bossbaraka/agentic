/**
 * Planning module — creates structured execution plans for complex restaurant intelligence tasks.
 * Used by mureehAgent for multi-step reasoning.
 */

import type { RestaurantIntentResult } from '../agent/intelligence/restaurantIntent.js';

export interface PlanStep {
  id: string;
  description: string;
  descriptionAr: string;
  tool?: string;
  dependsOn?: string[];
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
  result?: unknown;
}

export interface ExecutionPlan {
  goal: string;
  goalAr: string;
  intent: RestaurantIntentResult;
  steps: PlanStep[];
  createdAt: number;
}

export function createPlan(intent: RestaurantIntentResult, message: string): ExecutionPlan {
  const goal = `${intent.intent}:${intent.detail} — ${message.slice(0, 120)}`;
  const goalAr = `${intent.detail} — ${message.slice(0, 120)}`;

  if (intent.detail === 'performance') {
    return {
      goal,
      goalAr,
      intent,
      createdAt: Date.now(),
      steps: [
        { id: 's1', description: 'Retrieve today orders', descriptionAr: 'جلب طلبات اليوم', tool: 'getOrders', status: 'PENDING' },
        { id: 's2', description: 'Retrieve sales metrics', descriptionAr: 'جلب مؤشرات المبيعات', tool: 'getSalesAnalytics', dependsOn: [], status: 'PENDING' },
        { id: 's3', description: 'Retrieve product performance', descriptionAr: 'جلب أداء المنتجات', tool: 'getProducts', status: 'PENDING' },
        { id: 's4', description: 'Retrieve operational metrics', descriptionAr: 'جلب المؤشرات التشغيلية', tool: 'getOperationalAnalytics', status: 'PENDING' },
        { id: 's5', description: 'Compare against historical baseline', descriptionAr: 'المقارنة مع الأساس التاريخي', status: 'PENDING', dependsOn: ['s1', 's2'] },
        { id: 's6', description: 'Detect anomalies', descriptionAr: 'كشف الحالات الشاذة', status: 'PENDING', dependsOn: ['s4'] },
        { id: 's7', description: 'Generate insights (FACT/CALCULATION/INFERENCE)', descriptionAr: 'توليد الرؤى', status: 'PENDING', dependsOn: ['s5', 's6'] },
        { id: 's8', description: 'Produce recommendations', descriptionAr: 'إنتاج التوصيات', status: 'PENDING', dependsOn: ['s7'] },
      ],
    };
  }

  if (intent.detail === 'best_selling') {
    return {
      goal,
      goalAr,
      intent,
      createdAt: Date.now(),
      steps: [
        { id: 's1', description: 'Retrieve sales analytics', descriptionAr: 'جلب تحليلات المبيعات', tool: 'getSalesAnalytics', status: 'PENDING' },
        { id: 's2', description: 'Retrieve restaurant stats for popular products', descriptionAr: 'جلب المنتجات الأكثر شعبية', tool: 'getRestaurantStats', status: 'PENDING' },
        { id: 's3', description: 'Calculate top product', descriptionAr: 'حساب المنتج الأكثر مبيعاً', status: 'PENDING', dependsOn: ['s1', 's2'] },
        { id: 's4', description: 'Generate grounded response', descriptionAr: 'إنتاج رد موثوق', status: 'PENDING', dependsOn: ['s3'] },
      ],
    };
  }

  if (intent.detail === 'slow_products') {
    return {
      goal,
      goalAr,
      intent,
      createdAt: Date.now(),
      steps: [
        { id: 's1', description: 'Retrieve sales analytics week', descriptionAr: 'جلب مبيعات الأسبوع', tool: 'getSalesAnalytics', status: 'PENDING' },
        { id: 's2', description: 'Analyze slow products', descriptionAr: 'تحليل المنتجات ضعيفة المبيعات', status: 'PENDING', dependsOn: ['s1'] },
        { id: 's3', description: 'Generate recommendations', descriptionAr: 'توليد توصيات', status: 'PENDING', dependsOn: ['s2'] },
      ],
    };
  }

  if (intent.detail === 'delayed_orders' || intent.detail === 'pending_orders') {
    return {
      goal,
      goalAr,
      intent,
      createdAt: Date.now(),
      steps: [
        { id: 's1', description: 'Retrieve operational analytics', descriptionAr: 'جلب التحليلات التشغيلية', tool: 'getOperationalAnalytics', status: 'PENDING' },
        { id: 's2', description: 'Retrieve relevant orders', descriptionAr: 'جلب الطلبات ذات الصلة', tool: 'getOrders', status: 'PENDING' },
        { id: 's3', description: 'Analyze and respond', descriptionAr: 'التحليل والرد', status: 'PENDING', dependsOn: ['s1', 's2'] },
      ],
    };
  }

  // Default single step
  return {
    goal,
    goalAr,
    intent,
    createdAt: Date.now(),
    steps: [
      { id: 's1', description: `Execute ${intent.detail}`, descriptionAr: `تنفيذ ${intent.detail}`, status: 'PENDING' },
    ],
  };
}

export function getExecutableSteps(plan: ExecutionPlan): PlanStep[] {
  return plan.steps.filter((s) => {
    if (s.status !== 'PENDING') return false;
    if (!s.dependsOn || s.dependsOn.length === 0) return true;
    return s.dependsOn.every((depId) => plan.steps.find((x) => x.id === depId)?.status === 'DONE');
  });
}

export function markStepDone(plan: ExecutionPlan, stepId: string, result?: unknown): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = 'DONE';
    step.result = result;
  }
}

export function markStepFailed(plan: ExecutionPlan, stepId: string, reason?: string): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = 'FAILED';
    step.result = reason;
  }
}

export function isPlanComplete(plan: ExecutionPlan): boolean {
  return plan.steps.every((s) => s.status === 'DONE' || s.status === 'SKIPPED' || s.status === 'FAILED');
}
