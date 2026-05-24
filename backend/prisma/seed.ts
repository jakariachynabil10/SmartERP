import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SUPER_ADMIN_EMAIL =
  process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@smarterp.local';
const SUPER_ADMIN_PASSWORD =
  process.env.SUPER_ADMIN_PASSWORD ?? 'SuperAdmin@123';
const PLATFORM_SUBDOMAIN = 'platform';
const PLATFORM_NAME = 'SmartERP Platform';

async function withBypass<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = 'bypass';`);
    return fn(tx as unknown as PrismaClient);
  });
}

async function main() {
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);

  await withBypass(async (tx) => {
    let tenant = await tx.tenant.findUnique({
      where: { subDomain: PLATFORM_SUBDOMAIN },
    });

    if (!tenant) {
      tenant = await tx.tenant.create({
        data: {
          name: PLATFORM_NAME,
          subDomain: PLATFORM_SUBDOMAIN,
          plan: 'ENTERPRISE',
        },
      });

      await tx.warehouse.create({
        data: {
          name: 'Platform Warehouse',
          location: 'System',
          tenantId: tenant.id,
        },
      });

      await tx.customer.create({
        data: {
          name: 'Walk-in Customer',
          phone: '0000000000',
          tenantId: tenant.id,
        },
      });

      console.log(`Created platform tenant: ${tenant.id}`);
    }

    const existing = await tx.user.findUnique({
      where: { email: SUPER_ADMIN_EMAIL },
    });

    if (existing) {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          role: Role.SUPER_ADMIN,
          passwordHash,
          isVerified: true,
          tenantId: tenant.id,
        },
      });
      console.log(`Updated existing user to SUPER_ADMIN: ${SUPER_ADMIN_EMAIL}`);
    } else {
      await tx.user.create({
        data: {
          email: SUPER_ADMIN_EMAIL,
          passwordHash,
          role: Role.SUPER_ADMIN,
          firstName: 'Super',
          lastName: 'Admin',
          isVerified: true,
          tenantId: tenant.id,
        },
      });
      console.log(`Created SUPER_ADMIN: ${SUPER_ADMIN_EMAIL}`);
    }
  });

  console.log('SUPER_ADMIN seed completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
