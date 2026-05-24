import { PrismaClient } from '@prisma/client';
import { tenantStore } from './tenantStore';

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Create the tenant-aware extended client
export const prisma = basePrisma.$extends({
  query: {
    $allOperations({ model: _model, operation, args, query }) {
      const context = tenantStore.getStore();

      // If we have a tenant ID in the request scope, run inside a transaction
      // and set the local connection parameter for Postgres RLS.
      if (context && context.tenantId) {
        // Enforce tenantId in the args for writes/creates just as a secondary guard
        if (_model && _model !== 'Tenant' && _model !== 'ProductWarehouse' && context.tenantId !== 'bypass') {
          if (args && (operation === 'create' || operation === 'createMany')) {
            if (args.data) {
              if (Array.isArray(args.data)) {
                args.data.forEach((item: any) => {
                  item.tenantId = context.tenantId;
                });
              } else {
                args.data.tenantId = context.tenantId;
              }
            }
          }
        }

        // We run SET LOCAL and the actual query in a single transaction
        return basePrisma.$transaction([
          basePrisma.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${context.tenantId}';`),
          query(args) as any
        ]).then(results => results[1]);
      }

      return query(args);
    },
  },
});

export default prisma;
