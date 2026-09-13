/**
 * Human approval for destructive / business-sensitive operations.
 */

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalRequest {
  id: string;
  requestId: string;
  restaurantId: string;
  userId?: string;
  contactKey: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  descriptionAr: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
}

const approvals = new Map<string, ApprovalRequest>();

export function requiresApproval(toolName: string): boolean {
  const destructiveTools = [
    'deleteProduct',
    'deleteCategory',
    'deleteOffer',
    'updateRestaurantSettings',
    'createProduct',
    'updateProduct',
    'createCategory',
    'updateCategory',
    'createOffer',
    'updateOffer',
    'createBranch',
    'updateBranch',
    'updateOrderStatus', // cancelling is sensitive
  ];
  return destructiveTools.includes(toolName);
}

export function isDestructiveArgs(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'updateOrderStatus' && args.status === 'CANCELLED') return true;
  if (toolName.startsWith('delete')) return true;
  if (toolName === 'updateProduct' && ('price' in args || 'available' in args)) {
    // Price change or availability change is sensitive
    return true;
  }
  if (toolName === 'updateRestaurantSettings') return true;
  return requiresApproval(toolName);
}

export function createApprovalRequest(
  requestId: string,
  restaurantId: string,
  contactKey: string,
  tool: string,
  args: Record<string, unknown>,
  userId?: string
): ApprovalRequest {
  const id = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isDestructive = isDestructiveArgs(tool, args);

  const descriptions: Record<string, { en: string; ar: string }> = {
    deleteProduct: { en: `Delete product ${args.productId}`, ar: `حذف المنتج ${args.productId}` },
    deleteCategory: { en: `Delete category ${args.categoryId}`, ar: `حذف التصنيف ${args.categoryId}` },
    deleteOffer: { en: `Delete offer ${args.offerId}`, ar: `حذف العرض ${args.offerId}` },
    updateProduct: { en: `Update product ${args.productId}`, ar: `تعديل المنتج ${args.productId}` },
    createProduct: { en: `Create product ${args.name}`, ar: `إنشاء منتج ${args.name}` },
    updateOrderStatus: {
      en: `Update order ${args.orderId} to ${args.status}`,
      ar: `تحديث حالة الطلب ${args.orderId} إلى ${args.status}`,
    },
    updateRestaurantSettings: { en: 'Update restaurant settings', ar: 'تعديل إعدادات المطعم' },
  };

  const desc = descriptions[tool] || { en: `${tool} with ${JSON.stringify(args).slice(0, 100)}`, ar: `${tool}` };

  const req: ApprovalRequest = {
    id,
    requestId,
    restaurantId,
    userId,
    contactKey,
    tool,
    args,
    description: desc.en,
    descriptionAr: desc.ar,
    severity: isDestructive ? 'HIGH' : 'MEDIUM',
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    status: 'PENDING',
  };

  approvals.set(id, req);
  return req;
}

export function getApproval(id: string): ApprovalRequest | undefined {
  return approvals.get(id);
}

export function approve(id: string): ApprovalRequest | null {
  const req = approvals.get(id);
  if (!req) return null;
  if (Date.now() > req.expiresAt) {
    req.status = 'EXPIRED';
    return req;
  }
  req.status = 'APPROVED';
  return req;
}

export function reject(id: string): ApprovalRequest | null {
  const req = approvals.get(id);
  if (!req) return null;
  req.status = 'REJECTED';
  return req;
}

export function isApprovalValid(id: string): boolean {
  const req = approvals.get(id);
  if (!req) return false;
  if (req.status !== 'APPROVED') return false;
  if (Date.now() > req.expiresAt) return false;
  return true;
}

export function formatApprovalRequestAr(req: ApprovalRequest): string {
  return [
    `⚠️ عملية حساسة تتطلب تأكيداً:`,
    `${req.descriptionAr}`,
    `التفاصيل: ${JSON.stringify(req.args, null, 2).slice(0, 500)}`,
    `هل تريد المتابعة؟ رد بـ "نعم" للتأكيد أو "لا" للإلغاء.`,
    `(ينتهي خلال 5 دقائق)`,
  ].join('\n');
}

export function checkExplicitApproval(userMessage: string): 'APPROVED' | 'REJECTED' | 'UNCLEAR' {
  const lower = userMessage.trim().toLowerCase();
  const approved = ['نعم', 'نعم متابعة', 'موافق', 'تأكيد', 'confirm', 'yes', 'approve', 'موافقة', 'اي نعم', 'أكيد', 'ok', 'okay'];
  const rejected = ['لا', 'لا لا', 'الغاء', 'إلغاء', 'cancel', 'no', 'reject', 'لا أريد', 'لا اريد'];

  if (approved.some((w) => lower === w || lower.includes(w))) {
    // Ensure not "لا نعم" etc
    if (lower.startsWith('لا') && lower.includes('نعم')) return 'UNCLEAR';
    return 'APPROVED';
  }
  if (rejected.some((w) => lower === w || lower.includes(w))) {
    return 'REJECTED';
  }
  return 'UNCLEAR';
}
