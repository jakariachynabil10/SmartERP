import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

// Zod Schemas
const categorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
});

const productSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  description: z.string().optional(),
  purchasePrice: z.coerce.number().nonnegative(),
  sellingPrice: z.coerce.number().nonnegative(),
  quantity: z.coerce.number().int().default(0),
  lowStockThreshold: z.coerce.number().int().default(10),
  expiryDate: z.string().datetime().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  warehouseId: z.string().optional(), // Initial warehouse assignment
});

const adjustStockSchema = z.object({
  productId: z.string(),
  warehouseId: z.string(),
  quantity: z.coerce.number().int(), // positive to add, negative to subtract
  reason: z.string().optional(),
});

const transferStockSchema = z.object({
  productId: z.string(),
  fromWarehouseId: z.string(),
  toWarehouseId: z.string(),
  quantity: z.coerce.number().int().positive('Quantity must be positive'),
});

// Helper: SKU / Barcode Generator
const generateSKU = (name: string): string => {
  const prefix = name.substring(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'PRD');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${rand}`;
};

// CATEGORIES CONTROLLERS
export const getCategories = async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
    return res.json(categories);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch categories');
    return res.status(500).json({ error: 'Failed to fetch categories.' });
  }
};

export const createCategory = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = categorySchema.parse(req.body);
    const category = await prisma.category.create({
      data: { name: body.name, tenantId: userContext.tenantId },
    });
    return res.status(201).json(category);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create category');
    return res.status(500).json({ error: 'Category name may already exist for this tenant.' });
  }
};

export const updateCategory = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = categorySchema.parse(req.body);
    const category = await prisma.category.update({
      where: { id },
      data: { name: body.name },
    });
    return res.json(category);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update category');
    return res.status(500).json({ error: 'Failed to update category.' });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.category.delete({ where: { id } });
    return res.json({ message: 'Category deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete category');
    return res.status(500).json({ error: 'Failed to delete category.' });
  }
};

// PRODUCTS CONTROLLERS
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { categoryId, search, page = '1', limit = '50' } = req.query;
    const pNum = parseInt(page as string);
    const lNum = parseInt(limit as string);
    const skip = (pNum - 1) * lNum;

    const where: any = {};
    if (categoryId) where.categoryId = categoryId as string;
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { sku: { contains: search as string, mode: 'insensitive' } },
        { barcode: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        skip,
        take: lNum,
        include: { category: true, supplier: true, warehouses: true },
        orderBy: { name: 'asc' },
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({
      products,
      pagination: {
        total,
        pages: Math.ceil(total / lNum),
        page: pNum,
        limit: lNum,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch products');
    return res.status(500).json({ error: 'Failed to fetch products.' });
  }
};

export const createProduct = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = productSchema.parse(req.body);
    const sku = body.sku || generateSKU(body.name);
    const barcode = body.barcode || sku; // Default barcode to SKU if not provided

    const product = await prisma.$transaction(async (tx) => {
      // 1. Create the product
      const prd = await tx.product.create({
        data: {
          name: body.name,
          sku,
          barcode,
          description: body.description,
          purchasePrice: body.purchasePrice,
          sellingPrice: body.sellingPrice,
          quantity: body.quantity,
          lowStockThreshold: body.lowStockThreshold,
          expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          categoryId: body.categoryId || null,
          supplierId: body.supplierId || null,
          tenantId: userContext.tenantId,
        },
      });

      // 2. If a warehouse is assigned, set up initial warehouse stock mapping
      if (body.warehouseId) {
        await tx.productWarehouse.create({
          data: {
            productId: prd.id,
            warehouseId: body.warehouseId,
            quantity: body.quantity,
          },
        });

        // Track stock adjustment history
        await tx.stockAdjustment.create({
          data: {
            productId: prd.id,
            warehouseId: body.warehouseId,
            quantity: body.quantity,
            type: 'IN',
            reason: 'Initial stock intake on creation',
            tenantId: userContext.tenantId,
          },
        });
      }

      return prd;
    });

    return res.status(201).json(product);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create product');
    return res.status(500).json({ error: 'SKU or Barcode must be unique per tenant.' });
  }
};

export const updateProduct = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = productSchema.partial().parse(req.body);
    const updated = await prisma.product.update({
      where: { id },
      data: {
        name: body.name,
        sku: body.sku,
        barcode: body.barcode,
        description: body.description,
        purchasePrice: body.purchasePrice,
        sellingPrice: body.sellingPrice,
        lowStockThreshold: body.lowStockThreshold,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : undefined,
        categoryId: body.categoryId === null ? null : body.categoryId || undefined,
        supplierId: body.supplierId === null ? null : body.supplierId || undefined,
      },
    });
    return res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update product');
    return res.status(500).json({ error: 'Failed to update product.' });
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.product.delete({ where: { id } });
    return res.json({ message: 'Product deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete product');
    return res.status(500).json({ error: 'Failed to delete product.' });
  }
};

// STOCK MANAGEMENT CONTROLLERS
export const adjustStock = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = adjustStockSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch or create product warehouse map
      const pwd = await tx.productWarehouse.findUnique({
        where: {
          productId_warehouseId: { productId: body.productId, warehouseId: body.warehouseId },
        },
      });

      const currentQty = pwd ? pwd.quantity : 0;
      const newQty = currentQty + body.quantity;

      if (newQty < 0) {
        throw new Error('Stock quantity cannot go below 0 in warehouse.');
      }

      await tx.productWarehouse.upsert({
        where: {
          productId_warehouseId: { productId: body.productId, warehouseId: body.warehouseId },
        },
        create: {
          productId: body.productId,
          warehouseId: body.warehouseId,
          quantity: body.quantity,
        },
        update: {
          quantity: newQty,
        },
      });

      // 2. Adjust total product quantity count
      const product = await tx.product.update({
        where: { id: body.productId },
        data: {
          quantity: {
            increment: body.quantity,
          },
        },
      });

      // 3. Log stock adjustment history
      await tx.stockAdjustment.create({
        data: {
          productId: body.productId,
          warehouseId: body.warehouseId,
          quantity: body.quantity,
          type: body.quantity >= 0 ? 'IN' : 'OUT',
          reason: body.reason || 'Manual adjustment',
          tenantId: userContext.tenantId,
        },
      });

      return product;
    });

    return res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to adjust stock');
    return res.status(400).json({ error: error.message || 'Failed to adjust stock.' });
  }
};

export const transferStock = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = transferStockSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      // Check fromWarehouse stock
      const fromPwd = await tx.productWarehouse.findUnique({
        where: {
          productId_warehouseId: { productId: body.productId, warehouseId: body.fromWarehouseId },
        },
      });

      if (!fromPwd || fromPwd.quantity < body.quantity) {
        throw new Error('Insufficient stock in source warehouse.');
      }

      // Deduct from source
      await tx.productWarehouse.update({
        where: {
          productId_warehouseId: { productId: body.productId, warehouseId: body.fromWarehouseId },
        },
        data: { quantity: { decrement: body.quantity } },
      });

      // Add to destination
      const toPwd = await tx.productWarehouse.findUnique({
        where: {
          productId_warehouseId: { productId: body.productId, warehouseId: body.toWarehouseId },
        },
      });

      if (toPwd) {
        await tx.productWarehouse.update({
          where: {
            productId_warehouseId: { productId: body.productId, warehouseId: body.toWarehouseId },
          },
          data: { quantity: { increment: body.quantity } },
        });
      } else {
        await tx.productWarehouse.create({
          data: {
            productId: body.productId,
            warehouseId: body.toWarehouseId,
            quantity: body.quantity,
          },
        });
      }

      // Track transfer
      const transfer = await tx.stockTransfer.create({
        data: {
          productId: body.productId,
          fromWarehouseId: body.fromWarehouseId,
          toWarehouseId: body.toWarehouseId,
          quantity: body.quantity,
          status: 'COMPLETED',
          tenantId: userContext.tenantId,
        },
      });

      // Log adjustments
      await tx.stockAdjustment.create({
        data: {
          productId: body.productId,
          warehouseId: body.fromWarehouseId,
          quantity: -body.quantity,
          type: 'TRANSFER',
          reason: `Stock transfer to warehouse ${body.toWarehouseId}`,
          tenantId: userContext.tenantId,
        },
      });

      await tx.stockAdjustment.create({
        data: {
          productId: body.productId,
          warehouseId: body.toWarehouseId,
          quantity: body.quantity,
          type: 'TRANSFER',
          reason: `Stock transfer from warehouse ${body.fromWarehouseId}`,
          tenantId: userContext.tenantId,
        },
      });

      return transfer;
    });

    return res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to transfer stock');
    return res.status(400).json({ error: error.message || 'Failed to transfer stock.' });
  }
};

export const getLowStockAlerts = async (_req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        quantity: {
          lte: prisma.product.fields.lowStockThreshold,
        },
      },
      include: { category: true },
      orderBy: { quantity: 'asc' },
    });
    return res.json(products);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch low stock alerts');
    return res.status(500).json({ error: 'Failed to fetch low stock alerts.' });
  }
};
