/**
 * Proactive anomaly detection & alerting — monitors restaurant operations continuously.
 * Called by analytics.ts and can be scheduled via cron (future).
 */

import type { OperationalAnomaly } from './types.js';
import type { Insight } from './analytics.js';

export interface ProactiveAlert {
  id: string;
  restaurantId: string;
  type: OperationalAnomaly['type'];
  severity: OperationalAnomaly['severity'];
  message: string;
  messageAr: string;
  hypothesis?: string;
  hypothesisAr?: string;
  data: Record<string, unknown>;
  createdAt: number;
  acknowledged: boolean;
}

type OperationalAnalysis = {
  pendingOrders: number;
  preparingOrders: number;
  readyOrders: number;
  delayedOrders: any[];
  occupiedTables: any[];
  billRequestedTables: any[];
  pendingWaiterRequests: any[];
  averagePrepTime: number;
  kitchenLoad: 'LOW' | 'MEDIUM' | 'HIGH' | 'OVERLOADED';
  anomalies: OperationalAnomaly[];
};

const alertsStore = new Map<string, ProactiveAlert[]>(); // restaurantId -> alerts

export function detectProactiveAnomalies(
  restaurantId: string,
  operational: OperationalAnalysis,
  sales?: { totalRevenue: number; previousRevenue?: number; cancellations: { rate: number } }
): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  const now = Date.now();

  // 1. Kitchen overload
  if (operational.kitchenLoad === 'OVERLOADED' || operational.kitchenLoad === 'HIGH') {
    alerts.push({
      id: `alert-${now}-kitchen`,
      restaurantId,
      type: 'KITCHEN_OVERLOAD',
      severity: operational.kitchenLoad === 'OVERLOADED' ? 'HIGH' : 'MEDIUM',
      message: `Kitchen overloaded: ${operational.pendingOrders + operational.preparingOrders} orders pending/preparing`,
      messageAr: `المطبخ عليه ضغط: ${operational.pendingOrders + operational.preparingOrders} طلب معلق/قيد التحضير`,
      hypothesis: 'Peak hour surge or staff shortage',
      hypothesisAr: 'زيادة مفاجئة في الطلبات خلال ساعة الذروة أو نقص في طاقم المطبخ',
      data: { pending: operational.pendingOrders, preparing: operational.preparingOrders, load: operational.kitchenLoad },
      createdAt: now,
      acknowledged: false,
    });
  }

  // 2. Slow orders
  if (operational.delayedOrders.length > 0) {
    alerts.push({
      id: `alert-${now}-delayed`,
      restaurantId,
      type: 'SLOW_ORDERS',
      severity: operational.delayedOrders.length > 3 ? 'HIGH' : 'MEDIUM',
      message: `${operational.delayedOrders.length} delayed orders (prep > 25min)`,
      messageAr: `${operational.delayedOrders.length} طلب متأخر (وقت التحضير أكثر من 25 دقيقة)`,
      hypothesis: 'Kitchen bottleneck or complex orders',
      hypothesisAr: 'اختناق في المطبخ أو طلبات معقدة',
      data: { delayedCount: operational.delayedOrders.length, orders: operational.delayedOrders.map((o: any) => ({ id: o.id, elapsed: o.elapsedMinutes })) },
      createdAt: now,
      acknowledged: false,
    });
  }

  // 3. High waiter requests
  if (operational.pendingWaiterRequests.length > 3) {
    alerts.push({
      id: `alert-${now}-waiter`,
      restaurantId,
      type: 'HIGH_WAITER_REQUESTS',
      severity: operational.pendingWaiterRequests.length > 5 ? 'HIGH' : 'MEDIUM',
      message: `${operational.pendingWaiterRequests.length} pending waiter requests`,
      messageAr: `${operational.pendingWaiterRequests.length} طلب استدعاء نادل معلق`,
      data: { count: operational.pendingWaiterRequests.length },
      createdAt: now,
      acknowledged: false,
    });
  }

  // 4. Bill requested tables waiting long (future: need elapsed for tables)
  if (operational.billRequestedTables.length > 2) {
    alerts.push({
      id: `alert-${now}-bill`,
      restaurantId,
      type: 'HIGH_WAITER_REQUESTS', // reuse or new type
      severity: 'LOW',
      message: `${operational.billRequestedTables.length} tables waiting for bill`,
      messageAr: `${operational.billRequestedTables.length} طاولة بانتظار الحساب`,
      data: { tables: operational.billRequestedTables.map((t: any) => t.number) },
      createdAt: now,
      acknowledged: false,
    });
  }

  // 5. Sales drop (if sales data available)
  if (sales && sales.previousRevenue && sales.totalRevenue < sales.previousRevenue * 0.7) {
    const dropPct = Math.round((1 - sales.totalRevenue / sales.previousRevenue) * 100);
    alerts.push({
      id: `alert-${now}-sales-drop`,
      restaurantId,
      type: 'SALES_DROP',
      severity: dropPct > 50 ? 'HIGH' : 'MEDIUM',
      message: `Sales dropped ${dropPct}% vs previous period`,
      messageAr: `انخفاض المبيعات بنسبة ${dropPct}% مقارنة بالفترة السابقة`,
      hypothesis: 'Low traffic, menu issue, or external factor',
      hypothesisAr: 'انخفاض حركة الزبائن أو مشكلة في المنيو أو عامل خارجي',
      data: { current: sales.totalRevenue, previous: sales.previousRevenue, dropPct },
      createdAt: now,
      acknowledged: false,
    });
  }

  // 6. High cancellation
  if (sales && sales.cancellations.rate > 0.1) {
    alerts.push({
      id: `alert-${now}-cancel`,
      restaurantId,
      type: 'HIGH_CANCELLATION',
      severity: sales.cancellations.rate > 0.2 ? 'HIGH' : 'MEDIUM',
      message: `High cancellation rate: ${(sales.cancellations.rate * 100).toFixed(1)}%`,
      messageAr: `معدل إلغاء مرتفع: ${(sales.cancellations.rate * 100).toFixed(1)}%`,
      data: { rate: sales.cancellations.rate },
      createdAt: now,
      acknowledged: false,
    });
  }

  // Store
  if (alerts.length > 0) {
    const existing = alertsStore.get(restaurantId) || [];
    alertsStore.set(restaurantId, [...existing, ...alerts].slice(-50)); // keep last 50
  }

  return alerts;
}

export function getActiveAlerts(restaurantId: string): ProactiveAlert[] {
  return (alertsStore.get(restaurantId) || []).filter((a) => !a.acknowledged);
}

export function acknowledgeAlert(restaurantId: string, alertId: string): boolean {
  const list = alertsStore.get(restaurantId);
  if (!list) return false;
  const alert = list.find((a) => a.id === alertId);
  if (!alert) return false;
  alert.acknowledged = true;
  return true;
}

export function formatAlertsForMessage(alerts: ProactiveAlert[], language: 'ar' | 'en' = 'ar'): string {
  if (alerts.length === 0) return language === 'ar' ? 'لا توجد تنبيهات نشطة حالياً.' : 'No active alerts.';

  const lines = alerts.map((a) => {
    const icon = a.severity === 'HIGH' ? '🔴' : a.severity === 'MEDIUM' ? '🟡' : '🟢';
    return `${icon} ${a.messageAr} — ${a.hypothesisAr || ''}`.trim();
  });

  return language === 'ar'
    ? `تنبيهات استباقية (${alerts.length}):\n${lines.join('\n')}`
    : `Proactive alerts (${alerts.length}):\n${alerts.map((a) => `${a.severity} ${a.message}`).join('\n')}`;
}
