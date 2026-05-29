import { Request, Response } from 'express';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

// Helper: Calculate net COGS for a specific date range
const calculateNetCogs = async (startDate?: Date, endDate?: Date) => {
  const saleWhere: any = {};
  const returnWhere: any = {};

  if (startDate || endDate) {
    const dateRange: any = {};
    if (startDate) dateRange.gte = startDate;
    if (endDate) dateRange.lte = endDate;

    saleWhere.sale = { createdAt: dateRange };
    returnWhere.returnTx = { createdAt: dateRange };
  }

  // Fetch sale items and retrieve the purchase price of the products
  const saleItems = await prisma.saleItem.findMany({
    where: saleWhere,
    include: {
      product: {
        select: { purchasePrice: true },
      },
    },
  });

  // Fetch return items (no direct relation to product exists in schema)
  const returnItems = await prisma.returnItem.findMany({
    where: returnWhere,
  });

  const returnProductIds = returnItems.map((item) => item.productId);

  const returnProducts = await prisma.product.findMany({
    where: {
      id: { in: returnProductIds },
    },
    select: {
      id: true,
      purchasePrice: true,
    },
  });

  const grossCogs = saleItems.reduce((acc, item) => {
    const cost = item.product?.purchasePrice ?? 0;
    return acc + (item.quantity * cost);
  }, 0);

  const returnedCogs = returnItems.reduce((acc, item) => {
    const prod = returnProducts.find((p) => p.id === item.productId);
    const cost = prod?.purchasePrice ?? 0;
    return acc + (item.quantity * cost);
  }, 0);

  return {
    salesCogs: grossCogs,
    returnCogs: returnedCogs,
    netCogs: grossCogs - returnedCogs,
  };
};

// ---------------------------------------------------------
// Analytics Controllers
// ---------------------------------------------------------

/**
 * GET /api/v1/analytics/dashboard-summary
 * Returns top-level KPIs: Total Revenue, Gross Profit, Total Products, and Low Stock Alerts
 */
export const getDashboardSummary = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { startDate, endDate } = req.query;
    
    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate as string);
    if (endDate) end = new Date(endDate as string);

    // 1. Calculate Net Revenue (Sales minus Returns)
    const saleWhere: any = {};
    const returnWhere: any = {};
    if (start || end) {
      const range: any = {};
      if (start) range.gte = start;
      if (end) range.lte = end;
      saleWhere.createdAt = range;
      returnWhere.createdAt = range;
    }

    const salesSum = await prisma.sale.aggregate({
      where: saleWhere,
      _sum: { grandTotal: true },
    });

    const returnsSum = await prisma.returnTransaction.aggregate({
      where: returnWhere,
      _sum: { refundAmount: true },
    });

    const grossRevenue = salesSum._sum.grandTotal ?? 0;
    const refunds = returnsSum._sum.refundAmount ?? 0;
    const netRevenue = grossRevenue - refunds;

    // 2. Calculate Gross Profit (Net Revenue minus Net COGS)
    const cogsData = await calculateNetCogs(start, end);
    const grossProfit = netRevenue - cogsData.netCogs;

    // 3. Count Active Products
    const productsCount = await prisma.product.count();

    // 4. Count Low Stock items
    const lowStockAlerts = await prisma.product.count({
      where: {
        quantity: {
          lte: prisma.product.fields.lowStockThreshold,
        },
      },
    });

    return res.json({
      revenue: Math.round(netRevenue * 100) / 100,
      profit: Math.round(grossProfit * 100) / 100,
      productsCount,
      lowStockAlerts,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch dashboard summary');
    return res.status(500).json({ error: 'Failed to fetch dashboard summary.' });
  }
};

/**
 * GET /api/v1/analytics/revenue-chart
 * Returns monthly revenue and profit groupings for the current calendar year
 */
export const getRevenueChart = async (_req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear, 11, 31, 23, 59, 59, 999);

    // Fetch all sales for this year
    const sales = await prisma.sale.findMany({
      where: {
        createdAt: {
          gte: startOfYear,
          lte: endOfYear,
        },
      },
      include: {
        items: {
          include: {
            product: {
              select: { purchasePrice: true },
            },
          },
        },
      },
    });

    // Fetch all returns for this year
    const returns = await prisma.returnTransaction.findMany({
      where: {
        createdAt: {
          gte: startOfYear,
          lte: endOfYear,
        },
      },
      include: {
        items: true,
      },
    });

    // Fetch all return product details since ReturnItem doesn't have a direct product relation in the schema
    const returnItemProductIds: string[] = [];
    for (const ret of returns) {
      for (const item of ret.items) {
        returnItemProductIds.push(item.productId);
      }
    }

    const returnProducts = await prisma.product.findMany({
      where: {
        id: { in: returnItemProductIds },
      },
      select: {
        id: true,
        purchasePrice: true,
      },
    });

    // Seed the 12 months structure
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyData = months.map((name) => ({
      name,
      revenue: 0,
      profit: 0,
    }));

    // Process Sales
    for (const sale of sales) {
      const monthIndex = new Date(sale.createdAt).getMonth();
      monthlyData[monthIndex].revenue += sale.grandTotal;

      let saleCogs = 0;
      for (const item of sale.items) {
        const cost = item.product?.purchasePrice ?? 0;
        saleCogs += item.quantity * cost;
      }
      monthlyData[monthIndex].profit += (sale.grandTotal - saleCogs);
    }

    // Process Returns
    for (const ret of returns) {
      const monthIndex = new Date(ret.createdAt).getMonth();
      monthlyData[monthIndex].revenue -= ret.refundAmount;

      let returnCogs = 0;
      for (const item of ret.items) {
        const prod = returnProducts.find((p) => p.id === item.productId);
        const cost = prod?.purchasePrice ?? 0;
        returnCogs += item.quantity * cost;
      }
      monthlyData[monthIndex].profit -= (ret.refundAmount - returnCogs);
    }

    // Round values
    const formattedData = monthlyData.map((d) => ({
      name: d.name,
      revenue: Math.round(d.revenue * 100) / 100,
      profit: Math.round(d.profit * 100) / 100,
    }));

    return res.json(formattedData);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch revenue chart data');
    return res.status(500).json({ error: 'Failed to fetch revenue chart data.' });
  }
};

/**
 * GET /api/v1/analytics/profit-loss
 * Returns a structured P&L statement incorporating Net Sales, Net COGS, payroll/salaries, and Net Income
 */
export const getProfitLoss = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { startDate, endDate } = req.query;

    let start: Date | undefined;
    let end: Date | undefined;
    if (startDate) start = new Date(startDate as string);
    if (endDate) end = new Date(endDate as string);

    // 1. Sales & Revenue
    const saleWhere: any = {};
    const returnWhere: any = {};
    if (start || end) {
      const range: any = {};
      if (start) range.gte = start;
      if (end) range.lte = end;
      saleWhere.createdAt = range;
      returnWhere.createdAt = range;
    }

    const salesSum = await prisma.sale.aggregate({
      where: saleWhere,
      _sum: { grandTotal: true },
    });

    const returnsSum = await prisma.returnTransaction.aggregate({
      where: returnWhere,
      _sum: { refundAmount: true },
    });

    const grossSales = salesSum._sum.grandTotal ?? 0;
    const refunds = returnsSum._sum.refundAmount ?? 0;
    const netSales = grossSales - refunds;

    // 2. Cost of Goods Sold
    const cogsData = await calculateNetCogs(start, end);

    // 3. Gross Profit
    const grossProfit = netSales - cogsData.netCogs;

    // 4. Operating Expenses: Payroll / Active Employee Salaries sum
    const salariesSum = await prisma.employee.aggregate({
      _sum: { salary: true },
    });
    const payrollExpenses = salariesSum._sum.salary ?? 0;

    // 5. Net Income
    const netIncome = grossProfit - payrollExpenses;

    return res.json({
      revenue: {
        grossSales: Math.round(grossSales * 100) / 100,
        returns: Math.round(refunds * 100) / 100,
        netSales: Math.round(netSales * 100) / 100,
      },
      cogs: {
        salesCogs: Math.round(cogsData.salesCogs * 100) / 100,
        returnCogs: Math.round(cogsData.returnCogs * 100) / 100,
        netCogs: Math.round(cogsData.netCogs * 100) / 100,
      },
      grossProfit: Math.round(grossProfit * 100) / 100,
      expenses: {
        salaries: Math.round(payrollExpenses * 100) / 100,
        totalExpenses: Math.round(payrollExpenses * 100) / 100,
      },
      netIncome: Math.round(netIncome * 100) / 100,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to generate profit and loss statement');
    return res.status(500).json({ error: 'Failed to generate profit and loss statement.' });
  }
};

/**
 * GET /api/v1/analytics/top-products
 * Returns the highest selling products by quantity and revenue
 */
export const getTopProducts = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { limit = '5' } = req.query;
    const limitNum = parseInt(limit as string);

    // Group sales items by productId
    const itemsGroup = await prisma.saleItem.groupBy({
      by: ['productId'],
      _sum: {
        quantity: true,
        totalPrice: true,
      },
      orderBy: {
        _sum: {
          quantity: 'desc',
        },
      },
      take: limitNum,
    });

    const productIds = itemsGroup.map((item) => item.productId);

    // Fetch product details for these IDs
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
      },
      select: {
        id: true,
        name: true,
        sku: true,
      },
    });

    const result = itemsGroup.map((item) => {
      const prod = products.find((p) => p.id === item.productId);
      return {
        productId: item.productId,
        name: prod?.name ?? 'Unknown Product',
        sku: prod?.sku ?? 'N/A',
        quantitySold: item._sum.quantity ?? 0,
        totalRevenue: Math.round((item._sum.totalPrice ?? 0) * 100) / 100,
      };
    });

    return res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch top products');
    return res.status(500).json({ error: 'Failed to fetch top products.' });
  }
};
