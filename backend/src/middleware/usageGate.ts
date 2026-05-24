import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

const PLAN_LIMITS = {
  FREE: {
    maxProducts: 50,
    maxSalesPerMonth: 100,
  },
  PRO: {
    maxProducts: 500,
    maxSalesPerMonth: 2000,
  },
  ENTERPRISE: {
    maxProducts: 100000,
    maxSalesPerMonth: 1000000,
  },
};

export async function checkProductLimit(_req: Request, res: Response, next: NextFunction) {
  const context = tenantStore.getStore();
  if (!context || !context.tenantId) {
    return res.status(401).json({ error: 'Tenant context required' });
  }

  try {
    // 1. Fetch tenant plan details
    const tenant = await prisma.tenant.findUnique({
      where: { id: context.tenantId },
      select: { plan: true },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const planLimits = PLAN_LIMITS[tenant.plan];
    
    // 2. Count current products
    const productCount = await prisma.product.count();

    if (productCount >= planLimits.maxProducts) {
      logger.warn({ tenantId: context.tenantId, plan: tenant.plan, productCount }, 'Product limit exceeded for plan');
      return res.status(403).json({
        error: `Limit exceeded. Your plan (${tenant.plan}) allows a maximum of ${planLimits.maxProducts} products. Please upgrade to add more.`,
      });
    }

    return next();
  } catch (error) {
    logger.error({ error }, 'Failed to check product plan limits');
    return next();
  }
}

export async function checkSaleLimit(_req: Request, res: Response, next: NextFunction) {
  const context = tenantStore.getStore();
  if (!context || !context.tenantId) {
    return res.status(401).json({ error: 'Tenant context required' });
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: context.tenantId },
      select: { plan: true },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const planLimits = PLAN_LIMITS[tenant.plan];

    // Count sales for the current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const saleCount = await prisma.sale.count({
      where: {
        createdAt: {
          gte: startOfMonth,
        },
      },
    });

    if (saleCount >= planLimits.maxSalesPerMonth) {
      logger.warn({ tenantId: context.tenantId, plan: tenant.plan, saleCount }, 'Monthly sale limit exceeded for plan');
      return res.status(403).json({
        error: `Monthly checkout limit reached. Your plan (${tenant.plan}) allows up to ${planLimits.maxSalesPerMonth} transactions per month. Please upgrade your subscription.`,
      });
    }

    return next();
  } catch (error) {
    logger.error({ error }, 'Failed to check sale plan limits');
    return next();
  }
}
