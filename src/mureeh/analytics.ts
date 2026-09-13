/**
 * Analytical Intelligence — derive useful insights, not just raw numbers.
 * Distinguish FACT vs CALCULATION vs INFERENCE vs RECOMMENDATION.
 * Proactive anomaly detection.
 */

import type { Order, Product, Table, WaiterRequest, SalesAnalytics, OperationalAnalytics, OperationalAnomaly } from './types.js';

export type FactType = 'FACT' | 'CALCULATION' | 'INFERENCE' | 'RECOMMENDATION';

export interface Insight {
  type: FactType;
  message: string;
  messageAr: string;
  data?: Record<string, unknown>;
  source?: string; // tool result id
}

export function analyzeSales(orders: Order[], products: Product[], timeframe: 'today' | 'week' | 'month' = 'today'): { insights: Insight[]; analytics: SalesAnalytics } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayOrders = orders.filter((o) => new Date(o.createdAt) >= startOfDay && o.status !== 'CANCELLED');

  const totalRevenue = todayOrders.reduce((sum, o) => sum + o.total, 0);
  const totalOrders = todayOrders.length;
  const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;

  // Orders by hour
  const byHour = new Map<number, number>();
  for (const o of todayOrders) {
    const hour = new Date(o.createdAt).getHours();
    byHour.set(hour, (byHour.get(hour) || 0) + 1);
  }
  const ordersByHour = Array.from(byHour.entries()).map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour);

  // Peak hours
  const peakHours = [...ordersByHour].sort((a, b) => b.count - a.count).slice(0, 3);

  // Top products
  const productCounts = new Map<string, { count: number; revenue: number; name: string }>();
  for (const o of todayOrders) {
    for (const item of o.items) {
      const key = item.productNameSnapshot;
      const existing = productCounts.get(key) || { count: 0, revenue: 0, name: key };
      existing.count += item.quantity;
      existing.revenue += item.totalPrice;
      productCounts.set(key, existing);
    }
  }
  const topProducts = Array.from(productCounts.entries())
    .map(([name, v]) => ({ productId: name, name: v.name, count: v.count, revenue: v.revenue }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const slowProducts = Array.from(productCounts.entries())
    .map(([name, v]) => ({ productId: name, name: v.name, count: v.count }))
    .sort((a, b) => a.count - b.count)
    .slice(0, 5)
    .filter((p) => p.count <= 2);

  // Cancellation rate
  const cancelled = orders.filter((o) => new Date(o.createdAt) >= startOfDay && o.status === 'CANCELLED').length;
  const cancellationRate = totalOrders + cancelled > 0 ? cancelled / (totalOrders + cancelled) : 0;

  // Prep time
  const prepTimes = todayOrders.filter((o) => o.estimatedPrepMinutes).map((o) => o.estimatedPrepMinutes!);
  const avgPrep = prepTimes.length ? prepTimes.reduce((a, b) => a + b, 0) / prepTimes.length : 0;
  const delayed = todayOrders.filter((o) => o.isDelayed).length;

  const analytics: SalesAnalytics = {
    totalOrders,
    totalRevenue,
    averageOrderValue: avgOrderValue,
    ordersByHour,
    ordersByDay: [{ date: startOfDay.toISOString().split('T')[0], count: totalOrders, revenue: totalRevenue }],
    topProducts,
    slowProducts,
    peakHours,
    cancellations: { count: cancelled, rate: cancellationRate },
    preparationTime: { average: avgPrep, p95: avgPrep * 1.5, delayedCount: delayed },
  };

  const insights: Insight[] = [];

  insights.push({
    type: 'FACT',
    message: `Today: ${totalOrders} orders, ${totalRevenue.toFixed(2)} revenue`,
    messageAr: `اليوم: ${totalOrders} طلباً، بإجمالي ${totalRevenue.toFixed(2)} ₪`,
    data: { totalOrders, totalRevenue },
    source: 'getOrders',
  });

  if (topProducts.length) {
    insights.push({
      type: 'CALCULATION',
      message: `Top product: ${topProducts[0].name} (${topProducts[0].count} sold)`,
      messageAr: `الأكثر مبيعاً: ${topProducts[0].name} (${topProducts[0].count} طلب)`,
      data: { topProduct: topProducts[0] },
    });
  }

  if (peakHours.length) {
    insights.push({
      type: 'CALCULATION',
      message: `Peak hours: ${peakHours.map((p) => `${p.hour}:00 (${p.count} orders)`).join(', ')}`,
      messageAr: `أكثر فترة ضغط: ${peakHours.map((p) => `${p.hour}:00 (${p.count} طلب)`).join('، ')}`,
      data: { peakHours },
    });
  }

  if (cancellationRate > 0.15) {
    insights.push({
      type: 'INFERENCE',
      message: `High cancellation rate: ${(cancellationRate * 100).toFixed(1)}%`,
      messageAr: `معدل إلغاء مرتفع: ${(cancellationRate * 100).toFixed(1)}%`,
      data: { cancellationRate },
    });
  }

  if (slowProducts.length) {
    insights.push({
      type: 'RECOMMENDATION',
      message: `Slow products: ${slowProducts.map((p) => p.name).join(', ')} — consider promotion or price review`,
      messageAr: `أصناف ضعيفة المبيعات: ${slowProducts.map((p) => p.name).join('، ')} — فكّر بعرض ترويجي أو مراجعة السعر`,
      data: { slowProducts },
    });
  }

  return { insights, analytics };
}

export function analyzeOperations(
  orders: Order[],
  tables: Table[],
  waiterRequests: WaiterRequest[]
): { insights: Insight[]; operational: OperationalAnalytics } {
  const pending = orders.filter((o) => o.status === 'PENDING').length;
  const preparing = orders.filter((o) => o.status === 'PREPARING').length;
  const ready = orders.filter((o) => o.status === 'READY').length;

  const occupied = tables.filter((t) => t.status === 'OCCUPIED');
  const billRequested = tables.filter((t) => t.status === 'BILL_REQUESTED');
  const pendingWaiters = waiterRequests.filter((w) => w.status === 'PENDING');

  const delayedOrders = orders.filter((o) => o.isDelayed || (o.elapsedMinutes && o.elapsedMinutes > 25));

  // Average prep time
  const prepTimes = orders.filter((o) => o.elapsedMinutes).map((o) => o.elapsedMinutes!);
  const avgPrep = prepTimes.length ? prepTimes.reduce((a, b) => a + b, 0) / prepTimes.length : 0;

  // Kitchen load
  let kitchenLoad: OperationalAnalytics['kitchenLoad'] = 'LOW';
  const activeKitchenOrders = pending + preparing;
  if (activeKitchenOrders > 15) kitchenLoad = 'OVERLOADED';
  else if (activeKitchenOrders > 8) kitchenLoad = 'HIGH';
  else if (activeKitchenOrders > 3) kitchenLoad = 'MEDIUM';

  // Anomaly detection
  const anomalies: OperationalAnomaly[] = [];

  if (delayedOrders.length > 0) {
    anomalies.push({
      type: 'SLOW_ORDERS',
      severity: delayedOrders.length > 3 ? 'HIGH' : 'MEDIUM',
      message: `${delayedOrders.length} orders delayed (avg prep ${avgPrep.toFixed(1)} min)`,
      messageAr: `${delayedOrders.length} طلب متأخر (متوسط التحضير ${avgPrep.toFixed(1)} دقيقة)`,
      data: { delayedCount: delayedOrders.length, avgPrep },
      hypothesis: 'High order volume or kitchen bottleneck',
      hypothesisAr: 'ارتفاع ضغط الطلبات أو اختناق في المطبخ',
    });
  }

  if (kitchenLoad === 'OVERLOADED' || kitchenLoad === 'HIGH') {
    anomalies.push({
      type: 'KITCHEN_OVERLOAD',
      severity: kitchenLoad === 'OVERLOADED' ? 'HIGH' : 'MEDIUM',
      message: `Kitchen overloaded: ${activeKitchenOrders} active orders`,
      messageAr: `المطبخ عليه ضغط: ${activeKitchenOrders} طلب نشط`,
      data: { activeOrders: activeKitchenOrders },
      hypothesis: 'Peak hour or staff shortage',
      hypothesisAr: 'فترة ذروة أو نقص في الطاقم',
    });
  }

  if (pendingWaiters.length > 5) {
    anomalies.push({
      type: 'HIGH_WAITER_REQUESTS',
      severity: pendingWaiters.length > 10 ? 'HIGH' : 'MEDIUM',
      message: `${pendingWaiters.length} pending waiter requests`,
      messageAr: `${pendingWaiters.length} طلب استدعاء نادل معلق`,
      data: { pendingWaiters: pendingWaiters.length },
      hypothesis: 'Staff busy or insufficient waiters',
      hypothesisAr: 'الطاقم مشغول أو عدد النوادل غير كافٍ',
    });
  }

  const operational: OperationalAnalytics = {
    pendingOrders: pending,
    preparingOrders: preparing,
    readyOrders: ready,
    delayedOrders,
    occupiedTables: occupied,
    billRequestedTables: billRequested,
    pendingWaiterRequests: pendingWaiters,
    averagePrepTime: avgPrep,
    kitchenLoad,
    anomalies,
  };

  const insights: Insight[] = [];

  insights.push({
    type: 'FACT',
    message: `Orders: ${pending} pending, ${preparing} preparing, ${ready} ready`,
    messageAr: `الطلبات: ${pending} قيد الانتظار، ${preparing} قيد التحضير، ${ready} جاهز`,
    data: { pending, preparing, ready },
  });

  insights.push({
    type: 'FACT',
    message: `Tables: ${occupied.length} occupied, ${billRequested.length} bill requested`,
    messageAr: `الطاولات: ${occupied.length} مشغولة، ${billRequested.length} طلبت الحساب`,
    data: { occupied: occupied.length, billRequested: billRequested.length },
  });

  for (const anomaly of anomalies) {
    insights.push({
      type: 'INFERENCE',
      message: anomaly.message,
      messageAr: anomaly.messageAr,
      data: anomaly.data,
    });
    if (anomaly.hypothesisAr) {
      insights.push({
        type: 'INFERENCE',
        message: `Possible cause: ${anomaly.hypothesis}`,
        messageAr: `السبب المحتمل: ${anomaly.hypothesisAr}`,
        data: { type: anomaly.type },
      });
    }
  }

  if (kitchenLoad === 'HIGH' || kitchenLoad === 'OVERLOADED') {
    insights.push({
      type: 'RECOMMENDATION',
      message: 'Consider prioritizing ready orders and adding kitchen staff',
      messageAr: 'يُنصح بإعطاء أولوية للطلبات الجاهزة وزيادة طاقم المطبخ مؤقتاً',
    });
  }

  return { insights, operational };
}

export function generateDailyReport(
  sales: SalesAnalytics,
  operational: OperationalAnalytics
): string {
  const lines: string[] = [];

  lines.push('## النتيجة');
  lines.push(`استقبل المطعم ${sales.totalOrders} طلباً اليوم بإجمالي ${sales.totalRevenue.toFixed(2)} ₪ ومتوسط ${sales.averageOrderValue.toFixed(2)} ₪ للطلب.`);

  if (sales.topProducts.length) {
    lines.push(`الأكثر مبيعاً: ${sales.topProducts[0].name} (${sales.topProducts[0].count} طلب).`);
  }

  lines.push('');
  lines.push('## التحليل');
  if (sales.peakHours.length) {
    lines.push(`أكثر فترة ضغط كانت بين ${sales.peakHours[0].hour}:00 و${sales.peakHours[0].hour + 1}:00 (${sales.peakHours[0].count} طلب).`);
  }
  lines.push(`حالة المطبخ: ${operational.kitchenLoad === 'LOW' ? 'هادئ' : operational.kitchenLoad === 'MEDIUM' ? 'متوسط' : operational.kitchenLoad === 'HIGH' ? 'مزدحم' : 'مضغوط جداً'}. متوسط وقت التحضير ${operational.averagePrepTime.toFixed(1)} دقيقة.`);
  if (operational.delayedOrders.length) {
    lines.push(`يوجد ${operational.delayedOrders.length} طلب متأخر.`);
  }

  if (operational.anomalies.length) {
    lines.push('');
    lines.push('### ملاحظات استباقية');
    for (const a of operational.anomalies) {
      lines.push(`- ${a.messageAr}${a.hypothesisAr ? ` — السبب المحتمل: ${a.hypothesisAr}` : ''}`);
    }
  }

  lines.push('');
  lines.push('## التوصية');
  if (sales.slowProducts.length) {
    lines.push(`الأصناف ضعيفة المبيعات: ${sales.slowProducts.map((p) => p.name).join('، ')} — اقترح عرضاً ترويجياً.`);
  }
  if (operational.pendingWaiterRequests.length > 3) {
    lines.push(`يوجد ${operational.pendingWaiterRequests.length} طلب استدعاء نادل معلق — راجع توزيع الطاقم.`);
  }
  if (!sales.slowProducts.length && operational.anomalies.length === 0) {
    lines.push('الأداء مستقر اليوم، حافظ على نفس الوتيرة وراقب فترة الذروة مساءً.');
  }

  return lines.join('\n');
}
