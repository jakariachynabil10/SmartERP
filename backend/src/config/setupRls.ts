import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient();

export async function setupRowLevelSecurity() {
  logger.info('Starting Row-Level Security (RLS) setup...');
  try {
    const sql = `
      DO $$
      DECLARE
          r RECORD;
      BEGIN
          FOR r IN 
              SELECT table_name 
              FROM information_schema.columns 
              WHERE column_name = 'tenantId' 
                AND table_schema = 'public'
          LOOP
              -- Enable Row-Level Security
              EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', r.table_name);
              
              -- Drop policy if it already exists
              EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', r.table_name);
              
              -- Create policy restricting queries to match the app.current_tenant_id session variable OR bypass
              EXECUTE format('
                CREATE POLICY tenant_isolation_policy ON %I 
                USING (
                  "tenantId" = current_setting(''app.current_tenant_id'', true) 
                  OR current_setting(''app.current_tenant_id'', true) = ''bypass''
                );
              ', r.table_name);
              
              RAISE NOTICE 'Enabled RLS and created policy on table %', r.table_name;
          END LOOP;
      END;
      $$;
    `;
    await prisma.$executeRawUnsafe(sql);
    logger.info('Row-Level Security (RLS) successfully configured on all tenant-scoped tables.');
  } catch (error) {
    logger.error({ error }, 'Error configuring Row-Level Security:');
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}
