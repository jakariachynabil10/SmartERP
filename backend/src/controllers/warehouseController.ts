import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

const warehouseSchema = z.object({
  name: z.string().min(1, 'Warehouse name is required'),
  location: z.string().optional(),
});

export const getWarehouses = async (_req: Request, res: Response) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      orderBy: { name: 'asc' },
    });
    return res.json(warehouses);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch warehouses');
    return res.status(500).json({ error: 'Failed to fetch warehouses.' });
  }
};

export const createWarehouse = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const body = warehouseSchema.parse(req.body);
    const warehouse = await prisma.warehouse.create({
      data: {
        name: body.name,
        location: body.location,
        tenantId: userContext.tenantId,
      },
    });
    return res.status(201).json(warehouse);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create warehouse');
    return res.status(500).json({ error: 'Warehouse name must be unique per tenant.' });
  }
};

export const updateWarehouse = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = warehouseSchema.parse(req.body);
    const warehouse = await prisma.warehouse.update({
      where: { id },
      data: {
        name: body.name,
        location: body.location,
      },
    });
    return res.json(warehouse);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update warehouse');
    return res.status(500).json({ error: 'Failed to update warehouse.' });
  }
};

export const deleteWarehouse = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.warehouse.delete({ where: { id } });
    return res.json({ message: 'Warehouse deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete warehouse');
    return res.status(500).json({ error: 'Failed to delete warehouse.' });
  }
};
