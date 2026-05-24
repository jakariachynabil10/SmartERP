import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

const returnSchema = z.object({
  saleId: z.string().min(1, 'Sale ID is required'),
  reason: z.string().min(1, 'Reason for return is required'),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.coerce.number().int().positive('Returned quantity must be positive'),
      unitPrice: z.coerce.number().nonnegative(),
    })
  ).min(1),
  refundAmount: z.coerce.number().nonnegative(),
  warehouseId: z.string().optional(),
});

export const getReturns = async (_req: Request, res: Response) => {
  try {
    const returns = await prisma.returnTransaction.findMany({
      include: {
        sale: true,
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(returns);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch returns history');
    return res.status(500).json({ error: 'Failed to fetch returns history.' });
  }
};

export const processReturn = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = returnSchema.parse(req.body);

    const returnTransaction = await prisma.$transaction(async (tx) => {
      // 1. Fetch original sale and items
      const sale = await tx.sale.findUnique({
        where: { id: body.saleId },
        include: { items: true },
      });

      if (!sale) {
        throw new Error('Original sale transaction not found.');
      }

      // Check if target warehouse exists, fallback to first warehouse if omitted
      let warehouseId = body.warehouseId;
      if (!warehouseId) {
        const warehouse = await tx.warehouse.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!warehouse) throw new Error('No warehouse configured to restore stock.');
        warehouseId = warehouse.id;
      }

      // 2. Validate return quantities against original sale purchases
      for (const returnItem of body.items) {
        const originalItem = sale.items.find((item) => item.productId === returnItem.productId);
        if (!originalItem) {
          throw new Error(`Product ${returnItem.productId} was not part of original sale ${sale.invoiceNo}.`);
        }

        // Calculate already returned quantity for this product on this sale
        const existingReturns = await tx.returnItem.aggregate({
          where: {
            returnTx: { saleId: sale.id },
            productId: returnItem.productId,
          },
          _sum: { quantity: true },
        });

        const totalReturnedSoFar = existingReturns._sum.quantity || 0;
        if (totalReturnedSoFar + returnItem.quantity > originalItem.quantity) {
          throw new Error(`Cannot return ${returnItem.quantity} units. Max returnable: ${originalItem.quantity - totalReturnedSoFar}. Already returned: ${totalReturnedSoFar}`);
        }
      }

      // 3. Create ReturnTransaction and Items
      const retTx = await tx.returnTransaction.create({
        data: {
          saleId: body.saleId,
          reason: body.reason,
          refundAmount: body.refundAmount,
          tenantId: userContext.tenantId,
          items: {
            create: body.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              tenantId: userContext.tenantId,
            })),
          },
        },
        include: { items: true },
      });

      // 4. Restore stock in warehouse + product count, and log adjustments
      for (const item of body.items) {
        const pwd = await tx.productWarehouse.findUnique({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouseId! } },
        });

        if (pwd) {
          await tx.productWarehouse.update({
            where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouseId! } },
            data: { quantity: { increment: item.quantity } },
          });
        } else {
          await tx.productWarehouse.create({
            data: { productId: item.productId, warehouseId: warehouseId!, quantity: item.quantity },
          });
        }

        await tx.product.update({
          where: { id: item.productId },
          data: { quantity: { increment: item.quantity } },
        });

        await tx.stockAdjustment.create({
          data: {
            productId: item.productId,
            warehouseId: warehouseId!,
            quantity: item.quantity,
            type: 'IN',
            reason: `Refund Stock Return - Sale: ${sale.invoiceNo}`,
            tenantId: userContext.tenantId,
          },
        });
      }

      // 5. Deduct customer loyalty points from refund amount portion if customer exists
      if (sale.customerId) {
        const pointsToDeduct = Math.floor(body.refundAmount / 10);
        if (pointsToDeduct > 0) {
          const customer = await tx.customer.findUnique({ where: { id: sale.customerId } });
          if (customer) {
            const newPoints = Math.max(0, customer.loyaltyPoints - pointsToDeduct);
            await tx.customer.update({
              where: { id: sale.customerId },
              data: { loyaltyPoints: newPoints },
            });
          }
        }
      }

      // 6. Update sale status (PARTIALLY_REFUNDED / REFUNDED)
      // Check total returned vs original items count
      const allReturns = await tx.returnItem.aggregate({
        where: { returnTx: { saleId: sale.id } },
        _sum: { quantity: true },
      });

      const totalItemsReturned = allReturns._sum.quantity || 0;
      const totalOriginalItems = sale.items.reduce((sum, item) => sum + item.quantity, 0);

      const nextStatus = totalItemsReturned >= totalOriginalItems ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await tx.sale.update({
        where: { id: sale.id },
        data: { paymentStatus: nextStatus },
      });

      // 7. Write Audit Log
      await tx.auditLog.create({
        data: {
          userId: userContext.userId,
          action: 'RETURN',
          module: 'POS',
          details: `Processed return on invoice ${sale.invoiceNo}. Refund amount: ${body.refundAmount}`,
          tenantId: userContext.tenantId,
        },
      });

      return retTx;
    });

    return res.status(201).json(returnTransaction);
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Return processing failure');
    return res.status(400).json({ error: error.message || 'Processing return failed.' });
  }
};
