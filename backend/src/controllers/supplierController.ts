import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

// Zod Validation Schemas
const supplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  contactName: z.string().optional().nullable(),
  email: z.string().email('Invalid email').optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});

const purchaseOrderSchema = z.object({
  poNumber: z.string().optional(),
  supplierId: z.string().min(1, 'Supplier is required'),
  warehouseId: z.string().optional(), // Warehouse to receive items into
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.coerce.number().int().positive('Quantity must be positive'),
      unitCost: z.coerce.number().positive('Unit cost must be positive'),
    })
  ).min(1),
});

const poStatusSchema = z.object({
  status: z.enum(['DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED']),
});

const generatePONumber = (): string => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100 + Math.random() * 900);
  return `PO-${dateStr}-${rand}`;
};

// SUPPLIER CRUD
export const getSuppliers = async (_req: Request, res: Response) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' },
    });
    return res.json(suppliers);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch suppliers');
    return res.status(500).json({ error: 'Failed to fetch suppliers.' });
  }
};

export const createSupplier = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = supplierSchema.parse(req.body);
    const emailValue = parsed.email || null;
    const supplier = await prisma.supplier.create({
      data: {
        name: parsed.name,
        contactName: parsed.contactName,
        email: emailValue,
        phone: parsed.phone,
        address: parsed.address,
        tenantId: userContext.tenantId,
      },
    });
    return res.status(201).json(supplier);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create supplier');
    return res.status(500).json({ error: 'Failed to create supplier.' });
  }
};

export const updateSupplier = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const parsed = supplierSchema.partial().parse(req.body);
    const emailValue = parsed.email === '' ? null : parsed.email || undefined;
    const supplier = await prisma.supplier.update({
      where: { id },
      data: {
        name: parsed.name,
        contactName: parsed.contactName,
        email: emailValue,
        phone: parsed.phone,
        address: parsed.address,
      },
    });
    return res.json(supplier);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update supplier');
    return res.status(500).json({ error: 'Failed to update supplier.' });
  }
};

export const deleteSupplier = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.supplier.delete({ where: { id } });
    return res.json({ message: 'Supplier deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete supplier');
    return res.status(500).json({ error: 'Failed to delete supplier.' });
  }
};

// PROCUREMENT (PURCHASE ORDERS)
export const getPurchaseOrders = async (_req: Request, res: Response) => {
  try {
    const pos = await prisma.purchaseOrder.findMany({
      include: {
        supplier: true,
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(pos);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch purchase orders');
    return res.status(500).json({ error: 'Failed to fetch purchase orders.' });
  }
};

export const createPurchaseOrder = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = purchaseOrderSchema.parse(req.body);
    const poNumber = body.poNumber || generatePONumber();
    const totalAmount = body.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: body.supplierId,
        status: 'DRAFT',
        totalAmount,
        tenantId: userContext.tenantId,
        items: {
          create: body.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            tenantId: userContext.tenantId,
          })),
        },
      },
      include: { items: true },
    });

    return res.status(201).json(po);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create purchase order');
    return res.status(500).json({ error: 'PO number must be unique per tenant.' });
  }
};

export const updatePurchaseOrderStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = poStatusSchema.parse(req.body);

    const updatedPo = await prisma.$transaction(async (tx) => {
      // Fetch PO details
      const po = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!po) throw new Error('Purchase order not found.');
      if (po.status === 'RECEIVED') throw new Error('Purchase order has already been received and closed.');
      if (po.status === 'CANCELLED') throw new Error('Purchase order has been cancelled.');

      // If status is transitioning to RECEIVED, increment inventory levels
      if (body.status === 'RECEIVED') {
        // Fetch first warehouse of the tenant if none is provided
        const warehouse = await tx.warehouse.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!warehouse) throw new Error('No warehouse configured to receive stock.');

        for (const item of po.items) {
          // Update product warehouse quantity mapping
          const pwd = await tx.productWarehouse.findUnique({
            where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouse.id } },
          });

          if (pwd) {
            await tx.productWarehouse.update({
              where: { productId_warehouseId: { productId: item.productId, warehouseId: warehouse.id } },
              data: { quantity: { increment: item.quantity } },
            });
          } else {
            await tx.productWarehouse.create({
              data: { productId: item.productId, warehouseId: warehouse.id, quantity: item.quantity },
            });
          }

          // Update main Product total stock count and cost price
          await tx.product.update({
            where: { id: item.productId },
            data: {
              quantity: { increment: item.quantity },
              purchasePrice: item.unitCost, // Update latest purchase cost
            },
          });

          // Log stock adjustment history
          await tx.stockAdjustment.create({
            data: {
              productId: item.productId,
              warehouseId: warehouse.id,
              quantity: item.quantity,
              type: 'IN',
              reason: `Procurement PO Received - ${po.poNumber}`,
              tenantId: userContext.tenantId,
            },
          });
        }
      }

      // Update PO status
      const updated = await tx.purchaseOrder.update({
        where: { id },
        data: { status: body.status },
        include: { items: true },
      });

      // Audit Log
      await tx.auditLog.create({
        data: {
          userId: userContext.userId,
          action: 'UPDATE_PO_STATUS',
          module: 'PROCUREMENT',
          details: `Purchase Order ${po.poNumber} status updated to ${body.status}`,
          tenantId: userContext.tenantId,
        },
      });

      return updated;
    });

    return res.json(updatedPo);
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update PO status');
    return res.status(400).json({ error: error.message || 'Failed to update PO status.' });
  }
};
