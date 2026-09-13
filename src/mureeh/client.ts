import { config } from '../config.js';
import { log } from '../lib/utils.js';
import type { MureehToolContext } from './types.js';

export interface MureehClientOptions {
  baseUrl?: string;
  serviceToken?: string;
  timeoutMs?: number;
  retries?: number;
  demoMode?: boolean;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  context?: MureehToolContext;
  timeoutMs?: number;
}

export class MureehClient {
  private baseUrl: string;
  private serviceToken: string;
  private timeoutMs: number;
  private retries: number;
  private demoMode: boolean;

  constructor(opts: MureehClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || config.mureeh.API_URL || '').replace(/\/+$/, '').replace(/\/api$/, '');
    this.serviceToken = opts.serviceToken || config.mureeh.SERVICE_TOKEN || '';
    this.timeoutMs = opts.timeoutMs || config.mureeh.TIMEOUT_MS;
    this.retries = opts.retries ?? config.mureeh.RETRIES;
    this.demoMode = opts.demoMode ?? config.mureeh.DEMO_MODE;
    if (!this.baseUrl) {
      // In demo mode, baseUrl can be empty; client will return demo data
      log.warn('MUREEH_API_URL not set — client in demo mode');
      this.demoMode = true;
    }
  }

  isDemo(): boolean {
    return this.demoMode || !this.baseUrl;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const normalizedPath = path.startsWith('/api/') ? path : path.startsWith('/') ? `/api${path}` : `/api/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private authHeader(context?: MureehToolContext): Record<string, string> {
    if (context?.authToken) {
      return { Authorization: `Bearer ${context.authToken}` };
    }
    if (this.serviceToken) {
      return { Authorization: `Bearer ${this.serviceToken}` };
    }
    return {};
  }

  async request<T>(opts: RequestOptions): Promise<{ ok: boolean; data?: T; error?: string; status?: number }> {
    if (this.isDemo()) {
      return { ok: false, error: 'DEMO_MODE: Mureeh API not configured', status: 0 };
    }

    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': opts.context?.requestId || `req-${Date.now()}`,
      ...this.authHeader(opts.context),
    };
    if (opts.context?.restaurantId) {
      headers['X-Restaurant-Id'] = opts.context.restaurantId;
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method: opts.method,
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const text = await res.text();
        let json: any;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }

        if (!res.ok) {
          const msg = json?.error || json?.message || `HTTP ${res.status}`;
          // Don't retry on 4xx (client errors) except 429
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            return { ok: false, error: msg, status: res.status };
          }
          if (attempt < this.retries) {
            await sleep(300 * (attempt + 1));
            continue;
          }
          return { ok: false, error: msg, status: res.status };
        }

        // Mureeh API wraps in { success: true, data: ... }
        if (json && typeof json === 'object' && 'success' in json) {
          if (json.success === false) {
            return { ok: false, error: json.error || 'API returned success=false', status: res.status };
          }
          return { ok: true, data: (json.data ?? json) as T, status: res.status };
        }
        return { ok: true, data: json as T, status: res.status };
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError';
        const message = isAbort ? `Timeout after ${timeoutMs}ms` : err?.message || String(err);
        if (attempt < this.retries) {
          log.warn(`Mureeh API ${opts.method} ${opts.path} attempt ${attempt + 1} failed: ${message} — retrying`);
          await sleep(400 * (attempt + 1));
          continue;
        }
        return { ok: false, error: message, status: 0 };
      }
    }
    return { ok: false, error: 'Max retries exceeded', status: 0 };
  }

  // Convenience methods for manager endpoints
  async getDashboardStats(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/dashboard/stats`,
      query: { restaurantId },
      context,
    });
  }

  async getCategories(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/menu/categories`,
      query: { restaurantId },
      context,
    });
  }

  async getProducts(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/menu/products`,
      query: { restaurantId },
      context,
    });
  }

  async getOrders(restaurantId: string, context?: MureehToolContext, filters?: { status?: string; from?: string; to?: string; limit?: number }) {
    return this.request({
      method: 'GET',
      path: `/manager/orders`,
      query: { restaurantId, ...filters },
      context,
    });
  }

  async getTables(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/tables`,
      query: { restaurantId },
      context,
    });
  }

  async getWaiterRequests(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/waiter-requests`,
      query: { restaurantId },
      context,
    });
  }

  async getOffers(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/offers`,
      query: { restaurantId },
      context,
    });
  }

  async getBranches(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/branches`,
      query: { restaurantId },
      context,
    });
  }

  async getPayments(restaurantId: string, context?: MureehToolContext, filters?: { from?: string; to?: string; limit?: number }) {
    return this.request({
      method: 'GET',
      path: `/manager/payments`,
      query: { restaurantId, ...filters },
      context,
    });
  }

  async updateOrderStatus(orderId: string, status: string, restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'PUT',
      path: `/manager/orders/${encodeURIComponent(orderId)}/status`,
      body: { status, restaurantId },
      context,
    });
  }

  async getRestaurant(restaurantId: string, context?: MureehToolContext) {
    return this.request({
      method: 'GET',
      path: `/manager/restaurant`,
      query: { restaurantId },
      context,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Singleton client
let clientInstance: MureehClient | null = null;

export function getMureehClient(): MureehClient {
  if (!clientInstance) {
    clientInstance = new MureehClient();
  }
  return clientInstance;
}

// For testing / custom config
export function createMureehClient(opts: MureehClientOptions): MureehClient {
  return new MureehClient(opts);
}
