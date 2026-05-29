import { tenantStore, TenantContext } from './tenantStore';

/** Models that include a tenantId column and must be isolated per tenant */
export const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Category',
  'Warehouse',
  'Product',
  'Supplier',
  'Customer',
  'Sale',
  'SaleItem',
  'ReturnTransaction',
  'ReturnItem',
  'PurchaseOrder',
  'PurchaseOrderItem',
  'Employee',
  'Attendance',
  'LeaveRequest',
  'AuditLog',
  'StockAdjustment',
  'StockTransfer',
]);

export function isTenantScopedModel(model: string | undefined): boolean {
  return !!model && TENANT_SCOPED_MODELS.has(model);
}

export function getTenantContext(): TenantContext | undefined {
  return tenantStore.getStore();
}

export function getRequiredTenantId(): string {
  const ctx = getTenantContext();
  if (!ctx?.tenantId || ctx.tenantId === 'bypass') {
    throw new Error('Tenant context is required for this operation.');
  }
  return ctx.tenantId;
}

export function isBypassContext(): boolean {
  return getTenantContext()?.tenantId === 'bypass';
}

export function mergeTenantWhere<T extends Record<string, unknown>>(
  where: T | undefined,
  tenantId: string
): T & { tenantId: string } {
  return { ...(where || ({} as T)), tenantId };
}

export function runWithBypass<T>(fn: () => T): T {
  const current = getTenantContext();
  return tenantStore.run(
    {
      tenantId: 'bypass',
      userId: current?.userId ?? '',
      role: current?.role ?? 'SUPER_ADMIN',
    },
    fn
  );
}
