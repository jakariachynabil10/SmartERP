import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

export const tenantStore = new AsyncLocalStorage<TenantContext>();
export const getTenantContext = () => tenantStore.getStore();
