import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRestaurantIntent } from '../../src/agent/intelligence/restaurantIntent.js';

describe('Restaurant Intent Classification', () => {
  it('شو أكثر وجبة انطلبت اليوم؟ → best_selling', () => {
    const r = classifyRestaurantIntent('شو أكثر وجبة انطلبت اليوم؟');
    assert.equal(r.detail, 'best_selling');
    assert.equal(r.intent, 'ANALYTICS');
    assert.equal(r.entities.timeframe, 'today');
  });

  it('كم طلب عندنا الآن؟ → pending_orders', () => {
    const r = classifyRestaurantIntent('كم طلب عندنا الآن؟');
    assert.equal(r.detail, 'pending_orders');
    assert.equal(r.intent, 'OPERATIONS');
  });

  it('أي طاولة طلبت الحساب؟ → bill_requested', () => {
    const r = classifyRestaurantIntent('أي طاولة طلبت الحساب؟');
    assert.equal(r.detail, 'bill_requested');
    assert.equal(r.intent, 'OPERATIONS');
  });

  it('شو أكثر صنف مبيعاً هذا الأسبوع؟ → best_selling week', () => {
    const r = classifyRestaurantIntent('شو أكثر صنف مبيعاً هذا الأسبوع؟');
    assert.equal(r.detail, 'best_selling');
    assert.equal(r.entities.timeframe, 'week');
  });

  it('هل في طلبات متأخرة؟ → delayed_orders', () => {
    const r = classifyRestaurantIntent('هل في طلبات متأخرة؟');
    assert.equal(r.detail, 'delayed_orders');
  });

  it('ليش المطبخ عليه ضغط؟ → operational_improvement', () => {
    const r = classifyRestaurantIntent('ليش المطبخ عليه ضغط؟');
    assert.equal(r.detail, 'operational_improvement');
  });

  it('اقترحلي عرض لليوم → suggest_offer', () => {
    const r = classifyRestaurantIntent('اقترحلي عرض لليوم.');
    assert.equal(r.detail, 'suggest_offer');
    assert.equal(r.intent, 'RECOMMENDATIONS');
  });

  it('اعرضلي الأصناف اللي مبيعاتها ضعيفة → slow_products', () => {
    const r = classifyRestaurantIntent('اعرضلي الأصناف اللي مبيعاتها ضعيفة.');
    assert.equal(r.detail, 'slow_products');
  });

  it('ما هي المنتجات التي تحتاج تعديل سعر؟ → slow_products', () => {
    const r = classifyRestaurantIntent('ما هي المنتجات التي تحتاج تعديل سعر؟');
    assert.equal(r.detail, 'slow_products');
  });

  it('اعمللي ملخص أداء المطعم اليوم → performance', () => {
    const r = classifyRestaurantIntent('اعمللي ملخص أداء المطعم اليوم.');
    assert.equal(r.detail, 'performance');
  });

  it('شو أكثر صنف؟ → requires clarification', () => {
    const r = classifyRestaurantIntent('شو أكثر صنف؟');
    assert.equal(r.requiresClarification, true);
    assert.ok(r.clarificationQuestionAr?.includes('اليوم'));
  });

  it('table number extraction', () => {
    const r = classifyRestaurantIntent('شو وضع طاولة رقم 5؟');
    assert.equal(r.entities.tableNumber, 5);
  });
});
