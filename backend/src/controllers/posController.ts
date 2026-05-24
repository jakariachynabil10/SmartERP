import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

// Zod Schemas
const checkoutSchema = z.object({
  invoiceNo: z.string().optional(),
  customerId: z.string().optional().nullable(),
  discount: z.coerce.number().nonnegative().default(0),
  tax: z.coerce.number().nonnegative().default(0),
  paymentMethod: z.string(), // CASH, CARD, MOBILE, SPLIT
  paymentStatus: z.string().default('PAID'),
  amountPaid: z.coerce.number().nonnegative(),
  changeAmount: z.coerce.number().nonnegative().default(0),
  warehouseId: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.coerce.number().int().positive(),
    unitPrice: z.coerce.number().nonnegative(),
  })).min(1),
});

const syncSchema = z.object({
  sales: z.array(z.object({
    invoiceNo: z.string(),
    customerId: z.string().optional().nullable(),
    discount: z.coerce.number().nonnegative().default(0),
    tax: z.coerce.number().nonnegative().default(0),
    paymentMethod: z.string(),
    paymentStatus: z.string().default('PAID'),
    amountPaid: z.coerce.number().nonnegative(),
    changeAmount: z.coerce.number().nonnegative().default(0),
    warehouseId: z.string().optional(),
    items: z.array(z.object({
      productId: z.string(),
      quantity: z.coerce.number().int().positive(),
      unitPrice: z.coerce.number().nonnegative(),
    })).min(1),
    createdAt: z.string(), // ISO string from client
  })),
});

// Helper: Generate Invoice Number
const generateInvoiceNo = (): string => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `INV-${dateStr}-${rand}`;
};

export const checkout = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = checkoutSchema.parse(req.body);
    const invoiceNo = body.invoiceNo || generateInvoiceNo();

    // Determine target warehouse. If none provided, pick the first warehouse for the tenant
    let warehouseId = body.warehouseId;
    if (!warehouseId) {
      const warehouse = await prisma.warehouse.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!warehouse) return res.status(400).json({ error: 'No warehouse configured for this tenant.' });
      warehouseId = warehouse.id;
    }

    const sale = await prisma.$transaction(async (tx) => {
      let subtotal = 0;

      // 1. Validate stock levels for all products
      for (const item of body.items) {
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product) throw new Error(`Product not found: ${item.productId}`);
        
        // Find warehouse stock
        const pWarehouse = await tx.productWarehouse.findUnique({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouseId! } },
        });

        const currentStock = pWarehouse ? pWarehouse.quantity : 0;
        if (currentStock < item.quantity) {
          throw new Error(`Insufficient stock for product '${product.name}' in target warehouse. Available: ${currentStock}, Requested: ${item.quantity}`);
        }

        subtotal += item.quantity * item.unitPrice;
      }

      const totalAmount = subtotal;
      const grandTotal = Math.max(0, totalAmount + body.tax - body.discount);

      // 2. Create the Sale
      const createdSale = await tx.sale.create({
        data: {
          invoiceNo,
          totalAmount,
          discount: body.discount,
          tax: body.tax,
          grandTotal,
          paymentMethod: body.paymentMethod,
          paymentStatus: body.paymentStatus,
          amountPaid: body.amountPaid,
          changeAmount: body.changeAmount,
          customerId: body.customerId || null,
          userId: userContext.userId,
          isOffline: false,
          tenantId: userContext.tenantId,
          items: {
            create: body.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.quantity * item.unitPrice,
              tenantId: userContext.tenantId,
            })),
          },
        },
        include: { items: { include: { product: true } } },
      });

      // 3. Deduct stock and log adjustment for each product
      for (const item of body.items) {
        await tx.productWarehouse.update({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouseId! } },
          data: { quantity: { decrement: item.quantity } },
        });

        await tx.product.update({
          where: { id: item.productId },
          data: { quantity: { decrement: item.quantity } },
        });

        await tx.stockAdjustment.create({
          data: {
            productId: item.productId,
            warehouseId: warehouseId!,
            quantity: -item.quantity,
            type: 'OUT',
            reason: `POS Checkout - ${invoiceNo}`,
            tenantId: userContext.tenantId,
          },
        });
      }

      // 4. Update Customer loyalty points (1 point per $10 spent)
      if (body.customerId) {
        const pointsEarned = Math.floor(grandTotal / 10);
        if (pointsEarned > 0) {
          await tx.customer.update({
            where: { id: body.customerId },
            data: { loyaltyPoints: { increment: pointsEarned } },
          });
        }
      }

      // 5. Create Audit Log
      await tx.auditLog.create({
        data: {
          userId: userContext.userId,
          action: 'CHECKOUT',
          module: 'POS',
          details: `POS transaction successful. Invoice: ${invoiceNo}. Amount: ${grandTotal}`,
          tenantId: userContext.tenantId,
        },
      });

      return createdSale;
    });

    return res.status(201).json(sale);
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Checkout error');
    return res.status(400).json({ error: error.message || 'POS Checkout failed.' });
  }
};

export const syncOfflineSales = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = syncSchema.parse(req.body);
    
    // Fetch default warehouse for tenant
    const defaultWarehouse = await prisma.warehouse.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!defaultWarehouse) return res.status(400).json({ error: 'No default warehouse configured.' });

    const results = [];
    const errors = [];

    // Process transactions sequentially (FIFO) to reconcile inventory authoritative values
    for (const saleData of body.sales) {
      try {
        const warehouseId = saleData.warehouseId || defaultWarehouse.id;

        const result = await prisma.$transaction(async (tx) => {
          // Check if invoice already exists
          const existing = await tx.sale.findUnique({
            where: { invoiceNo_tenantId: { invoiceNo: saleData.invoiceNo, tenantId: userContext.tenantId } },
          });
          if (existing) {
            return { skipped: true, invoiceNo: saleData.invoiceNo, reason: 'Duplicate invoice' };
          }

          let subtotal = 0;
          for (const item of saleData.items) {
            subtotal += item.quantity * item.unitPrice;
          }
          const grandTotal = Math.max(0, subtotal + saleData.tax - saleData.discount);

          // Create the sale (Note: we allow stock to go below zero for offline sales, as transaction already occurred)
          await tx.sale.create({
            data: {
              invoiceNo: saleData.invoiceNo,
              totalAmount: subtotal,
              discount: saleData.discount,
              tax: saleData.tax,
              grandTotal,
              paymentMethod: saleData.paymentMethod,
              paymentStatus: saleData.paymentStatus,
              amountPaid: saleData.amountPaid,
              changeAmount: saleData.changeAmount,
              customerId: saleData.customerId || null,
              userId: userContext.userId,
              isOffline: true,
              tenantId: userContext.tenantId,
              createdAt: new Date(saleData.createdAt),
              items: {
                create: saleData.items.map((item) => ({
                  productId: item.productId,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                  totalPrice: item.quantity * item.unitPrice,
                  tenantId: userContext.tenantId,
                })),
              },
            },
          });

          // Deduct inventory (can result in negative stock if discrepancy exists, requiring manual reconciliation alert)
          for (const item of saleData.items) {
            // Check if mapping exists in warehouse, create if doesn't
            const pwd = await tx.productWarehouse.findUnique({
              where: { productId_warehouseId: { productId: item.productId, warehouseId } },
            });

            if (pwd) {
              await tx.productWarehouse.update({
                where: { productId_warehouseId: { productId: item.productId, warehouseId } },
                data: { quantity: { decrement: item.quantity } },
              });
            } else {
              await tx.productWarehouse.create({
                data: { productId: item.productId, warehouseId, quantity: -item.quantity },
              });
            }

            await tx.product.update({
              where: { id: item.productId },
              data: { quantity: { decrement: item.quantity } },
            });

            await tx.stockAdjustment.create({
              data: {
                productId: item.productId,
                warehouseId,
                quantity: -item.quantity,
                type: 'OUT',
                reason: `Offline Sync - ${saleData.invoiceNo}`,
                tenantId: userContext.tenantId,
              },
            });
          }

          // Loyalty points integration
          if (saleData.customerId) {
            const points = Math.floor(grandTotal / 10);
            if (points > 0) {
              await tx.customer.update({
                where: { id: saleData.customerId },
                data: { loyaltyPoints: { increment: points } },
              });
            }
          }

          return { success: true, invoiceNo: saleData.invoiceNo };
        });

        results.push(result);
      } catch (err: any) {
        logger.error({ err, invoiceNo: saleData.invoiceNo }, 'Offline sale sync item error');
        errors.push({ invoiceNo: saleData.invoiceNo, error: err.message || 'Reconciliation failure' });
      }
    }

    return res.json({
      message: 'Offline POS sync completed.',
      syncedCount: results.filter(r => (r as any).success).length,
      skippedCount: results.filter(r => (r as any).skipped).length,
      failedCount: errors.length,
      details: results,
      errors,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Sync offline sales API failure');
    return res.status(500).json({ error: 'Internal sync error' });
  }
};
