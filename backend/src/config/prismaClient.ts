import { Prisma, PrismaClient } from '@prisma/client';
import { tenantStore } from './tenantStore';
import { isTenantScopedModel } from './tenantScope';

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

function delegate(model: string) {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (basePrisma as unknown as Record<string, { findFirst: Function; updateMany: Function; deleteMany: Function }>)[key];
}

function recordNotFound(model: string): never {
  throw new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: '5.22.0',
    meta: { modelName: model },
  });
}

function injectCreateTenantId(args: { data?: unknown }, tenantId: string) {
  if (!args.data) return;
  if (Array.isArray(args.data)) {
    args.data.forEach((item: Record<string, unknown>) => {
      item.tenantId = tenantId;
    });
  } else {
    (args.data as Record<string, unknown>).tenantId = tenantId;
  }
}

// Tenant-aware Prisma client: always filters by tenantId on scoped models
export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!isTenantScopedModel(model)) {
          return query(args);
        }

        const context = tenantStore.getStore();
        const tenantId = context?.tenantId;

        // Explicit bypass (registration, super-admin cross-tenant audit)
        if (tenantId === 'bypass') {
          return query(args);
        }

        // Fail closed: never return cross-tenant data without context
        if (!tenantId) {
          throw new Error(
            `Tenant context missing for ${model}.${operation}. Ensure authenticate middleware ran.`
          );
        }

        const safeArgs = { ...args } as Record<string, unknown>;

        if (operation === 'create' || operation === 'createMany') {
          injectCreateTenantId(safeArgs as { data?: unknown }, tenantId);
          return query(safeArgs);
        }

        if (operation === 'findUnique') {
          const d = delegate(model);
          return d.findFirst({
            ...safeArgs,
            where: { ...(safeArgs.where as object), tenantId },
          });
        }

        const whereOps = ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'];
        if (whereOps.includes(operation)) {
          safeArgs.where = {
            ...((safeArgs.where as object) || {}),
            tenantId,
          };
          return query(safeArgs);
        }

        if (operation === 'update') {
          const d = delegate(model);
          const result = await d.updateMany({
            where: { ...(safeArgs.where as object), tenantId },
            data: safeArgs.data,
          });
          if (result.count === 0) recordNotFound(model);
          return d.findFirst({
            where: { ...(safeArgs.where as object), tenantId },
          });
        }

        if (operation === 'delete') {
          const d = delegate(model);
          const result = await d.deleteMany({
            where: { ...(safeArgs.where as object), tenantId },
          });
          if (result.count === 0) recordNotFound(model);
          return { count: result.count };
        }

        if (operation === 'upsert') {
          safeArgs.where = { ...(safeArgs.where as object), tenantId };
          if (safeArgs.create) {
            (safeArgs.create as Record<string, unknown>).tenantId = tenantId;
          }
          return query(safeArgs);
        }

        return query(safeArgs);
      },
    },
  },
});

export default prisma;
