import request from 'supertest';
import app from '../app';
import { prisma } from '../config/prismaClient';
import { generateAccessToken } from '../utils/jwt';
import { Role } from '@prisma/client';
import { tenantStore } from '../config/tenantStore';

describe('Live Analytics API & Reporting Tests', () => {
  let tenant1Id: string;
  let tenant2Id: string;

  let manager1Id: string;
  let staff1Id: string;

  let managerToken: string;
  let staffToken: string;

  let productAId: string; // cost = $10, selling = $25
  let productBId: string; // cost = $20, selling = $50

  beforeAll(async () => {
    // Run setup within 'bypass' context to insert seed data
    await new Promise<void>((resolve, reject) => {
      tenantStore.run(
        { tenantId: 'bypass', userId: 'analytics-test-setup', role: 'SUPER_ADMIN' },
        async () => {
          try {
            // Clean up old analytics test data
            await prisma.returnItem.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.returnTransaction.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.saleItem.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.sale.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.employee.deleteMany({ where: { email: { contains: '@test-an' } } });
            await prisma.product.deleteMany({ where: { name: { contains: 'Test Analytics' } } });
            await prisma.user.deleteMany({ where: { email: { contains: '@test-an' } } });
            await prisma.tenant.deleteMany({ where: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } });

            // Create Tenant 1
            const tenant1 = await prisma.tenant.create({
              data: {
                name: 'Test Analytics Tenant 1',
                subDomain: 'test-an-tenant-1',
              },
            });
            tenant1Id = tenant1.id;

            // Create Tenant 2 (for boundary checks)
            const tenant2 = await prisma.tenant.create({
              data: {
                name: 'Test Analytics Tenant 2',
                subDomain: 'test-an-tenant-2',
              },
            });
            tenant2Id = tenant2.id;

            // Create Manager (BUSINESS_OWNER) for Tenant 1
            const manager = await prisma.user.create({
              data: {
                email: 'manager@test-an-1.com',
                passwordHash: 'hash',
                role: Role.BUSINESS_OWNER,
                firstName: 'Analytics',
                lastName: 'Manager',
                tenantId: tenant1Id,
              },
            });
            manager1Id = manager.id;

            // Create Staff for Tenant 1
            const staff = await prisma.user.create({
              data: {
                email: 'staff@test-an-1.com',
                passwordHash: 'hash',
                role: Role.STAFF,
                firstName: 'Analytics',
                lastName: 'Staff',
                tenantId: tenant1Id,
              },
            });
            staff1Id = staff.id;

            // Generate Tokens
            managerToken = generateAccessToken({
              userId: manager1Id,
              tenantId: tenant1Id,
              role: Role.BUSINESS_OWNER,
            });

            staffToken = generateAccessToken({
              userId: staff1Id,
              tenantId: tenant1Id,
              role: Role.STAFF,
            });

            // Create Employee under Tenant 1 (salary = $3000)
            await prisma.employee.create({
              data: {
                name: 'Staff Member',
                email: 'staff@test-an-1.com',
                salary: 3000,
                department: 'Sales',
                userId: staff1Id,
                tenantId: tenant1Id,
              },
            });

            // Create Products under Tenant 1
            const prodA = await prisma.product.create({
              data: {
                name: 'Test Analytics Item A',
                sku: 'AN-ITEM-A',
                purchasePrice: 10,
                sellingPrice: 25,
                quantity: 100,
                lowStockThreshold: 5,
                tenantId: tenant1Id,
              },
            });
            productAId = prodA.id;

            const prodB = await prisma.product.create({
              data: {
                name: 'Test Analytics Item B',
                sku: 'AN-ITEM-B',
                purchasePrice: 20,
                sellingPrice: 50,
                quantity: 8, // Low stock threshold is 10, so this triggers low stock
                lowStockThreshold: 10,
                tenantId: tenant1Id,
              },
            });
            productBId = prodB.id;

            // Record Sales in Tenant 1
            // Sale 1: 2x Item A ($50 total), 1x Item B ($50 total). Grand total = $100. COGS = $40.
            const sale1 = await prisma.sale.create({
              data: {
                invoiceNo: 'INV-AN-001',
                totalAmount: 100,
                grandTotal: 100,
                paymentMethod: 'CASH',
                paymentStatus: 'PAID',
                amountPaid: 100,
                userId: manager1Id,
                tenantId: tenant1Id,
              },
            });

            await prisma.saleItem.create({
              data: {
                saleId: sale1.id,
                productId: productAId,
                quantity: 2,
                unitPrice: 25,
                totalPrice: 50,
                tenantId: tenant1Id,
              },
            });

            await prisma.saleItem.create({
              data: {
                saleId: sale1.id,
                productId: productBId,
                quantity: 1,
                unitPrice: 50,
                totalPrice: 50,
                tenantId: tenant1Id,
              },
            });

            // Sale 2: 1x Item A ($25 total). Grand total = $25. COGS = $10.
            const sale2 = await prisma.sale.create({
              data: {
                invoiceNo: 'INV-AN-002',
                totalAmount: 25,
                grandTotal: 25,
                paymentMethod: 'CARD',
                paymentStatus: 'PAID',
                amountPaid: 25,
                userId: manager1Id,
                tenantId: tenant1Id,
              },
            });

            await prisma.saleItem.create({
              data: {
                saleId: sale2.id,
                productId: productAId,
                quantity: 1,
                unitPrice: 25,
                totalPrice: 25,
                tenantId: tenant1Id,
              },
            });

            // Return Transaction in Tenant 1: Return 1x Item A ($25 refund). COGS restoration = $10.
            const returnTx = await prisma.returnTransaction.create({
              data: {
                saleId: sale2.id,
                reason: 'Customer return',
                refundAmount: 25,
                tenantId: tenant1Id,
              },
            });

            await prisma.returnItem.create({
              data: {
                returnId: returnTx.id,
                productId: productAId,
                quantity: 1,
                unitPrice: 25,
                tenantId: tenant1Id,
              },
            });

            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      tenantStore.run(
        { tenantId: 'bypass', userId: 'analytics-test-setup', role: 'SUPER_ADMIN' },
        async () => {
          try {
            await prisma.returnItem.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.returnTransaction.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.saleItem.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.sale.deleteMany({ where: { tenant: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } } });
            await prisma.employee.deleteMany({ where: { email: { contains: '@test-an' } } });
            await prisma.product.deleteMany({ where: { name: { contains: 'Test Analytics' } } });
            await prisma.user.deleteMany({ where: { email: { contains: '@test-an' } } });
            await prisma.tenant.deleteMany({ where: { subDomain: { in: ['test-an-tenant-1', 'test-an-tenant-2'] } } });
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  describe('Authorization Rules', () => {
    test('Staff is Forbidden (403) from accessing dashboard-summary', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/dashboard-summary')
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(403);
    });

    test('Manager is permitted (200) to access analytics summaries', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/dashboard-summary')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
    });
  });

  describe('Analytical Database Core Computations', () => {
    test('Dashboard Summary returns accurate calculations', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/dashboard-summary')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      
      // Math:
      // Gross sales = $100 (sale 1) + $25 (sale 2) = $125
      // Returns = $25
      // Net Revenue = $125 - $25 = $100
      expect(res.body.revenue).toBe(100);

      // COGS:
      // Sale 1 items: 2x Item A ($20) + 1x Item B ($20) = $40
      // Sale 2 items: 1x Item A ($10)
      // Returns items: 1x Item A ($10)
      // Net COGS = $40 + $10 - $10 = $40
      // Net Gross Profit = Net Revenue ($100) - Net COGS ($40) = $60
      expect(res.body.profit).toBe(60);

      // Total products count = 2
      expect(res.body.productsCount).toBe(2);

      // Low stock alerts count = 1 (Item B has quantity 8, threshold 10)
      expect(res.body.lowStockAlerts).toBe(1);
    });

    test('Revenue Chart groups sales figures correctly into calendar months', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/revenue-chart')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(12); // All 12 calendar months represented

      const currentMonthIndex = new Date().getMonth();
      const currentMonthData = res.body[currentMonthIndex];
      expect(currentMonthData.revenue).toBe(100);
      expect(currentMonthData.profit).toBe(60);
    });

    test('Profit & Loss statement computes structural net income including payroll', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/profit-loss')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.revenue.grossSales).toBe(125);
      expect(res.body.revenue.returns).toBe(25);
      expect(res.body.revenue.netSales).toBe(100);

      expect(res.body.cogs.salesCogs).toBe(50);
      expect(res.body.cogs.returnCogs).toBe(10);
      expect(res.body.cogs.netCogs).toBe(40);

      expect(res.body.grossProfit).toBe(60);
      expect(res.body.expenses.salaries).toBe(3000); // active employee salary expense

      // Net Income = Gross Profit ($60) - Salaries ($3000) = -$2940
      expect(res.body.netIncome).toBe(-2940);
    });

    test('Top Selling Products endpoint lists products ordered by sales volume', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/top-products?limit=5')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      // Math:
      // Item A sold quantity = 2 (sale 1) + 1 (sale 2) = 3
      // Item B sold quantity = 1 (sale 1) = 1
      // Item A is top-selling
      expect(res.body[0].sku).toBe('AN-ITEM-A');
      expect(res.body[0].quantitySold).toBe(3);
      expect(res.body[0].totalRevenue).toBe(75); // 3 * 25

      expect(res.body[1].sku).toBe('AN-ITEM-B');
      expect(res.body[1].quantitySold).toBe(1);
    });
  });

  describe('Multi-Tenant Boundary Safeguards', () => {
    test('Managers of other tenants do not see or leak Tenant 1 analytics', async () => {
      // Let's create a manager for Tenant 2 and run queries
      let tenant2ManagerToken: string;

      await new Promise<void>((resolve, reject) => {
        tenantStore.run(
          { tenantId: 'bypass', userId: 'setup', role: 'SUPER_ADMIN' },
          async () => {
            try {
              const manager2 = await prisma.user.create({
                data: {
                  email: 'manager@test-an-2.com',
                  passwordHash: 'hash',
                  role: Role.BUSINESS_OWNER,
                  firstName: 'Tenant2',
                  lastName: 'Manager',
                  tenantId: tenant2Id,
                },
              });
              
              tenant2ManagerToken = generateAccessToken({
                userId: manager2.id,
                tenantId: tenant2Id,
                role: Role.BUSINESS_OWNER,
              });

              resolve();
            } catch (err) {
              reject(err);
            }
          }
        );
      });

      const res = await request(app)
        .get('/api/v1/analytics/dashboard-summary')
        .set('Authorization', `Bearer ${tenant2ManagerToken!}`);

      expect(res.status).toBe(200);
      // Tenant 2 has no sales, no products, no low stock
      expect(res.body.revenue).toBe(0);
      expect(res.body.profit).toBe(0);
      expect(res.body.productsCount).toBe(0);
      expect(res.body.lowStockAlerts).toBe(0);
    });
  });
});
